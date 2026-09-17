/** Durable delivery order lifecycle and opt-in management of existing holdings.
 * Every mutation is journalled before submission and is never blindly retried.
 * IOC entries are protected only after terminal confirmed fills. A broker GTT
 * triggers a LIMIT order; it is neither an atomic entry/stop nor a guaranteed exit.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Candle, atr } from './strategy.js';
import { Mutex, monotonic, nowIST, parseTime, dateIST, marketHours } from './util.js';
import { authorizedQuantity } from './holdings-authorization.js';

const TERMINAL = new Set(['COMPLETE', 'CANCELLED', 'REJECTED']);
const INACTIVE_GTT = new Set(['deleted', 'cancelled', 'expired', 'rejected', 'disabled']);
const clone = value => structuredClone(value);
const sum = values => values.reduce((a, b) => a + b, 0);
const mean = values => sum(values) / values.length;
const stamp = () => new Date().toISOString();
const matchesSymbol = (row, symbol) => row.exchange === 'NSE' && row.tradingsymbol === symbol;

// Treat the decimal representation as exact, as Decimal(str(value)) did in the
// original engine. Avoid binary division rounding an on-tick price down/up.
function decimalRatio(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const parts = mantissa.split('.');
  let numerator = BigInt(parts.join(''));
  const scale = (parts[1]?.length ?? 0) - Number(exponent);
  if (scale < 0) numerator *= 10n ** BigInt(-scale);
  return [numerator, scale > 0 ? 10n ** BigInt(scale) : 1n];
}

export function _price(value, tick = 0.05, up = false) {
  if (typeof value !== 'number' || typeof tick !== 'number' || !Number.isFinite(value) || !Number.isFinite(tick) || value <= 0 || tick <= 0) {
    throw new RangeError('Prices and tick sizes must be positive and finite');
  }
  const [vn, vd] = decimalRatio(value);
  const [tn, td] = decimalRatio(tick);
  const numerator = vn * td;
  const denominator = vd * tn;
  const ticks = numerator / denominator + (up && numerator % denominator ? 1n : 0n);
  return Number(ticks * tn) / Number(td);
}

function quantityValue(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Quantity must be a positive integer');
  return value;
}

export function _holding_available(row) {
  if (row.discrepancy || (row.product ?? 'CNC') !== 'CNC') return 0;
  // T1, pledged, used, discrepant and MTF shares cannot be automatically sold.
  const values = [row.quantity ?? 0, row.used_quantity ?? 0, row.collateral_quantity ?? 0].map(Number);
  if (values.some(n => !Number.isSafeInteger(n) || n < 0)) return 0;
  return Math.max(0, values[0] - values[1] - values[2]);
}

export class DeliveryManager {
  constructor(store, broker, settings = null, nowFn = null) {
    Object.assign(this, { store, broker, settings, now: nowFn ?? nowIST });
    // The execution engine supplies current rupee budgets derived from account
    // funds and saved allocation fractions. Standalone consumers may retain
    // explicit budgets in their store.
    this.strategy_settings = null;
    this.authorization_needed = null;
    this.authorization_blocked = null;
    this.lock = new Mutex();
    this.state = store.get('delivery_state', { positions: {}, intents: {} });
  }

  _save() { this.store.set('delivery_state', this.state); }

  remap_tokens(tokens) {
    for (const [symbol, p] of Object.entries(this.state.positions)) p.token = tokens[symbol] ?? 0;
    this._save();
  }

  snapshot() {
    const result = clone(this.state);
    for (const p of Object.values(result.positions)) {
      Object.assign(p, {
        strategy: 'swing', mode: 'live', token: p.token ?? 0,
        entry: p.entry_price ?? 0, last: p.last ?? p.entry_price ?? 0,
        tag: p.entry_intent ?? 'existing',
        entry_fee: p.source === 'swing' ? (p.entry_price ?? 0) * Math.max(0, (p.quantity ?? 0) - (p.sold_quantity ?? 0)) * 0.001 : 0,
        protection: p.gtt_id ?? null, is_bot_owned: p.source === 'swing', origin: p.source,
        remaining_quantity: Math.max(0, (p.quantity ?? 0) - (p.sold_quantity ?? 0)),
      });
    }
    result.realised_pnl = (this.state.archived_pnl ?? 0) + sum(Object.values(result.positions).map(p => p.realised_pnl ?? 0));
    result.bot_realised_pnl = (this.state.archived_bot_pnl ?? 0) + sum(Object.values(result.positions).filter(p => p.source === 'swing').map(p => p.realised_pnl ?? 0));
    result.existing_holdings_realised_pnl = result.realised_pnl - result.bot_realised_pnl;
    result.reasons = Object.entries(result.positions).filter(([, p]) => p.blocked && p.status !== 'closed').map(([symbol, p]) => `${symbol}: ${p.reason}`);
    result.blocked = result.reasons.length > 0;
    return result;
  }

  _result(p = null, status = null, reason = null, blocked = null) {
    return { status: status ?? p?.status ?? 'ready', reason: reason ?? p?.reason ?? '',
      blocked: blocked ?? p?.blocked ?? false, ...(p ? { position: clone(p) } : {}) };
  }

  _set(p, status, reason = '', blocked = false) {
    const changed = p.status !== status || p.reason !== reason || p.blocked !== blocked;
    Object.assign(p, { status, reason, blocked, updated_at: stamp() });
    this._save();
    if (changed) this.store.event('delivery', `${p.symbol}: ${reason || status}`, { symbol: p.symbol, status }, { level: blocked ? 'error' : 'info' });
    return this._result(p);
  }

  _intent(kind, symbol, payload) {
    const id = 'dl' + randomUUID().replaceAll('-', '').slice(0, 18);
    const row = { id, kind, symbol, payload, state: 'submitting', created_at: stamp() };
    this.state.intents[id] = row;
    this._save();
    return row;
  }

  _live_gate(buying = false) {
    if (!this.settings || this.settings.trading_mode !== 'live' || !this.settings.live_trading_enabled) return 'Live delivery trading is disabled by server configuration';
    if (buying && (existsSync(join(this.settings.data_dir, 'maintenance.lock')) || this.store.get('maintenance_lock', false))) return 'Maintenance lock prevents new delivery entries';
    return '';
  }

  _session_open() { return marketHours(this.now()); }

  _fresh_quote(quote, max_age = 30) {
    const at = parseTime(quote.timestamp);
    if (!at) return false;
    const age = (this.now().getTime() - at.getTime()) / 1000;
    return age >= -5 && age <= max_age;
  }

  _quote_hint(hint) {
    const quote = { ...(hint ?? {}) };
    quote.timestamp = quote.timestamp ?? quote.exchange_timestamp;
    const age = monotonic() - Number(quote.received_at ?? -Infinity);
    return age >= 0 && age <= 10 && this._fresh_quote(quote, 10) ? quote : null;
  }

  async _profile_ready() { return (await this.broker.call('profile'))?.meta?.demat_consent === 'physical'; }

  _authority_result(p, status, reason, blocked) {
    return this.state.positions[p.symbol] === p ? this._set(p, status, reason, blocked) : this._result(null, status, `${p.symbol}: ${reason}`, blocked);
  }

  _request_authorization(p, quantity, holding, reason = 'Authorize delivery shares in Zerodha to continue; authorization is verified against fresh holdings.', extra = {}) {
    this.authorization_needed?.({ symbol: p.symbol, quantity, holding: holding ? clone(holding) : null, reason, ...extra });
    return this._authority_result(p, 'authorization_required', reason, false);
  }

  async _authorization_rejected(p, quantity) {
    let holding = null;
    try { holding = (await this.broker.call('holdings')).find(h => matchesSymbol(h, p.symbol)) ?? null; } catch { /* The verified HTTP rejection still requires user authorization. */ }
    return this._request_authorization(p, quantity, holding, 'Zerodha requires renewed delivery authorization. Complete the official authorization and recheck holdings before continuing.', { broker_rejected: true });
  }

  async _delivery_authority(p, quantity) {
    // A definitive broker rejection remains latched by the authorization
    // service until the user requests a fresh verification. Background polls
    // must not turn unchanged broker fields into permission to retry.
    if (this.authorization_blocked?.(p.symbol)) return this._authorization_rejected(p, quantity);
    const profile = await this.broker.call('profile');
    const consent = profile?.meta?.demat_consent ?? '';
    if (consent === 'physical') return null;
    if (!['', 'consent'].includes(consent)) return this._authority_result(p, 'blocked', 'Unrecognized demat authorization status; verify the account before delivery execution', true);
    // A successful browser return is not authorization proof. Use a fresh
    // broker holdings response, current IST date and unsold settled quantities.
    const holdings = (await this.broker.call('holdings')).filter(h => matchesSymbol(h, p.symbol));
    const usable = sum(holdings.map(h => authorizedQuantity(h, this.now())));
    if (usable >= quantity) return null;
    const holding = holdings.find(h => _holding_available(h) > 0) ?? holdings[0] ?? null;
    return this._request_authorization(p, quantity, holding);
  }

  async _account() {
    return { orders: await this.broker.call('orders'), holdings: await this.broker.call('holdings'), positions: await this.broker.call('positions') };
  }

  _available(account, p) {
    const holdings = sum((account.holdings ?? []).filter(h => matchesSymbol(h, p.symbol)).map(_holding_available));
    if (p.source === 'existing') return holdings;
    const rows = Array.isArray(account.positions) ? account.positions : (account.positions?.net ?? []);
    const bought = sum(rows.filter(r => matchesSymbol(r, p.symbol) && r.product === 'CNC').map(r => Math.max(0, Math.trunc(Number(r.quantity ?? 0)))));
    // A settling purchase may appear in both endpoints. Never add both counts.
    return Math.max(holdings, bought);
  }

  _gtt_conflict(gtt, symbol) {
    return matchesSymbol(gtt.condition ?? {}, symbol) && (gtt.status === 'active' || gtt.status === 'triggered' && !(this.state.settled_gtts ?? []).includes(String(gtt.id)));
  }

  _gtt_order_ids(gtt) {
    const ids = [];
    let ambiguous = false;
    for (const order of gtt.orders ?? []) {
      if (order.result) {
        const outcome = order.result.order_result ?? {};
        if (outcome.order_id) ids.push(String(outcome.order_id));
        else if (outcome.status !== 'failed') ambiguous = true;
      }
    }
    if (gtt.status === 'triggered' && !(gtt.orders ?? []).some(o => o.result)) ambiguous = true;
    return [ids, ambiguous];
  }

  async _order(intent, account) {
    if (intent.state === 'terminal') return intent.order;
    let matches;
    if (intent.order_id) {
      matches = (account.orders ?? []).filter(o => String(o.order_id) === String(intent.order_id));
      if (!matches.length) {
        try { matches = (await this.broker.call('order_history', String(intent.order_id))).slice(-1); }
        catch { return null; }
      }
    } else matches = (account.orders ?? []).filter(o => o.tag === intent.id);
    if (matches.length !== 1) return null;
    const order = matches[0];
    const payload = intent.payload;
    if (!matchesSymbol(order, intent.symbol) || order.product !== 'CNC' || order.transaction_type !== payload.transaction_type || Number(order.quantity ?? -1) !== Number(payload.quantity ?? -2)) return null;
    Object.assign(intent, { order_id: String(order.order_id), order: clone(order), state: TERMINAL.has(order.status) ? 'terminal' : 'acknowledged' });
    this._save();
    return order;
  }

  async _submit_order(p, kind, side, quantity, price) {
    let gate = this._live_gate(side === 'BUY');
    if (gate) { this._set(p, 'blocked', gate, true); return null; }
    const payload = { variety: 'regular', exchange: 'NSE', tradingsymbol: p.symbol, transaction_type: side, quantity, product: 'CNC', order_type: 'LIMIT', price, validity: 'IOC' };
    const intent = this._intent(kind, p.symbol, payload);
    if (kind === 'entry') p.entry_intent = intent.id;
    else (p.exit_intents ??= []).push(intent.id);
    this._save(); // Position association is durable before REST submission.
    try {
      gate = this._live_gate(side === 'BUY');
      if (gate) {
        intent.state = 'aborted'; this._save();
        this._set(p, kind === 'entry' ? 'closed' : 'blocked', gate, kind !== 'entry');
        return null;
      }
      const oid = await this.broker.call('place_order', { ...payload, tag: intent.id });
      if (!oid) throw new Error('Missing broker order id');
      Object.assign(intent, { order_id: String(oid), state: 'acknowledged' });
    } catch (error) {
      if (side === 'SELL' && error.auth_required === true) {
        // A verified Kite HTTP 428 error without an order acknowledgement is a
        // definitive rejection. Preserve the no-fill outcome in the journal.
        Object.assign(intent, { state: 'terminal', rejection: 'authorization_required',
          order: { ...payload, order_id: null, status: 'REJECTED', filled_quantity: 0, pending_quantity: 0, average_price: 0 } });
        delete p.exit_requested;
        // Explicit exits reach this point only after confirmed GTT disarming.
        // Keep historical trigger fills, but allow fresh protection if the
        // original sell signal is no longer present after authorization.
        delete p.gtt_id; delete p.gtt_intent; delete p.gtt_cancel_intent;
        this._save();
        await this._authorization_rejected(p, quantity);
        return null;
      }
      Object.assign(intent, { state: 'unknown', error: error.name });
    }
    this._save();
    return intent;
  }

  async submit_entry(symbol, quantity, limit_price, stop_price, target_price = null, tick_size = 0.05, token = 0) {
    return this.lock.run(async () => {
      quantity = quantityValue(quantity);
      const entry = _price(limit_price, tick_size, true);
      const stop = _price(stop_price, tick_size);
      const target = target_price ? _price(target_price, tick_size, true) : null;
      if (!symbol || stop >= entry || target !== null && target <= entry) throw new RangeError('Require stop < entry < target');
      const gate = this._live_gate(true);
      if (gate) return this._result(null, 'blocked', gate, true);
      if (!this._session_open()) return this._result(null, 'waiting', 'Delivery entry requires an open regular session', true);
      const settings = this.strategy_settings ? this.strategy_settings() : this.store.get('strategy_settings', {});
      if (!settings.swing_enabled || Number(settings.swing_capital ?? 0) <= 0) return this._result(null, 'disabled', 'Swing needs an enabled strategy and allocated funds', true);
      if (this.snapshot().blocked) return this._result(null, 'blocked', 'Resolve existing delivery protection/order uncertainty first', true);
      const previous = this.state.positions[symbol];
      if (previous && previous.status !== 'closed') return this._result(previous);
      const reserved = sum(Object.values(this.state.positions).filter(p => p.source === 'swing' && p.status !== 'closed').map(p => Number(p.entry_price ?? 0) * Number(p.requested_quantity ?? p.quantity ?? 0)));
      if (reserved + entry * quantity * 1.001 > Number(settings.swing_capital)) return this._result(null, 'blocked', 'Swing allocation would be exceeded', true);
      try {
        if (!await this._profile_ready()) return this._result(null, 'blocked', 'Verified DDPI/POA is required for unattended delivery exits', true);
        const account = await this._account();
        const gtts = await this.broker.call('get_gtts');
        if (this._available(account, { symbol, source: 'swing' }) || account.orders.some(o => matchesSymbol(o, symbol) && o.product === 'CNC' && !TERMINAL.has(o.status))) return this._result(null, 'blocked', 'Existing delivery exposure or order already owns this symbol', true);
        if (gtts.some(g => this._gtt_conflict(g, symbol))) return this._result(null, 'blocked', 'Existing GTT requires reconciliation before entry', true);
        const quote = (await this.broker.call('quote', ['NSE:' + symbol]))['NSE:' + symbol] ?? {};
        if (!this._fresh_quote(quote)) return this._result(null, 'blocked', 'Fresh exchange quote required before delivery entry', true);
      } catch { return this._result(null, 'blocked', 'Delivery preflight unavailable', true); }
      const p = { symbol, source: 'swing', status: 'entry_pending', blocked: true,
        reason: 'Entry awaiting confirmed fills and GTT protection', requested_quantity: quantity,
        quantity: 0, sold_quantity: 0, entry_price: entry, stop, target, tick_size, token,
        exit_intents: [], gtt_order_ids: [], created_at: stamp() };
      this._archive(previous);
      this.state.positions[symbol] = p;
      this._save();
      if (!await this._submit_order(p, 'entry', 'BUY', quantity, entry)) return this._result(p);
      return this._reconcile_position(p, await this._safe_account());
    });
  }

  _archive(previous) {
    if (!previous) return;
    this.state.archived_pnl = (this.state.archived_pnl ?? 0) + (previous.realised_pnl ?? 0);
    if (previous.source === 'swing') this.state.archived_bot_pnl = (this.state.archived_bot_pnl ?? 0) + (previous.realised_pnl ?? 0);
  }

  async _safe_account() { try { return await this._account(); } catch { return null; } }

  async _protect(p) {
    const remaining = p.quantity - (p.sold_quantity ?? 0);
    if (remaining <= 0) return this._set(p, 'closed');
    if (p.gtt_intent) {
      const intent = this.state.intents[p.gtt_intent];
      if (!p.gtt_id) {
        try {
          const gtts = await this.broker.call('get_gtts');
          const matches = gtts.filter(g => !intent.before_ids.includes(String(g.id)) && this._same_gtt(g, intent.payload));
          if (matches.length !== 1) return this._set(p, 'blocked', 'GTT placement is ambiguous; do not repeat or sell', true);
          p.gtt_id = String(matches[0].id);
          Object.assign(intent, { state: 'acknowledged', trigger_id: p.gtt_id });
          this._save();
        } catch { return this._set(p, 'blocked', 'GTT placement cannot be reconciled', true); }
      }
      return null;
    }
    const gate = this._live_gate();
    if (gate) return this._set(p, 'blocked', gate, true);
    try {
      const authority = await this._delivery_authority(p, remaining);
      if (authority) return authority;
      const quote = (await this.broker.call('quote', ['NSE:' + p.symbol]))['NSE:' + p.symbol] ?? {};
      const last = Number(quote.last_price ?? 0);
      if (!Number.isFinite(last) || last <= p.stop || p.target && last >= p.target) return this._set(p, 'blocked', 'Price already crossed the planned GTT boundary; exit review required', true);
      const gtts = await this.broker.call('get_gtts');
      if (gtts.some(g => this._gtt_conflict(g, p.symbol))) return this._set(p, 'blocked', 'Another GTT exists for this symbol; protection ownership uncertain', true);
      if (gtts.filter(g => g.status === 'active').length >= 500) return this._set(p, 'blocked', 'Account GTT capacity exhausted', true);
      let stop_limit = _price(p.stop * 0.995, p.tick_size);
      const low = Number(quote.lower_circuit_limit || 0);
      if (stop_limit < low) stop_limit = _price(low, p.tick_size, true);
      if (stop_limit > p.stop || stop_limit <= 0) return this._set(p, 'blocked', 'Protective limit is outside the current circuit range', true);
      const values = [p.stop], prices = [stop_limit];
      if (p.target) { values.push(p.target); prices.push(p.target); }
      const payload = { trigger_type: p.target ? 'two-leg' : 'single', tradingsymbol: p.symbol, exchange: 'NSE',
        trigger_values: values, last_price: last,
        orders: prices.map(price => ({ exchange: 'NSE', tradingsymbol: p.symbol, transaction_type: 'SELL', quantity: remaining, order_type: 'LIMIT', product: 'CNC', price })) };
      const intent = this._intent('gtt', p.symbol, payload);
      intent.before_ids = gtts.map(g => String(g.id));
      p.gtt_intent = intent.id;
      this._save();
      try {
        const response = await this.broker.call('place_gtt', payload);
        if (!response.trigger_id) throw new Error('Missing trigger id');
        p.gtt_id = String(response.trigger_id);
        Object.assign(intent, { state: 'acknowledged', trigger_id: p.gtt_id });
      } catch (error) {
        if (error.auth_required === true) {
          Object.assign(intent, { state: 'rejected', rejection: 'authorization_required' });
          delete p.gtt_intent;
          this._save();
          return this._authorization_rejected(p, remaining);
        }
        Object.assign(intent, { state: 'unknown', error: error.name });
        this._save();
        return this._set(p, 'blocked', 'GTT placement response uncertain; reconciling without retry', true);
      }
      this._save();
      return null;
    } catch { return this._set(p, 'blocked', 'Unable to establish broker-held GTT protection', true); }
  }

  _same_gtt(gtt, payload) {
    const condition = gtt.condition ?? {};
    if (gtt.type !== payload.trigger_type || condition.exchange !== 'NSE' || condition.tradingsymbol !== payload.tradingsymbol || !isDeepStrictEqual(condition.trigger_values, payload.trigger_values)) return false;
    const fields = ['exchange', 'tradingsymbol', 'transaction_type', 'quantity', 'order_type', 'product', 'price'];
    return isDeepStrictEqual((gtt.orders ?? []).map(o => fields.map(k => o[k])), (payload.orders ?? []).map(o => fields.map(k => o[k])));
  }

  async _gtt_fills(p, gtt, account) {
    const [ids, ambiguous] = this._gtt_order_ids(gtt);
    if (ambiguous) return [false, 'Triggered GTT has an unresolved exchange order'];
    for (const oid of ids) if (!(p.gtt_order_ids ??= []).includes(oid)) p.gtt_order_ids.push(oid);
    let fills = 0, pending = false;
    for (const oid of p.gtt_order_ids ?? []) {
      const prior = (p.gtt_orders ??= {})[oid];
      let order;
      if (prior && TERMINAL.has(prior.status)) order = prior;
      else {
        let matches = account.orders.filter(o => String(o.order_id) === oid);
        if (!matches.length) {
          try { matches = (await this.broker.call('order_history', oid)).slice(-1); }
          catch { return [false, 'Triggered GTT order cannot be reconciled']; }
        }
        if (!matches.length) return [false, 'Triggered GTT order is missing'];
        order = matches.at(-1);
        if (!matchesSymbol(order, p.symbol) || order.product !== 'CNC' || order.transaction_type !== 'SELL') return [false, 'Triggered GTT order identity mismatch'];
        p.gtt_orders[oid] = clone(order);
      }
      fills += Number(order.filled_quantity ?? 0);
      pending ||= !TERMINAL.has(order.status);
    }
    p.gtt_filled_quantity = fills;
    if (!pending && gtt.status === 'triggered') {
      const settled = this.state.settled_gtts ??= [];
      if (!settled.includes(String(gtt.id))) settled.push(String(gtt.id));
    }
    this._save();
    return [!pending, pending ? 'Triggered GTT sell remains open' : ''];
  }

  async _reconcile_position(p, account) {
    if (p.status === 'closed') return this._result(p);
    if (account === null) return this._set(p, 'blocked', 'Broker account unavailable; delivery reconciliation required', true);
    if (p.entry_intent) {
      const order = await this._order(this.state.intents[p.entry_intent], account);
      if (order) {
        p.quantity = Number(order.filled_quantity ?? 0);
        if (p.quantity) p.entry_price = Number(order.average_price || p.entry_price);
      }
      if (!order || !TERMINAL.has(order.status)) return this._set(p, 'entry_pending', 'Entry outcome unresolved; no additional entry or duplicate retry', true);
      if (p.quantity === 0) return this._set(p, 'closed', 'Entry ended without a fill');
      if (p.quantity > p.requested_quantity) return this._set(p, 'blocked', 'Entry filled more than the intended quantity', true);
      p.entry_price = Number(order.average_price || p.entry_price);
    }
    let explicit_fills = 0, unresolved_exit = false;
    for (const iid of p.exit_intents ?? []) {
      const order = await this._order(this.state.intents[iid], account);
      if (!order || !TERMINAL.has(order.status)) unresolved_exit = true;
      explicit_fills += Number(order?.filled_quantity ?? 0);
    }
    p.sold_quantity = explicit_fills + Number(p.gtt_filled_quantity ?? 0);
    this._realised(p);
    if (unresolved_exit) return this._set(p, 'exit_pending', 'Exit outcome unresolved; no duplicate sell', true);
    if (p.sold_quantity > p.quantity) return this._set(p, 'blocked', 'Sell fills exceed managed quantity; reconcile account immediately', true);
    if (p.sold_quantity === p.quantity) return this._set(p, 'closed', 'Confirmed delivery exit');
    if (p.exit_requested && !p.gtt_id && !p.gtt_intent) return this._set(p, 'exit_pending', 'Residual shares await a confirmed follow-up exit', true);
    if (!p.gtt_id) {
      if (!p.gtt_intent && this._available(account, p) < p.quantity - p.sold_quantity) return this._set(p, 'blocked', 'Delivery quantity changed while offline; verify shares before creating protection', true);
      const protection = await this._protect(p);
      if (protection) return protection;
    }
    let gtt;
    try { gtt = await this.broker.call('get_gtt', p.gtt_id); }
    catch { return this._set(p, 'blocked', 'GTT status unavailable; do not create another trigger or sell', true); }
    const [complete, reason] = await this._gtt_fills(p, gtt, account);
    p.sold_quantity = explicit_fills + Number(p.gtt_filled_quantity ?? 0);
    this._realised(p);
    if (!complete) return this._set(p, 'exit_pending', reason, true);
    if (p.sold_quantity > p.quantity) return this._set(p, 'blocked', 'Sell fills exceed managed quantity; reconcile account immediately', true);
    if (p.sold_quantity === p.quantity) return this._set(p, 'closed', 'Confirmed GTT exit');
    if (p.exit_requested) return this._set(p, 'exit_pending', 'Explicit exit requested; reconcile trigger before selling', true);
    const intent = this.state.intents[p.gtt_intent] ?? {};
    if (gtt.status !== 'active' || !this._same_gtt(gtt, intent.payload ?? {})) return this._set(p, 'blocked', 'GTT is inactive or changed; remaining shares are not verified protected', true);
    try {
      const others = await this.broker.call('get_gtts');
      if (others.some(g => this._gtt_conflict(g, p.symbol) && String(g.id) !== p.gtt_id)) return this._set(p, 'blocked', 'Additional GTT on managed symbol; exit ownership is ambiguous', true);
    } catch { return this._set(p, 'blocked', 'Cannot verify exclusive GTT protection ownership', true); }
    if (this._available(account, p) < p.quantity - p.sold_quantity) return this._set(p, 'blocked', 'Delivery quantity changed outside this strategy; reconcile GTT before trading', true);
    const authority = await this._delivery_authority(p, p.quantity - p.sold_quantity);
    if (authority) return authority;
    return this._set(p, 'protected', 'Broker-held GTT verified for confirmed delivery quantity');
  }

  _realised(p) {
    const orders = [...Object.values(p.gtt_orders ?? {}), ...(p.exit_intents ?? []).map(iid => this.state.intents[iid].order ?? {})];
    const value = sum(orders.map(o => Number(o.average_price ?? 0) * Number(o.filled_quantity ?? 0)));
    const qty = sum(orders.map(o => Number(o.filled_quantity ?? 0)));
    // Explicit estimate; contract-note costs should replace this for accounting.
    p.realised_pnl = value - qty * (p.entry_price ?? 0) - value * 0.001 - qty * (p.entry_price ?? 0) * 0.001;
    p.pnl_is_estimate = true;
  }

  async cancel_pending_entries() {
    return this.lock.run(async () => {
      const results = [], account = await this._safe_account();
      if (!account) return this._result(null, 'blocked', 'Cannot reconcile pending delivery entries', true);
      for (const p of Object.values(this.state.positions)) {
        if (!p.entry_intent || p.status === 'closed') continue;
        const intent = this.state.intents[p.entry_intent];
        const order = await this._order(intent, account);
        if (!order) { results.push(this._set(p, 'blocked', 'Unknown entry cannot be cancelled or retried safely', true)); continue; }
        if (!TERMINAL.has(order.status) && !p.entry_cancel_intent) {
          const cancel = this._intent('cancel_entry', p.symbol, { order_id: intent.order_id });
          p.entry_cancel_intent = cancel.id;
          this._save();
          try {
            await this.broker.call('cancel_order', { variety: 'regular', order_id: intent.order_id });
            cancel.state = 'acknowledged';
          } catch { cancel.state = 'unknown'; }
          this._save();
        }
        results.push(await this._reconcile_position(p, await this._safe_account()));
      }
      return { status: 'paused', blocked: results.some(r => r.blocked), reason: '', results };
    });
  }

  async reconcile(account = null) {
    return this.lock.run(async () => {
      account ??= await this._safe_account();
      const results = [];
      for (const p of Object.values(this.state.positions)) {
        try { results.push(await this._reconcile_position(p, account)); }
        catch { results.push(this._set(p, 'blocked', 'Delivery reconciliation failed', true)); }
      }
      const snapshot = this.snapshot();
      return { status: snapshot.blocked ? 'blocked' : results.some(r => r.status === 'authorization_required') ? 'authorization_required' : 'ready', blocked: snapshot.blocked, reason: snapshot.reasons.join('; '), results };
    });
  }

  async _disarm(p, account) {
    if (p.gtt_intent && !p.gtt_id) {
      const result = await this._protect(p);
      if (result) return [false, result.reason];
    }
    if (!p.gtt_id) return [true, ''];
    try {
      let gtt = await this.broker.call('get_gtt', p.gtt_id);
      if (gtt.status === 'active') {
        const original = this.state.intents[p.gtt_intent]?.payload;
        if (!original || !this._same_gtt(gtt, original)) return [false, 'GTT was changed outside this manager; reconcile before cancellation'];
        if (!p.gtt_cancel_intent) {
          const cancel = this._intent('cancel_gtt', p.symbol, { trigger_id: p.gtt_id });
          p.gtt_cancel_intent = cancel.id;
          this._save();
          try { await this.broker.call('delete_gtt', p.gtt_id); cancel.state = 'acknowledged'; }
          catch { cancel.state = 'unknown'; }
          this._save();
        }
        // HTTP success may race a triggered sell. Re-read trigger and OMS.
        gtt = await this.broker.call('get_gtt', p.gtt_id);
      }
      if (!INACTIVE_GTT.has(gtt.status) && gtt.status !== 'triggered') return [false, 'GTT cancellation not confirmed; explicit sell withheld'];
      const [complete, reason] = await this._gtt_fills(p, gtt, account);
      if (!complete) return [false, reason];
      return [true, ''];
    } catch { return [false, 'GTT cancellation/trigger outcome unknown; explicit sell withheld']; }
  }

  async request_exit(symbol, quantity, limit_price, reason = 'Strategy exit') {
    return this.lock.run(async () => {
      quantity = quantityValue(quantity);
      const p = this.state.positions[symbol];
      if (!p || p.status === 'closed') return this._result(p, 'closed', 'No managed delivery quantity remains');
      const gate = this._live_gate();
      if (gate) return this._set(p, 'blocked', gate, true);
      if (!this._session_open()) return this._result(p, 'waiting', 'Delivery exit requires an open regular session', true);
      const price = _price(limit_price, p.tick_size);
      let account;
      try {
        const quote = (await this.broker.call('quote', ['NSE:' + symbol]))['NSE:' + symbol] ?? {};
        const bids = quote.depth?.buy ?? [];
        if (!this._fresh_quote(quote) || !bids.length || Number(bids[0].price ?? 0) <= 0 || Number(bids[0].quantity ?? 0) <= 0) return this._result(p, 'waiting', 'Fresh exchange quote and executable bid required for exit', true);
        account = await this._account();
      } catch { return this._set(p, 'blocked', 'Exit preflight unavailable', true); }
      if (p.entry_intent) {
        const entry = await this._order(this.state.intents[p.entry_intent], account);
        if (!entry || !TERMINAL.has(entry.status)) return this._set(p, 'blocked', 'Entry is not terminal; exit quantity is uncertain', true);
        p.quantity = Number(entry.filled_quantity ?? 0);
      }
      let explicit_fills = 0;
      for (const iid of p.exit_intents ?? []) {
        const order = await this._order(this.state.intents[iid], account);
        if (!order || !TERMINAL.has(order.status)) return this._set(p, 'exit_pending', 'Prior exit unresolved; duplicate sell withheld', true);
        explicit_fills += Number(order.filled_quantity ?? 0);
      }
      // Resolve unknown creation and known trigger fills before asking for
      // authorization. This is read-only: protective triggers stay intact.
      if (p.gtt_intent && !p.gtt_id) {
        const protection = await this._protect(p);
        if (protection) return protection;
      }
      if (p.gtt_id) {
        try {
          const gtt = await this.broker.call('get_gtt', p.gtt_id);
          const [complete, why] = await this._gtt_fills(p, gtt, account);
          if (!complete) return this._set(p, 'exit_pending', why, true);
        } catch { return this._set(p, 'blocked', 'GTT status unavailable before delivery authorization; explicit sell withheld', true); }
      }
      p.sold_quantity = explicit_fills + Number(p.gtt_filled_quantity ?? 0);
      const beforeDisarm = p.quantity - p.sold_quantity;
      if (beforeDisarm < 0) return this._set(p, 'blocked', 'Sell fills exceed managed quantity; reconcile account immediately', true);
      if (beforeDisarm === 0) { this._realised(p); return this._set(p, 'closed', 'Exit already filled by GTT'); }
      try {
        const authority = await this._delivery_authority(p, Math.min(quantity, beforeDisarm));
        if (authority) return authority;
      } catch { return this._set(p, 'blocked', 'Delivery authorization preflight unavailable', true); }
      p.exit_requested = { reason, price, quantity, at: stamp() };
      this._save();
      const [safe, why] = await this._disarm(p, account);
      if (!safe) return this._set(p, 'exit_pending', why, true);
      try {
        const gtts = await this.broker.call('get_gtts');
        if (gtts.some(g => this._gtt_conflict(g, symbol) && String(g.id) !== p.gtt_id)) return this._set(p, 'blocked', 'Another unresolved GTT can sell these shares; explicit exit withheld', true);
      } catch { return this._set(p, 'blocked', 'Cannot verify other GTTs before explicit exit', true); }
      p.sold_quantity = explicit_fills + Number(p.gtt_filled_quantity ?? 0);
      const remaining = p.quantity - p.sold_quantity;
      if (remaining < 0) return this._set(p, 'blocked', 'Sell fills exceed managed quantity; reconcile account immediately', true);
      if (remaining === 0) { this._realised(p); return this._set(p, 'closed', 'Exit already filled by GTT'); }
      account = await this._safe_account();
      if (!account) return this._set(p, 'blocked', 'Fresh holdings unavailable after GTT cancellation', true);
      if (account.orders.some(o => matchesSymbol(o, symbol) && o.product === 'CNC' && o.transaction_type === 'SELL' && !TERMINAL.has(o.status))) return this._set(p, 'exit_pending', 'Another CNC sell is open; additional sell withheld', true);
      quantity = Math.min(quantity, remaining);
      if (this._available(account, p) < quantity) return this._set(p, 'blocked', 'Insufficient verified free delivery shares for exit', true);
      if (!await this._submit_order(p, 'exit', 'SELL', quantity, price)) return this._result(p);
      return this._reconcile_position(p, await this._safe_account());
    });
  }

  _daily_bars(rows) {
    const today = dateIST(this.now());
    const dayNumber = value => Date.parse(value + 'T00:00:00Z') / 86400000;
    const bars = [];
    for (const row of rows) {
      const bar = row instanceof Candle ? row : new Candle(parseTime(row.time ?? row.date), Number(row.open), Number(row.high), Number(row.low), Number(row.close), Number(row.volume));
      if (bar.time && dateIST(bar.time) < today) bars.push(bar);
    }
    bars.sort((a, b) => a.time - b.time);
    if (bars.length < 21 || dayNumber(today) - dayNumber(dateIST(bars.at(-1).time)) > 7) return [];
    if (bars.slice(-21).some(b => ![b.open, b.high, b.low, b.close].every(x => Number.isFinite(x) && x > 0) || b.high < b.low)) return [];
    const recent = bars.slice(-22);
    for (let i = 1; i < recent.length; i++) {
      const a = recent[i - 1], b = recent[i];
      if (Math.abs(b.open / a.close - 1) > 0.2 || dayNumber(dateIST(b.time)) - dayNumber(dateIST(a.time)) > 7) return [];
    }
    return bars;
  }

  async evaluate_holdings(bars_by_symbol, settings, quotes_by_symbol = null, { adopt_new = true } = {}) {
    const results = [], evaluated_symbols = new Set();
    const mode = settings.manage_existing_holdings ?? 'selected';
    const selected = new Set(settings.managed_symbols ?? []);
    const allowed = symbol => mode === 'all' || mode === 'selected' && selected.has(symbol);
    const unavailable = await this.lock.run(async () => {
      const account = adopt_new ? await this._safe_account() : { holdings: [] };
      if (!account) return this._result(null, 'blocked', 'Holdings evaluation unavailable', true);
      for (const holding of account.holdings) {
        const symbol = holding.tradingsymbol ?? '';
        if (holding.exchange !== 'NSE' || !allowed(symbol)) continue;
        if (this.state.positions[symbol] && this.state.positions[symbol].status !== 'closed') continue;
        const qty = _holding_available(holding), bars = this._daily_bars(bars_by_symbol[symbol] ?? []);
        if (!qty || !bars.length || atr(bars) <= 0) { results.push(this._result(null, 'waiting', `${symbol}: settled shares and valid daily bars required`)); continue; }
        try {
          const authority = await this._delivery_authority({ symbol }, qty);
          if (authority) { results.push(authority); continue; }
          const gtts = await this.broker.call('get_gtts');
          if (gtts.some(g => this._gtt_conflict(g, symbol))) { results.push(this._result(null, 'blocked', `${symbol}: existing external GTT needs review`, true)); continue; }
          if (account.orders.some(o => matchesSymbol(o, symbol) && o.product === 'CNC' && !TERMINAL.has(o.status))) { results.push(this._result(null, 'blocked', `${symbol}: external CNC order needs review`, true)); continue; }
        } catch { results.push(this._result(null, 'blocked', `${symbol}: delivery preflight unavailable`, true)); continue; }
        const tick = Number(quotes_by_symbol?.[symbol]?.tick_size ?? 0.05);
        const p = { symbol, source: 'existing', quantity: qty, requested_quantity: qty,
          token: holding.instrument_token ?? 0, sold_quantity: 0, entry_price: Number(holding.average_price ?? 0), tick_size: tick,
          stop: _price(Math.max(tick, Math.max(...bars.slice(-20).map(b => b.close)) - 3 * atr(bars)), tick),
          target: null, exit_intents: [], gtt_order_ids: [], created_at: stamp(), status: 'managing', blocked: false, reason: 'Existing holding selected for management' };
        this._archive(this.state.positions[symbol]);
        this.state.positions[symbol] = p;
        this._save();
      }
      return null;
    });
    if (unavailable) return unavailable;
    // Public methods use the same mutex. Evaluate outside its critical section.
    for (const [symbol, p] of Object.entries(this.state.positions)) {
      if (p.status === 'closed' || p.source === 'existing' && !allowed(symbol)) continue;
      const bars = this._daily_bars(bars_by_symbol[symbol] ?? []);
      if (!bars.length || atr(bars) <= 0) { results.push(this._result(null, 'waiting', `${symbol}: valid completed daily bars required`)); continue; }
      const trailing = _price(Math.max(p.trailing_stop ?? p.stop ?? 0, Math.max(...bars.slice(-20).map(b => b.close)) - 3 * atr(bars)), p.tick_size);
      p.trailing_stop = trailing;
      this._save();
      const average20 = mean(bars.slice(-20).map(b => b.close));
      const trend_exit = bars.at(-1).close < average20 && mean(bars.slice(-5).map(b => b.close)) < average20;
      try {
        let quote = this._quote_hint(quotes_by_symbol?.[symbol]);
        quote ??= (await this.broker.call('quote', ['NSE:' + symbol]))['NSE:' + symbol] ?? {};
        const price = Number(quote.last_price ?? 0);
        if (!Number.isFinite(price) || price <= 0 || !this._fresh_quote(quote)) throw new Error('No fresh current quote');
        if (trend_exit || price <= trailing || p.exit_requested) {
          const bid = Number(quote.depth?.buy?.[0]?.price || 0);
          if (bid <= 0) throw new Error('No executable bid');
          results.push(await this.request_exit(symbol, Math.max(1, p.quantity - (p.sold_quantity ?? 0)), bid, trend_exit ? 'Daily trend loss' : 'Daily ATR trailing exit'));
        } else results.push(await this.lock.run(async () => this._reconcile_position(p, await this._safe_account())));
        if (!results.at(-1).blocked && results.at(-1).status !== 'authorization_required') evaluated_symbols.add(symbol);
      } catch { results.push(this._result(null, 'blocked', `${symbol}: quote/exit evaluation failed`, true)); }
    }
    const blocked = results.some(r => r.blocked);
    return { status: blocked ? 'blocked' : results.some(r => r.status === 'authorization_required') ? 'authorization_required' : 'ready', blocked, reason: '', results, evaluated_symbols: [...evaluated_symbols].sort() };
  }
}
