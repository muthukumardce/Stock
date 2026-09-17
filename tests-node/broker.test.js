import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {KiteBroker, BrokerError, jsonable, parseInstruments} from '../src/broker.js';

const success = data => ({ok: true, status: 200, json: async () => ({status: 'success', data})});
function fixture(handler = () => success({})) {
  let now = 100;
  const requests = [];
  const broker = new KiteBroker('private-key', 'private-token', {
    clock: () => now,
    sleep: async ms => { now += ms / 1000; },
    fetch: async (url, options) => { requests.push({url: new URL(url), options, at: now}); return handler(url, options); },
  });
  return {broker, requests};
}

test('REST requests are serialized with independent quote rate limiting', async () => {
  const {broker, requests} = fixture();
  await Promise.all([broker.call('quote', ['NSE:INFY']), broker.call('holdings'), broker.call('quote', ['NSE:TCS']), broker.call('orders')]);
  assert.equal(requests.length, 4);
  for (let i = 1; i < requests.length; i++) assert(requests[i].at - requests[i - 1].at >= 0.36 - 1e-10);
  assert(requests[2].at - requests[0].at >= 1.05 - 1e-10);
  assert.equal(requests[0].options.headers.Authorization, 'token private-key:private-token');
  assert.equal(requests[0].options.redirect, 'error');
});

test('historical timestamps use exchange time regardless of host timezone', async () => {
  const {broker, requests} = fixture(() => success({candles: [['2026-09-17T09:15:00+0530', 100, 101, 99, 100.5, 50]]}));
  const rows = await broker.call('historical_data', 123, new Date('2026-09-17T03:45:00Z'), new Date('2026-09-17T04:45:00Z'), '5minute');
  assert.equal(requests[0].url.searchParams.get('from'), '2026-09-17 09:15:00');
  assert.equal(requests[0].url.searchParams.get('to'), '2026-09-17 10:15:00');
  assert.equal(rows[0].date.toISOString(), '2026-09-17T03:45:00.000Z');
  assert.equal(rows[0].close, 100.5);
});

test('quote query repeats i and keeps missing instruments absent', async () => {
  const {broker, requests} = fixture(() => success({'NSE:INFY': {timestamp: '2026-09-17 10:15:00', last_price: 100}}));
  const data = await broker.call('quote', ['NSE:INFY', 'NSE:TCS']);
  assert.deepEqual(requests[0].url.searchParams.getAll('i'), ['NSE:INFY', 'NSE:TCS']);
  assert.equal(data['NSE:TCS'], undefined);
  await assert.rejects(broker.call('quote', Array(501).fill('NSE:INFY')), BrokerError);
  assert.equal(requests.length, 1);
});

test('cover entry and cancel map to protected broker routes without independent sells', async () => {
  const {broker, requests} = fixture(() => success({order_id: '123'}));
  assert.equal(await broker.buy_cover('INFY', 10, 100, 98, 'sp-test'), '123');
  const buy = requests[0];
  assert.equal(buy.url.pathname, '/orders/co');
  const body = new URLSearchParams(buy.options.body);
  assert.equal(body.get('transaction_type'), 'BUY');
  assert.equal(body.get('trigger_price'), '98');
  assert.equal(body.get('product'), 'MIS');
  assert.equal(body.get('variety'), null);
  await broker.cancel_cover('child', 'parent');
  assert.equal(requests[1].options.method, 'DELETE');
  assert.equal(requests[1].url.pathname, '/orders/co/child');
  assert.equal(requests[1].url.searchParams.get('parent_order_id'), 'parent');
});

test('GTT payload matches condition and orders schema and preserves trigger ID response', async () => {
  const {broker, requests} = fixture(() => success({trigger_id: 987}));
  const orders = [{exchange: 'NSE', tradingsymbol: 'INFY', transaction_type: 'SELL', quantity: 1, order_type: 'LIMIT', product: 'CNC', price: 98}];
  const response = await broker.call('place_gtt', {trigger_type: 'single', exchange: 'NSE', tradingsymbol: 'INFY', trigger_values: [98.5], last_price: 100, orders});
  assert.deepEqual(response, {trigger_id: 987});
  const body = new URLSearchParams(requests[0].options.body);
  assert.equal(body.get('type'), 'single');
  assert.deepEqual(JSON.parse(body.get('condition')), {exchange: 'NSE', tradingsymbol: 'INFY', trigger_values: [98.5], last_price: 100});
  assert.deepEqual(JSON.parse(body.get('orders')), orders);
});

test('holdings authorisation sends ordered repeated ISIN/quantity pairs and returns only a request ID', async () => {
  const {broker, requests} = fixture(() => success({request_id: 'na8QgCeQm05UHG6NL9sAGRzdfSF64UdB', ignored: 'value'}));
  const response = await broker.call('authorise_holdings', {instruments: [
    {isin: 'INE002A01018', quantity: 50},
    {isin: 'INE009A01021', quantity: 12},
  ]});
  assert.deepEqual(response, {request_id: 'na8QgCeQm05UHG6NL9sAGRzdfSF64UdB'});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.href, 'https://api.kite.trade/portfolio/holdings/authorise');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual([...new URLSearchParams(requests[0].options.body)], [
    ['isin', 'INE002A01018'], ['quantity', '50'], ['isin', 'INE009A01021'], ['quantity', '12'],
  ]);
});

test('holdings authorisation rejects invalid or ambiguous selections before making a broker request', async () => {
  const {broker, requests} = fixture();
  const valid = {isin: 'INE002A01018', quantity: 1};
  const invalid = [
    undefined, {}, {instruments: []}, {instruments: Array(101).fill(valid)},
    {instruments: [null]}, {instruments: ['INE002A01018']},
    ...['', 'INE002A0101', 'ine002a01018', 'INE002A0101X', 'IN&002A01018'].map(isin => ({instruments: [{isin, quantity: 1}]})),
    ...[0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', true].map(quantity => ({instruments: [{...valid, quantity}]})),
    {instruments: [valid, valid]}, {instruments: [valid, {...valid, quantity: 0}]},
    {instruments: [{...valid, tpin: 'not-accepted'}]}, {instruments: [valid], otp: 'not-accepted'},
  ];
  for (const payload of invalid) {
    await assert.rejects(broker.call('authorise_holdings', payload), error => error instanceof BrokerError && error.kind === 'TypeError');
  }
  assert.equal(requests.length, 0);
});

test('holdings authorisation accepts its 100-instrument bound and shares the REST rate gate', async () => {
  const {broker, requests} = fixture(() => success({request_id: 'request-100'}));
  const instruments = Array.from({length: 100}, (_, i) => ({isin: `IN${String(i).padStart(9, '0')}0`, quantity: i + 1}));
  await Promise.all([broker.call('authorise_holdings', {instruments}), broker.call('holdings')]);
  const body = new URLSearchParams(requests[0].options.body);
  assert.equal(body.getAll('isin').length, 100);
  assert.equal(body.getAll('quantity').at(-1), '100');
  assert(requests[1].at - requests[0].at >= 0.36 - 1e-10);
});

test('holdings authorisation rejects malformed acknowledgements without retrying', async () => {
  for (const data of [{}, {request_id: null}, {request_id: 123}, {request_id: ''}, {request_id: ' bad '}, {request_id: 'bad\nrequest'}]) {
    const {broker, requests} = fixture(() => success(data));
    await assert.rejects(broker.call('authorise_holdings', {instruments: [{isin: 'INE002A01018', quantity: 1}]}),
      error => error instanceof BrokerError && /request ID/.test(error.detail));
    assert.equal(requests.length, 1);
  }
});

test('holdings authorisation network failure is not automatically retried', async () => {
  const {broker, requests} = fixture(() => { throw new Error('Connection closed before acknowledgement'); });
  await assert.rejects(broker.call('authorise_holdings', {instruments: [{isin: 'INE002A01018', quantity: 1}]}), BrokerError);
  assert.equal(requests.length, 1);
});

test('ambiguous mutations are not retried and errors redact credentials and URLs', async () => {
  const {broker, requests} = fixture(() => { throw new Error('Lost response private-key private-token https://api.kite.trade?access_token=private-token'); });
  await assert.rejects(broker.call('place_order', {variety: 'regular', tradingsymbol: 'INFY'}), error => {
    assert.equal(error.kind, 'Error');
    assert(!error.detail.includes('private-key'));
    assert(!error.detail.includes('private-token'));
    assert(!error.detail.includes('https://'));
    return true;
  });
  assert.equal(requests.length, 1);
});

test('API error types survive without raw server message in public error text', async () => {
  const {broker} = fixture(() => ({ok: false, status: 403, json: async () => ({status: 'error', error_type: 'TokenException', message: 'private-token expired'})}));
  await assert.rejects(broker.call('profile'), error => {
    assert.equal(error.kind, 'TokenException');
    assert.equal(error.http_status, 403);
    assert.equal(error.auth_required, false);
    assert.equal(error.detail, '[redacted] expired');
    assert(!error.message.includes('expired'));
    return true;
  });
});

test('verified Kite HTTP 428 rejection retains authorization metadata through redaction', async () => {
  const {broker, requests} = fixture(() => ({ok: false, status: 428, json: async () => ({
    status: 'error', error_type: 'InputException', message: 'Holdings require authorisation private-token', data: null,
  })}));
  await assert.rejects(broker.call('place_order', {variety: 'regular', tradingsymbol: 'INFY'}), error => {
    assert.equal(error.kind, 'InputException');
    assert.equal(error.http_status, 428);
    assert.equal(error.auth_required, true);
    assert.equal(error.detail, 'Holdings require authorisation [redacted]');
    return true;
  });
  assert.equal(requests.length, 1);
});

test('HTTP 428 is not definitive authorization rejection with malformed data or any mutation acknowledgement', async () => {
  const normalError = {status: 'error', error_type: 'InputException', message: 'Authorisation required'};
  const cases = [
    {}, [], {...normalError, status: 'success'}, {...normalError, message: null},
    {...normalError, error_type: null}, {...normalError, error_type: 'bad kind'},
    {...normalError, order_id: 'accepted'}, {...normalError, data: {order_id: 'accepted'}},
    {...normalError, data: {trigger_id: 123}},
  ];
  for (const body of cases) {
    const {broker, requests} = fixture(() => ({ok: false, status: 428, json: async () => body}));
    await assert.rejects(broker.call('place_order', {variety: 'regular'}), error => {
      assert.equal(error.http_status, 428);
      assert.equal(error.auth_required, false);
      return true;
    });
    assert.equal(requests.length, 1);
  }
});

test('parse failures and network failures do not acquire definitive authorization metadata', async () => {
  const malformed = fixture(() => ({ok: false, status: 428, json: async () => { throw new SyntaxError('Invalid JSON'); }}));
  await assert.rejects(malformed.broker.call('place_order', {variety: 'regular'}), error => {
    assert.equal(error.http_status, 428);
    assert.equal(error.auth_required, false);
    return true;
  });
  const disconnected = fixture(() => { throw Object.assign(new Error('Connection lost'), {http_status: 428, auth_required: true}); });
  await assert.rejects(disconnected.broker.call('place_order', {variety: 'regular'}), error => {
    assert.equal(error.http_status, null);
    assert.equal(error.auth_required, false);
    return true;
  });
  assert.equal(malformed.requests.length, 1);
  assert.equal(disconnected.requests.length, 1);
});

test('an incomplete successful order response remains ambiguous and is never retried', async () => {
  const {broker, requests} = fixture(() => success({}));
  await assert.rejects(broker.buy_cover('INFY', 1, 100, 98, 'sp-test'), error => {
    assert.equal(error.kind, 'Error');
    assert.match(error.detail, /no order ID/);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('instrument CSV handles quoted names and numeric identifiers', async () => {
  const csv = 'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\r\n123,1,TEST,"ACME, ""INDIA""",100,,0,0.05,1,EQ,NSE,NSE\r\n';
  const data = parseInstruments(csv);
  assert.equal(data[0].name, 'ACME, "INDIA"');
  assert.equal(data[0].instrument_token, 123);
  assert.equal(data[0].tick_size, 0.05);
  const {broker} = fixture(() => ({ok: true, status: 200, text: async () => csv}));
  assert.deepEqual(await broker.call('instruments', 'NSE'), data);
});

test('JSON conversion strips nested secret fields and preserves date instants', () => {
  assert.deepEqual(jsonable({api_key: 'a', child: [{password: 'x', time: new Date('2026-09-17T00:00:00Z')}]}),
    {child: [{time: '2026-09-17T00:00:00.000Z'}]});
});

test('up to three socket workers isolate subscriptions and close suppresses stale events', async () => {
  const workers = [], statuses = [], ticks = [], orders = [];
  class FakeWorker extends EventEmitter {
    async terminate() { this.terminated = true; this.emit('exit', 1); }
  }
  const broker = new KiteBroker('key', 'token', {workerFactory: (url, options) => {
    const worker = new FakeWorker(); worker.url = url; worker.data = options.workerData; workers.push(worker); return worker;
  }});
  await broker.stream(Array.from({length: 7000}, (_, i) => i + 1), value => ticks.push(value), value => orders.push(value), (...args) => statuses.push(args));
  assert.deepEqual(workers.map(worker => worker.data.tokens.length), [3000, 3000, 1000]);
  workers[1].emit('message', {type: 'status', connected: true});
  assert.equal(statuses[0][0], 1);
  assert.equal(statuses[0][2][0], 3001);
  workers[0].emit('message', {type: 'ticks', ticks: [{instrument_token: 1}]});
  workers[0].emit('message', {type: 'order', order: {order_id: '1', access_token: 'private'}});
  assert.deepEqual(ticks, [[{instrument_token: 1}]]);
  assert.deepEqual(orders, [{order_id: '1'}]);
  await broker.close();
  workers[0].emit('message', {type: 'status', connected: true});
  assert.equal(statuses.length, 1);
  assert(workers.every(worker => worker.terminated));
  await assert.rejects(broker.stream(Array(9001).fill(1), () => {}, () => {}, () => {}), /9,000/);
});
