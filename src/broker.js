/** Kite v3 adapter. REST requests are serialized; mutations are never retried. */
import {Worker} from 'node:worker_threads';
import {Mutex, monotonic, sleep, parseTime, isoIST} from './util.js';

const SECRET_FIELDS = new Set(['access_token', 'api_key', 'api_secret', 'request_token', 'password', 'enctoken']);
const REJECTION_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422, 428, 429]);
const REJECTION_KINDS = new Set(['InputException', 'PermissionException', 'TokenException']);
const CLOCK_TOLERANCE_MS = 10000, CLOCK_DATE_PRECISION_MS = 1000, CLOCK_MAX_AGE_SECONDS = 60;

export function jsonable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_FIELDS.has(key.toLowerCase())).map(([key, item]) => [key, jsonable(item)]));
  return value;
}

export class BrokerError extends Error {
  constructor(kind, detail = '', {http_status = null, auth_required = false, definitive_rejection = false} = {}) {
    super(`Zerodha request failed (${kind}). Check account activity and reconnect if needed.`);
    this.name = 'BrokerError';
    this.kind = kind;
    this.detail = detail;
    this.http_status = Number.isInteger(http_status) && http_status >= 100 && http_status <= 599 ? http_status : null;
    this.auth_required = this.http_status === 428 && auth_required === true;
    this.definitive_rejection = definitive_rejection === true && REJECTION_STATUSES.has(this.http_status) && REJECTION_KINDS.has(kind);
  }
}

/** RFC 4180 CSV reader: the instruments endpoint is CSV, including quoted company names. */
export function parseInstruments(csv) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(field); field = '';
      if (char !== ',') {
        if (row.some(value => value.length)) rows.push(row);
        row = [];
        if (char === '\r' && csv[i + 1] === '\n') i++;
      }
    } else field += char;
  }
  if (quoted) throw new Error('Malformed instrument CSV');
  if (field || row.length) { row.push(field); rows.push(row); }
  const columns = rows.shift()?.map(value => value.replace(/^\uFEFF/, '').trim()) || [];
  if (!columns.includes('instrument_token') || !columns.includes('tradingsymbol')) throw new Error('Invalid instrument CSV columns');
  const numbers = new Set(['instrument_token', 'exchange_token', 'last_price', 'strike', 'tick_size', 'lot_size']);
  return rows.map(values => Object.fromEntries(columns.map((key, index) => {
    const raw = values[index] ?? '';
    return [key, numbers.has(key) ? Number(raw || 0) : raw];
  })));
}

function apiDate(value) {
  const date = parseTime(value);
  if (!date) throw new TypeError('Invalid historical date');
  // Kite expects exchange-local timestamps, independent of the operating system's timezone.
  return isoIST(date).slice(0, 19).replace('T', ' ');
}
function pathPart(value) {
  if (value === null || value === undefined || String(value) === '') throw new TypeError('Missing broker resource identifier');
  return encodeURIComponent(String(value));
}
function formBody(values) {
  // Some Kite endpoints use repeated field names rather than a JSON array.
  if (values instanceof URLSearchParams) return new URLSearchParams(values);
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, typeof value === 'boolean' ? String(Number(value)) : String(value)]));
}

export class KiteBroker {
  constructor(api_key, access_token, options = {}) {
    this.api_key = api_key;
    this.access_token = access_token;
    this._rest_lock = new Mutex();
    this._last_call = -Infinity;
    this._last_quote = -Infinity;
    this.sockets = [];
    this._streamSlots = new Set(); this._retiringSockets = new Set();
    this._streamLifecycle = new Mutex();
    this._generation = 0;
    this._fetch = options.fetch ?? globalThis.fetch;
    this._clock = options.clock ?? monotonic;
    this._wallClock = options.wallClock ?? Date.now;
    this._clock_observation = null; this._clock_skew = null; this._clock_observation_status = null;
    this._sleep = options.sleep ?? sleep;
    this._workerFactory = options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions));
  }

  _observe_clock(response, startedWall, startedMono) {
    const receivedWall = Number(this._wallClock()), receivedMono = this._clock();
    const duration = (receivedMono - startedMono) * 1000;
    if (![startedWall, startedMono, receivedWall, receivedMono, duration, new Date(receivedWall).getTime()].every(Number.isFinite) || duration < 0 ||
        Math.abs(receivedWall - startedWall - duration) > CLOCK_DATE_PRECISION_MS) {
      this._clock_observation_status = 'wall_clock_changed'; return;
    }
    const header = response.headers?.get?.('date');
    if (!header) { this._clock_observation_status = 'missing_date'; return; }
    const server = typeof header === 'string' ? Date.parse(header) : NaN;
    if (!Number.isFinite(server) || new Date(server).toUTCString() !== header) {
      this._clock_observation_status = 'invalid_date'; return;
    }
    // The Date can have been generated anywhere during this request. Widen
    // both ends for its one-second precision; never adjust the host clock.
    const lower = server - receivedWall - CLOCK_DATE_PRECISION_MS;
    const upper = server - startedWall + CLOCK_DATE_PRECISION_MS;
    const status = lower > CLOCK_TOLERANCE_MS || upper < -CLOCK_TOLERANCE_MS ? 'skewed' :
      lower >= -CLOCK_TOLERANCE_MS && upper <= CLOCK_TOLERANCE_MS ? 'aligned' : 'uncertain';
    const observation = { status, offset_lower_ms: lower, offset_upper_ms: upper,
      request_duration_ms: duration, received_wall: receivedWall, received_mono: receivedMono };
    this._clock_observation = observation; this._clock_observation_status = 'valid';
    if (status === 'skewed') this._clock_skew = observation;
    // Missing headers, ambiguous latency and age cannot clear proven skew.
    else if (status === 'aligned') this._clock_skew = null;
  }

  clock_health() {
    const observation = this._clock_skew || this._clock_observation;
    const elapsed = observation ? this._clock() - observation.received_mono : null;
    const wall = Number(this._wallClock());
    const age = elapsed !== null && Number.isFinite(elapsed) ? Math.max(0, elapsed) : null;
    const stale = !!observation && (age === null || elapsed < 0 || age > CLOCK_MAX_AGE_SECONDS);
    const wallChanged = !!observation && (!Number.isFinite(wall) || age === null ||
      Math.abs(wall - observation.received_wall - elapsed * 1000) > CLOCK_DATE_PRECISION_MS);
    const last = wallChanged ? 'wall_clock_changed' : this._clock_observation_status;
    const blocked = !!this._clock_skew;
    const status = blocked ? 'skewed' : !observation ? last === 'wall_clock_changed' ? 'uncertain' : 'unknown' :
      stale || last !== 'valid' ? 'uncertain' : observation.status;
    return { status, blocked, source: 'kite_https_date', offset_lower_ms: observation?.offset_lower_ms ?? null,
      offset_upper_ms: observation?.offset_upper_ms ?? null, age_seconds: age, stale,
      max_age_seconds: CLOCK_MAX_AGE_SECONDS, tolerance_ms: CLOCK_TOLERANCE_MS,
      request_duration_ms: observation?.request_duration_ms ?? null,
      observed_at: observation ? new Date(observation.received_wall).toISOString() : null,
      last_observation_status: last };
  }

  async call(method, ...args) {
    return this._rest_lock.run(async () => {
      await this._sleep(Math.max(0, 0.36 - (this._clock() - this._last_call)) * 1000);
      if (method === 'quote') {
        await this._sleep(Math.max(0, 1.05 - (this._clock() - this._last_quote)) * 1000);
        this._last_quote = this._clock();
      }
      this._last_call = this._clock();
      try { return await this._call(method, args); }
      catch (error) {
        let detail = String(error.detail || error.message || 'Broker request failed');
        for (const secret of [this.api_key, this.access_token]) if (secret) detail = detail.split(secret).join('[redacted]');
        detail = detail.replace(/https?:\/\/\S+/g, '[broker endpoint]').slice(0, 500);
        // Only code-like names reach logs; broker error text can contain private information.
        const rawKind = error.kind || error.name || 'Error';
        const kind = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rawKind) ? rawKind : 'BrokerException';
        throw new BrokerError(kind, detail, error instanceof BrokerError ? {
          http_status: error.http_status, auth_required: error.auth_required, definitive_rejection: error.definitive_rejection,
        } : {});
      }
    });
  }

  async _call(method, args) {
    let path, verb = 'GET', payload = null, transform = value => value;
    const plain = value => value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
    const kwargs = plain(args.at(-1)) ? {...args.at(-1)} : {};
    const simple = {profile: '/user/profile', margins: '/user/margins', holdings: '/portfolio/holdings',
      positions: '/portfolio/positions', orders: '/orders', trades: '/trades', get_gtts: '/gtt/triggers'};
    if (method in simple) {
      path = simple[method];
      if (method === 'margins' && args[0] && !plain(args[0])) path += `/${pathPart(args[0])}`;
    } else if (method === 'authorise_holdings') {
      // Scope authorisation to explicitly selected holdings. Omitting the list
      // at the broker would instead present the account's entire holdings.
      const instruments = kwargs.instruments;
      if (args.length !== 1 || !plain(args[0]) || Object.keys(kwargs).some(key => key !== 'instruments') ||
          !Array.isArray(instruments) || !instruments.length || instruments.length > 100) {
        throw new TypeError('Holdings authorisation requires 1 to 100 ISIN/quantity pairs');
      }
      payload = new URLSearchParams();
      const seen = new Set();
      for (const instrument of instruments) {
        if (!plain(instrument) || Object.keys(instrument).some(key => !['isin', 'quantity'].includes(key)) ||
            typeof instrument.isin !== 'string' || !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(instrument.isin) ||
            !Number.isSafeInteger(instrument.quantity) || instrument.quantity <= 0 || seen.has(instrument.isin)) {
          throw new TypeError('Holdings authorisation requires unique valid ISINs and positive integer quantities');
        }
        seen.add(instrument.isin);
        payload.append('isin', instrument.isin);
        payload.append('quantity', String(instrument.quantity));
      }
      path = '/portfolio/holdings/authorise';
      verb = 'POST';
      transform = data => {
        const requestId = data?.request_id;
        if (typeof requestId !== 'string' || !requestId.length || requestId.length > 512 || requestId.trim() !== requestId || /[\u0000-\u001f\u007f]/.test(requestId)) {
          throw new Error('Broker response has no valid holdings authorisation request ID');
        }
        // This starts the official user authorisation flow; it is not a sale or
        // proof of authorisation. TPIN and OTP stay on the broker/depository site.
        return {request_id: requestId};
      };
    } else if (method === 'instruments') {
      path = '/instruments' + (args[0] ? `/${pathPart(args[0])}` : '');
      transform = parseInstruments;
    } else if (method === 'quote') {
      const instruments = Array.isArray(args[0]) ? args[0] : args;
      if (!instruments.length || instruments.length > 500 || instruments.some(value => typeof value !== 'string')) throw new TypeError('Quotes require 1 to 500 instrument symbols');
      path = '/quote?' + new URLSearchParams(instruments.map(symbol => ['i', symbol])).toString();
    } else if (method === 'historical_data') {
      const [token, from, to, interval] = args;
      path = `/instruments/historical/${pathPart(token)}/${pathPart(interval)}?` + formBody({
        from: apiDate(from), to: apiDate(to), continuous: Number(Boolean(kwargs.continuous)), oi: Number(Boolean(kwargs.oi)),
      });
      transform = data => {
        if (!Array.isArray(data?.candles)) throw new Error('Invalid historical candles response');
        return data.candles.map(row => {
          const date = parseTime(row[0]);
          if (!date) throw new Error('Invalid historical candle date');
          const record = {date, open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5]};
          if (row.length > 6) record.oi = row[6];
          return record;
        });
      };
    } else if (method === 'order_history' || method === 'order_trades') {
      path = `/orders/${pathPart(args[0])}` + (method === 'order_trades' ? '/trades' : '');
    } else if (['place_order', 'cancel_order', 'modify_order'].includes(method)) {
      const variety = kwargs.variety ?? (!plain(args[0]) ? args[0] : undefined);
      const orderId = kwargs.order_id ?? (!plain(args[1]) ? args[1] : undefined);
      path = `/orders/${pathPart(variety)}`;
      payload = {...kwargs};
      delete payload.variety; delete payload.order_id;
      if (method === 'place_order') verb = 'POST';
      else {
        path += `/${pathPart(orderId)}`;
        verb = method === 'cancel_order' ? 'DELETE' : 'PUT';
      }
      transform = data => {
        if (!data?.order_id) throw new Error('Broker response has no order ID; reconcile account before retrying');
        return String(data.order_id);
      };
    } else if (['get_gtt', 'delete_gtt'].includes(method)) {
      path = `/gtt/triggers/${pathPart(args[0])}`;
      if (method === 'delete_gtt') verb = 'DELETE';
    } else if (['place_gtt', 'modify_gtt'].includes(method)) {
      path = '/gtt/triggers';
      verb = method === 'place_gtt' ? 'POST' : 'PUT';
      if (verb === 'PUT') path += `/${pathPart(kwargs.trigger_id ?? args[0])}`;
      payload = {type: kwargs.trigger_type ?? kwargs.type,
        condition: JSON.stringify({exchange: kwargs.exchange, tradingsymbol: kwargs.tradingsymbol,
          trigger_values: kwargs.trigger_values, last_price: kwargs.last_price}),
        orders: JSON.stringify(kwargs.orders)};
    } else throw new TypeError(`Unsupported broker method: ${method}`);

    if (verb === 'DELETE' && payload && Object.keys(payload).length) {
      path += '?' + formBody(payload); payload = null;
    }
    const headers = {'X-Kite-Version': '3', Authorization: `token ${this.api_key}:${this.access_token}`};
    const request = {method: verb, headers, signal: AbortSignal.timeout(8000), redirect: 'error'};
    if (payload) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      request.body = formBody(payload).toString();
    }
    const startedWall = Number(this._wallClock()), startedMono = this._clock();
    const response = await this._fetch(`https://api.kite.trade${path}`, request);
    this._observe_clock(response, startedWall, startedMono);
    if (method === 'instruments' && response.ok) return transform(await response.text());
    let body;
    try { body = await response.json(); }
    catch { throw new BrokerError('NetworkException', `Invalid broker response (HTTP ${response.status})`, {http_status: response.status}); }
    if (!response.ok || body?.status !== 'success') {
      const validError = body && typeof body === 'object' && !Array.isArray(body) && body.status === 'error' &&
        typeof body.message === 'string' && body.message.trim().length > 0 &&
        typeof body.error_type === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(body.error_type) &&
        (!Object.hasOwn(body, 'data') || body.data === null || plain(body.data));
      const acknowledged = [body?.order_id, body?.data?.order_id, body?.trigger_id, body?.data?.trigger_id]
        .some(value => value !== undefined && value !== null && value !== '');
      // Only the broker's explicit, well-formed precondition rejection is a
      // definitive authorisation failure. Network/parse errors remain ambiguous.
      // An exception name alone never proves that a mutation was rejected:
      // acknowledgements, server/time-out failures and contradictory envelopes
      // must retain ownership and cash reservations until reconciliation.
      throw new BrokerError(body?.error_type || 'NetworkException', body?.message || `HTTP ${response.status}`, {
        http_status: response.status, auth_required: response.status === 428 && Boolean(validError) && !acknowledged,
        definitive_rejection: response.ok === false && Boolean(validError) && !acknowledged &&
          REJECTION_STATUSES.has(response.status) && REJECTION_KINDS.has(body.error_type),
      });
    }
    return transform(body.data);
  }

  async account() {
    const result = {};
    for (const key of ['margins', 'holdings', 'positions', 'orders', 'trades']) result[key] = jsonable(await this.call(key));
    result.updated_at = new Date().toISOString();
    return result;
  }

  async buy_cover(symbol, quantity, price, stop, tag) {
    return this.call('place_order', {variety: 'co', exchange: 'NSE', tradingsymbol: symbol,
      transaction_type: 'BUY', quantity, product: 'MIS', order_type: 'LIMIT', price,
      trigger_price: stop, validity: 'DAY', tag});
  }

  async sell_cover(symbol, quantity, price, stop, tag) {
    return this.call('place_order', {variety: 'co', exchange: 'NSE', tradingsymbol: symbol,
      transaction_type: 'SELL', quantity, product: 'MIS', order_type: 'LIMIT', price,
      trigger_price: stop, validity: 'DAY', tag});
  }

  async cancel_cover(order_id, parent_order_id = null) {
    const payload = {variety: 'co', order_id: String(order_id)};
    if (parent_order_id) payload.parent_order_id = String(parent_order_id);
    return this.call('cancel_order', payload);
  }

  async stream(tokens, on_ticks, on_order, on_status) {
    if (tokens.length > 9000) throw new RangeError("Universe exceeds Kite's 9,000-instrument streaming capacity.");
    if (tokens.some(token => !Number.isSafeInteger(token) || token <= 0)) throw new TypeError('Invalid stream instrument token');
    // Request order determines ownership, including while an earlier shutdown
    // is awaiting worker termination. Only the latest request may create feeds.
    const generation = ++this._generation;
    return this._streamLifecycle.run(async()=>{
    await this._close_streams();if(generation!==this._generation)return;
    for (let offset = 0; offset < tokens.length; offset += 3000) {
      const index = offset / 3000, selected = tokens.slice(offset, offset + 3000);
      const slot={worker:null,timer:null,failures:0};this._streamSlots.add(slot);
      const current=()=>generation===this._generation&&this._streamSlots.has(slot);
      const spawn=()=>{
        slot.timer=null;if(!current())return;
        let worker,failed=false,exited=false,retired=false,waitForExit=false,connectedAt=null;
        const retire=()=>{
          if(retired)return;retired=true;
          this.sockets=this.sockets.filter(item=>item!==worker);slot.worker=null;
          if(!current())return;
          const delay=Math.min(60000,1000*2**Math.min(slot.failures++,6));
          slot.timer=setTimeout(spawn,delay);slot.timer.unref?.();
        };
        const fail=()=>{
          if(!current()||failed)return;failed=true;
          if(connectedAt!==null&&this._clock()-connectedAt>=60)slot.failures=0;
          on_status(index,false,selected);
          if(!worker){retire();return;}
          // Finish retiring the old worker before replacing it: Kite permits
          // at most three simultaneous subscriptions for this connection set.
          const retiring=Promise.resolve().then(()=>worker.terminate()).then(retire,()=>{if(exited)retire();else waitForExit=true;}).finally(()=>this._retiringSockets.delete(retiring));
          this._retiringSockets.add(retiring);
        };
      // KiteTicker 5.3.0 shares socket state at module scope. Each feed gets its own
      // isolate so 3 connections remain independent. These are not analytics workers.
      try{worker = this._workerFactory(new URL('./broker-stream-worker.js', import.meta.url), {
        workerData: {api_key: this.api_key, access_token: this.access_token, tokens: selected},
        execArgv: [],
      });}catch{fail();return;}
      slot.worker=worker;this.sockets.push(worker);
      worker.on('message', message => {
        if (!current()||failed||slot.worker!==worker) return;
        if (message.type === 'ticks') on_ticks(message.ticks);
        else if (message.type === 'order') on_order(jsonable(message.order));
        else if (message.type === 'status') {
          if(message.connected){if(connectedAt===null)connectedAt=this._clock();}
          else {if(connectedAt!==null&&this._clock()-connectedAt>=60)slot.failures=0;connectedAt=null;}
          on_status(index, Boolean(message.connected), selected);
        }
        else if(message.type==='restart')fail();
      });
      worker.on('error', fail);
      worker.on('exit',()=>{exited=true;this.sockets=this.sockets.filter(item=>item!==worker);if(waitForExit)retire();else fail();});
      };
      spawn();
    }
    });
  }

  async close() {
    this._generation++;
    return this._streamLifecycle.run(()=>this._close_streams());
  }
  async _close_streams(){
    for(const slot of this._streamSlots)clearTimeout(slot.timer);this._streamSlots.clear();
    const sockets=[...this.sockets];
    await Promise.allSettled([...sockets.map(worker=>Promise.resolve().then(()=>worker.terminate()).then(()=>{this.sockets=this.sockets.filter(item=>item!==worker);})),...this._retiringSockets]);
    if(this.sockets.length)throw new Error('Feed worker termination is unconfirmed; a new subscription cannot start yet');
  }
}
