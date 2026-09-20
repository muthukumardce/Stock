import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {KiteBroker, BrokerError, jsonable, parseInstruments, orderRejectionReason} from '../src/broker.js';

test('order rejection explanations classify broker restrictions without copying private broker messages',()=>{
  for(const [kind,detail,code] of [
    ['PermissionException','IP is not whitelisted','ip_not_allowed'],
    ['PermissionException','This operation is not permitted','permission_denied'],
    ['PermissionException','CO orders are blocked for this instrument','cover_unavailable'],
    ['InputException','Insufficient funds for this order','insufficient_margin'],
    ['InputException','Trigger price is outside the allowed range','invalid_trigger'],
    ['TokenException','Session expired','session_expired'],
    ['InputException','Unexpected rejection','order_rejected'],
  ]){
    const reason=orderRejectionReason(new BrokerError(kind,detail+' private-key private-token https://broker.invalid',{http_status:403}));
    assert.equal(reason.code,code);assert.doesNotMatch(JSON.stringify(reason),/private-key|private-token|broker.invalid/);
  }
});

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

test('fractional and invalid share quantities never reach broker order or GTT endpoints', async () => {
  const {broker, requests} = fixture(() => success({order_id:'whole-share-order',trigger_id:1}));
  for (const quantity of [0.5, 2.75, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined]) {
    const operations = [
      () => broker.buy_cover('INFY', quantity, 100, 98, 'whole-shares'),
      () => broker.sell_cover('INFY', quantity, 100, 102, 'whole-shares'),
      () => broker.call('place_order', {variety:'regular',transaction_type:'BUY',quantity}),
      () => broker.call('modify_order', {variety:'regular',order_id:'existing',quantity}),
      ...['place_gtt','modify_gtt'].map(method => () => broker.call(method, {trigger_id:1,orders:[{quantity:1},{quantity}]})),
    ];
    for (const operation of operations) await assert.rejects(operation(), error => {
      assert.equal(error.definitive_rejection,true);
      assert.equal(error.local_rejection,true);assert.equal(error.http_status,null,'A local rejection must not invent a broker HTTP response');
      assert.equal(orderRejectionReason(error).code,'invalid_quantity');
      return true;
    });
  }
  assert.equal(requests.length,0);
  assert.equal(await broker.buy_cover('INFY',2,100,98,'whole-shares'),'whole-share-order');
  assert.equal(new URLSearchParams(requests[0].options.body).get('quantity'),'2');
  await broker.call('modify_order',{variety:'regular',order_id:'existing',price:101});
  assert.equal(requests.length,2,'A price-only modification preserves the existing quantity');
});

test('REST requests are serialized with independent quote rate limiting', async () => {
  const {broker, requests} = fixture();
  await Promise.all([broker.call('quote', ['NSE:INFY']), broker.call('holdings'), broker.call('quote', ['NSE:TCS']), broker.call('orders')]);
  assert.equal(requests.length, 4);
  for (let i = 1; i < requests.length; i++) assert(requests[i].at - requests[i - 1].at >= 0.36 - 1e-10);
  assert(requests[2].at - requests[0].at >= 1.05 - 1e-10);
  assert.equal(requests[0].options.headers.Authorization, 'token private-key:private-token');
  assert.equal(requests[0].options.redirect, 'error');
});

const historicalArgs = [123, '2026-09-16T09:15:00+05:30', '2026-09-17T09:15:00+05:30', '5minute'];
function rateFixture(handler) {
  let now = 100, wall = Date.parse('2026-09-17T06:30:00Z');
  const requests = [], sleeps = [];
  const advance = seconds => {now += seconds;wall += seconds * 1000;};
  const broker = new KiteBroker('private-key', 'private-token', {clock: () => now, wallClock: () => wall,
    sleep: async ms => {sleeps.push(ms);advance(ms / 1000);},
    fetch: async (url, options) => {requests.push({url: new URL(url), options, at: now});return handler(url, options, requests.length);},
  });
  return {broker, requests, sleeps, advance, jump: seconds => {wall += seconds * 1000;}};
}
function limitedResponse({retryAfter = null, date = null, nonJSON = false} = {}) {
  return {ok: false, status: 429, headers: {get: name => name === 'retry-after' ? retryAfter : name === 'date' ? date : null},
    json: async () => {if (nonJSON) throw new Error('private-token HTML response');return {status:'error',error_type:'GeneralException',message:'private-token exceeded requests'};},
  };
}

test('HTTP 429 remains a typed rate limit with safe retry metadata even when the response is not JSON', async () => {
  for (const nonJSON of [false, true]) {
    const f = rateFixture(() => limitedResponse({retryAfter:'17',nonJSON}));
    await assert.rejects(f.broker.call('historical_data', ...historicalArgs), error => {
      assert.equal(error.http_status,429);assert.equal(error.rate_limited,true);assert.equal(error.rate_limit_category,'historical');
      assert.equal(error.retry_after_seconds,17);assert.ok(Number.isFinite(Date.parse(error.retry_at)));
      assert.equal(error.definitive_rejection,false);assert.doesNotMatch(error.message,/private-token|HTML/);return true;
    });
    assert.equal(f.requests.length,1,'No automatic replay occurs');
    const health=f.broker.rate_limit_health();assert.equal(health.status,'cooldown');assert.equal(health.total_rate_limited_responses,1);
    assert.equal(health.categories.find(item=>item.category==='historical').retry_after_seconds,17);
    assert.doesNotMatch(JSON.stringify(health),/private-key|private-token|api.kite/);
  }
});

test('shared historical cooldown rejects queued and new downloads without delaying account or order protection', async () => {
  const f=rateFixture(url=>url.includes('/historical/')?limitedResponse({retryAfter:'120'}):success({order_id:'protected-order'}));
  const result=await Promise.allSettled([
    f.broker.call('historical_data',...historicalArgs),f.broker.call('historical_data',...historicalArgs),
    f.broker.call('holdings'),f.broker.call('cancel_order',{variety:'regular',order_id:'protect-order'}),
  ]);
  assert.deepEqual(result.map(item=>item.status),['rejected','rejected','fulfilled','fulfilled']);
  assert.equal(result[1].reason.rate_limit_category,'historical');
  await assert.rejects(f.broker.call('historical_data',...historicalArgs),error=>error.http_status===429);
  assert.equal(f.requests.length,3);assert.ok(f.sleeps.every(ms=>ms<=361),'No cooldown sleep may occupy the common REST queue');
  const health=f.broker.rate_limit_health().categories.find(item=>item.category==='historical');
  assert.equal(health.rate_limited_responses,1);assert.equal(health.blocked_requests,2);
});

test('Retry-After supports bounded seconds and broker-relative HTTP dates despite a skewed local clock', async () => {
  for(const [retryAfter,expected] of [['0',1],['999999',86400],['invalid',30],['-1',30],[null,30]]) {
    const f=rateFixture(()=>limitedResponse({retryAfter}));
    await assert.rejects(f.broker.call('profile'),error=>error.retry_after_seconds===expected);
  }
  const date='Thu, 17 Sep 2026 06:33:43 GMT',retryAfter='Thu, 17 Sep 2026 06:34:28 GMT';
  const f=rateFixture(()=>limitedResponse({date,retryAfter}));
  await assert.rejects(f.broker.call('quote',['NSE:INFY']),error=>error.retry_after_seconds===45&&error.rate_limit_category==='quote');
  f.jump(-3600);assert.equal(f.broker.rate_limit_health().categories.find(item=>item.category==='quote').retry_after_seconds,45);
  f.advance(45);assert.equal(f.broker.rate_limit_health().status,'ready');
});

test('explicit Retry-After longer than the fallback cap prevents requests for its full duration', async () => {
  let limited=true;
  const f=rateFixture(()=>limited?limitedResponse({retryAfter:'600'}):success({candles:[]}));
  await assert.rejects(f.broker.call('historical_data',...historicalArgs),error=>error.retry_after_seconds===600);
  limited=false;f.advance(300);
  await assert.rejects(f.broker.call('historical_data',...historicalArgs),error=>error.retry_after_seconds===300);
  assert.equal(f.requests.length,1);
  f.advance(299);await assert.rejects(f.broker.call('historical_data',...historicalArgs),error=>error.retry_after_seconds===1);
  assert.equal(f.requests.length,1);
  f.advance(1);await f.broker.call('historical_data',...historicalArgs);assert.equal(f.requests.length,2);
});

test('repeated throttling backs off within bounds and only successful calls reset the category backoff', async () => {
  let fail=true;const f=rateFixture(()=>fail?limitedResponse():success({candles:[]}));
  for(const expected of [30,60,120,240,300]){
    await assert.rejects(f.broker.call('historical_data',...historicalArgs),error=>error.retry_after_seconds===expected);
    f.advance(expected);
  }
  fail=false;await f.broker.call('historical_data',...historicalArgs);fail=true;
  await assert.rejects(f.broker.call('historical_data',...historicalArgs),error=>error.retry_after_seconds===30);
  assert.equal(f.broker.rate_limit_health().total_rate_limited_responses,6);
});

test('rate limited order mutations are never replayed and malformed acknowledgements stay ambiguous', async () => {
  const f=rateFixture(()=>limitedResponse({retryAfter:'60',nonJSON:true}));
  await assert.rejects(f.broker.call('place_order',{variety:'regular',tradingsymbol:'INFY',quantity:1}),error=>error.http_status===429&&error.rate_limit_category==='orders'&&!error.definitive_rejection);
  await assert.rejects(f.broker.call('modify_order',{variety:'regular',order_id:'existing',price:100}),error=>error.http_status===429);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.method,'POST');
  f.advance(60);assert.equal(f.requests.length,1,'Cooldown expiration must not automatically replay a mutation');
});

function clockFixture() {
  let wall = Date.parse('2026-09-17T06:30:00Z'), mono = 100, requests = 0;
  let sample = { offset: 0, latency: 200, jump: 0 };
  const advance = ms => { wall += ms; mono += ms / 1000; };
  const broker = new KiteBroker('key', 'token', {
    clock: () => mono, wallClock: () => wall, sleep: async ms => advance(ms),
    fetch: async () => {
      requests++;
      const date = Object.hasOwn(sample, 'header') ? sample.header : new Date(wall + sample.latency / 2 + sample.offset).toUTCString();
      advance(sample.latency); wall += sample.jump;
      return { ...success({}), headers: { get: name => name.toLowerCase() === 'date' ? date : null } };
    },
  });
  return { broker, advance, set: value => { sample = { offset: 0, latency: 200, jump: 0, ...value }; },
    jump: ms => { wall += ms; }, get requests() { return requests; } };
}

test('broker clock health bounds positive and negative skew using response Date and both request endpoints', async () => {
  for (const offset of [223000, -223000]) {
    const f = clockFixture(); f.set({ offset });
    assert.equal(f.broker.clock_health().status, 'unknown');
    await f.broker.call('profile');
    const health = f.broker.clock_health();
    assert.equal(health.status, 'skewed'); assert.equal(health.blocked, true);
    assert.ok(health.offset_lower_ms <= offset && health.offset_upper_ms >= offset);
    assert.ok(offset > 0 ? health.offset_lower_ms > 10000 : health.offset_upper_ms < -10000);
    assert.equal(health.offset_upper_ms - health.offset_lower_ms, 2200);
    assert.ok(Math.abs(health.request_duration_ms - 200) < 1e-8);
    assert.equal(health.age_seconds, 0); assert.equal(health.stale, false);
    for (let i = 0; i < 5; i++) f.broker.clock_health();
    assert.equal(f.requests, 1, 'Reading health must not issue HTTP requests');
  }
});

test('clock bounds include Date precision and do not confirm skew when request latency spans the tolerance', async () => {
  const f = clockFixture(); f.set({ offset: 10000, latency: 6000 });
  await f.broker.call('profile');
  let health = f.broker.clock_health();
  assert.equal(health.status, 'uncertain'); assert.equal(health.blocked, false);
  assert.deepEqual([health.offset_lower_ms, health.offset_upper_ms], [6000, 14000]);
  f.set({ offset: 0 }); await f.broker.call('profile');
  health = f.broker.clock_health();
  assert.equal(health.status, 'aligned'); assert.equal(health.blocked, false);
  assert.ok(health.offset_lower_ms <= 0 && health.offset_upper_ms >= 0);
});

test('missing or malformed dates cannot invent alignment or clear a confirmed clock skew', async () => {
  const f = clockFixture();
  for (const header of [null, '', 'not a date', '2026-09-17T06:30:00Z', 'Thu, 31 Sep 2026 06:30:00 GMT', 'Fri, 17 Sep 2026 06:30:00 GMT']) {
    f.set({ header }); await f.broker.call('profile');
    assert.equal(f.broker.clock_health().status, 'unknown');
    assert.equal(f.broker.clock_health().blocked, false);
  }
  f.set({ offset: 223000 }); await f.broker.call('profile');
  const confirmed = f.broker.clock_health();
  for (const sample of [{ header: null }, { header: 'invalid' }, { offset: 10000, latency: 6000 }]) {
    f.set(sample); await f.broker.call('profile');
    const health = f.broker.clock_health();
    assert.equal(health.status, 'skewed'); assert.equal(health.blocked, true);
    assert.equal(health.offset_lower_ms, confirmed.offset_lower_ms);
    assert.equal(health.offset_upper_ms, confirmed.offset_upper_ms);
  }
  f.set({ offset: 0 }); await f.broker.call('profile');
  assert.equal(f.broker.clock_health().status, 'aligned'); assert.equal(f.broker.clock_health().blocked, false);
});

test('clock evidence age uses monotonic time and stale evidence never silently clears skew', async () => {
  const f = clockFixture(); await f.broker.call('profile');
  f.advance(61000);
  let health = f.broker.clock_health();
  assert.equal(health.status, 'uncertain'); assert.equal(health.stale, true);
  assert.ok(Math.abs(health.age_seconds - 61) < 1e-8); assert.equal(health.blocked, false);
  f.set({ offset: -223000 }); await f.broker.call('profile'); f.advance(61000);
  health = f.broker.clock_health();
  assert.equal(health.status, 'skewed'); assert.equal(health.stale, true); assert.equal(health.blocked, true);
  f.set({ offset: 0 }); await f.broker.call('profile');
  health = f.broker.clock_health();
  assert.equal(health.status, 'aligned'); assert.equal(health.stale, false); assert.equal(health.age_seconds, 0);
});

test('wall-clock jumps during a request invalidate its observation without clearing prior confirmed skew', async () => {
  for (const jump of [-223000, 223000]) {
    const f = clockFixture(); f.set({ jump }); await f.broker.call('profile');
    let health = f.broker.clock_health();
    assert.equal(health.status, 'uncertain'); assert.equal(health.last_observation_status, 'wall_clock_changed');
    assert.equal(health.blocked, false); assert.equal(health.offset_lower_ms, null);
    f.set({ offset: 223000 }); await f.broker.call('profile');
    assert.equal(f.broker.clock_health().blocked, true);
    f.set({ jump }); await f.broker.call('profile');
    health = f.broker.clock_health();
    assert.equal(health.status, 'skewed'); assert.equal(health.blocked, true);
    assert.equal(health.last_observation_status, 'wall_clock_changed');
    f.set({ offset: 0 }); await f.broker.call('profile');
    assert.equal(f.broker.clock_health().status, 'aligned');
  }
});

test('a host-clock change after an aligned response is visible until a new valid observation', async () => {
  const f = clockFixture(); await f.broker.call('profile');f.jump(223000);
  assert.equal(f.broker.clock_health().status, 'uncertain');
  assert.equal(f.broker.clock_health().last_observation_status, 'wall_clock_changed');
  assert.equal(f.broker.clock_health().age_seconds, 0);
  f.set({ offset: 0 }); await f.broker.call('profile');
  assert.equal(f.broker.clock_health().status, 'aligned');
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

test('short cover uses SELL with a buy-stop trigger above entry through the same protected route',async()=>{
  const {broker,requests}=fixture(()=>success({order_id:'short-parent'}));
  assert.equal(await broker.sell_cover('INFY',10,100,102,'short-test'),'short-parent');
  const body=new URLSearchParams(requests[0].options.body);
  assert.equal(requests[0].url.pathname,'/orders/co');assert.equal(body.get('transaction_type'),'SELL');assert.equal(body.get('trigger_price'),'102');assert.equal(body.get('price'),'100');assert.equal(body.get('product'),'MIS');
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
  await assert.rejects(broker.call('place_order', {variety: 'regular', tradingsymbol: 'INFY', quantity: 1}), error => {
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
    assert.equal(error.definitive_rejection, true);
    assert.equal(error.detail, '[redacted] expired');
    assert(!error.message.includes('expired'));
    return true;
  });
});

test('cover response with an acknowledgement never acquires definitive rejection, even with a familiar exception name', async () => {
  for (const status of [400, 428, 500]) for (const acknowledgement of [
    {order_id: 'accepted-parent'}, {data: {order_id: 'accepted-parent'}},
    {trigger_id: 123}, {data: {trigger_id: 123}},
  ]) {
    const {broker, requests} = fixture(() => ({ok: false, status, json: async () => ({
      status: 'error', error_type: 'InputException', message: 'Contradictory response', ...acknowledgement,
    })}));
    await assert.rejects(broker.buy_cover('INFY', 1, 100, 98, 'review-intent'), error => {
      assert.equal(error.kind, 'InputException');
      assert.equal(error.definitive_rejection, false);
      assert.equal(error.auth_required, false);
      return true;
    });
    assert.equal(requests.length, 1);
  }
});

test('definitive rejection requires a verified client precondition response, not merely a kind string', async () => {
  const valid = {status: 'error', error_type: 'InputException', message: 'Invalid trigger price'};
  const cases = [
    ...[200, 302, 408, 500, 502, 503, 504].map(status => ({status, body: valid})),
    ...[{}, [], {...valid, status: 'success'}, {...valid, message: ''}, {...valid, message: null},
      {...valid, data: []}, {...valid, data: 'unexpected'},
      ...['NetworkException', 'DataException', 'GeneralException', 'OrderException', 'unknown kind'].map(error_type => ({...valid, error_type})),
    ].map(body => ({status: 400, body})),
  ];
  for (const {status, body} of cases) {
    const {broker, requests} = fixture(() => ({ok: status >= 200 && status < 300, status, json: async () => body}));
    await assert.rejects(broker.buy_cover('INFY', 1, 100, 98, 'review-intent'), error => error.definitive_rejection === false);
    assert.equal(requests.length, 1);
  }
  for (const [status, error_type] of [[400, 'InputException'], [403, 'TokenException'], [403, 'PermissionException'], [428, 'InputException'], [429, 'InputException']]) {
    const {broker, requests} = fixture(() => ({ok: false, status, json: async () => ({...valid, error_type, data: null})}));
    await assert.rejects(broker.buy_cover('INFY', 1, 100, 98, 'review-intent'), error => error.definitive_rejection === true);
    assert.equal(requests.length, 1);
  }
});

test('verified Kite HTTP 428 rejection retains authorization metadata through redaction', async () => {
  const {broker, requests} = fixture(() => ({ok: false, status: 428, json: async () => ({
    status: 'error', error_type: 'InputException', message: 'Holdings require authorisation private-token', data: null,
  })}));
  await assert.rejects(broker.call('place_order', {variety: 'regular', tradingsymbol: 'INFY', quantity: 1}), error => {
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
    await assert.rejects(broker.call('place_order', {variety: 'regular', quantity: 1}), error => {
      assert.equal(error.http_status, 428);
      assert.equal(error.auth_required, false);
      return true;
    });
    assert.equal(requests.length, 1);
  }
});

test('parse failures and network failures do not acquire definitive authorization metadata', async () => {
  const malformed = fixture(() => ({ok: false, status: 428, json: async () => { throw new SyntaxError('Invalid JSON'); }}));
  await assert.rejects(malformed.broker.call('place_order', {variety: 'regular', quantity: 1}), error => {
    assert.equal(error.http_status, 428);
    assert.equal(error.auth_required, false);
    return true;
  });
  const disconnected = fixture(() => { throw Object.assign(new Error('Connection lost'), {http_status: 428, auth_required: true}); });
  await assert.rejects(disconnected.broker.call('place_order', {variety: 'regular', quantity: 1}), error => {
    assert.equal(error.http_status, null);
    assert.equal(error.auth_required, false);
    assert.equal(error.definitive_rejection, false);
    return true;
  });
  assert.equal(malformed.requests.length, 1);
  assert.equal(disconnected.requests.length, 1);
});

test('a transport error cannot forge a definitive precondition rejection flag', async () => {
  const {broker, requests} = fixture(() => { throw Object.assign(new Error('Transport failed'), {
    kind: 'InputException', http_status: 400, definitive_rejection: true,
  }); });
  await assert.rejects(broker.buy_cover('INFY', 1, 100, 98, 'review-intent'), error => {
    assert.equal(error.kind, 'InputException');
    assert.equal(error.http_status, null);
    assert.equal(error.definitive_rejection, false);
    return true;
  });
  assert.equal(requests.length, 1);
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

test('a failed feed worker retires once and restores only its original subscription with backoff',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const workers=[],statuses=[],ticks=[];let now=0;
  class FakeWorker extends EventEmitter {async terminate(){this.terminated=true;this.emit('exit',1);}}
  const broker=new KiteBroker('key','token',{clock:()=>now,workerFactory:(_url,options)=>{const w=new FakeWorker();w.data=options.workerData;workers.push(w);return w;}});t.after(()=>broker.close());
  await broker.stream(Array.from({length:3001},(_,i)=>i+1),v=>ticks.push(v),()=>{},(...v)=>statuses.push(v));
  const failed=workers[0];failed.emit('error',new Error('synthetic worker failure'));failed.emit('exit',1);
  failed.emit('message',{type:'ticks',ticks:[{instrument_token:1}]});await Promise.all([...broker._retiringSockets]);
  assert.equal(failed.terminated,true);assert.equal(statuses.length,1);assert.equal(statuses[0][1],false);assert.deepEqual(ticks,[]);
  t.mock.timers.tick(999);assert.equal(workers.length,2);t.mock.timers.tick(1);assert.equal(workers.length,3);
  assert.deepEqual(workers[2].data.tokens,failed.data.tokens);assert.equal(broker.sockets.length,2);assert.equal(workers[1].terminated,undefined);
  workers[2].emit('message',{type:'status',connected:true});workers[2].emit('message',{type:'ticks',ticks:[{instrument_token:1}]});assert.equal(statuses.at(-1)[1],true);assert.equal(ticks.length,1);
  now=.5;workers[2].emit('message',{type:'status',connected:false});now=100;workers[2].emit('message',{type:'status',connected:true});now=100.5;
  workers[2].emit('error',new Error('second failure'));await Promise.all([...broker._retiringSockets]);t.mock.timers.tick(1999);assert.equal(workers.length,3);t.mock.timers.tick(1);assert.equal(workers.length,4);
});

test('exhausted SDK reconnection retires the isolate and closing cancels pending replacement',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const workers=[];
  class FakeWorker extends EventEmitter {async terminate(){this.terminated=true;this.emit('exit',0);}}
  const broker=new KiteBroker('key','token',{workerFactory:()=>{const w=new FakeWorker();workers.push(w);return w;}});
  await broker.stream([1],()=>{},()=>{},()=>{});workers[0].emit('message',{type:'restart'});await Promise.all([...broker._retiringSockets]);
  assert.equal(workers[0].terminated,true);await broker.close();t.mock.timers.tick(60000);assert.equal(workers.length,1);assert.equal(broker.sockets.length,0);
  await broker.stream([2],()=>{},()=>{},()=>{});workers[0].emit('message',{type:'restart'});t.mock.timers.tick(60000);assert.equal(workers.length,2);await broker.close();
});

test('feed replacement waits for confirmed worker retirement instead of exceeding socket capacity',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const workers=[];
  class FakeWorker extends EventEmitter {async terminate(){if(!this.confirmed)throw new Error('termination uncertain');this.emit('exit',1);}}
  const broker=new KiteBroker('key','token',{workerFactory:()=>{const w=new FakeWorker();workers.push(w);return w;}});t.after(()=>broker.close());
  await broker.stream([1],()=>{},()=>{},()=>{});workers[0].emit('error',new Error('synthetic failure'));await Promise.all([...broker._retiringSockets]);
  t.mock.timers.tick(120000);assert.equal(workers.length,1);assert.equal(broker.sockets.length,1);
  workers[0].confirmed=true;workers[0].emit('exit',1);t.mock.timers.tick(1000);assert.equal(workers.length,2);assert.equal(broker.sockets.length,1);workers[1].confirmed=true;
});

test('worker construction failures back off to sixty seconds and stop after broker close',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let attempts=0;
  const broker=new KiteBroker('key','token',{workerFactory:()=>{attempts++;throw new Error('Cannot create worker');}});
  await broker.stream([1],()=>{},()=>{},()=>{});assert.equal(attempts,1);
  for(const delay of [1000,2000,4000,8000,16000,32000,60000,60000]){const before=attempts;t.mock.timers.tick(delay-1);assert.equal(attempts,before);t.mock.timers.tick(1);assert.equal(attempts,before+1);}
  await broker.close();const before=attempts;t.mock.timers.tick(120000);assert.equal(attempts,before);
});

test('concurrent stream requests keep only the latest subscriptions within the three-worker limit',async()=>{
  const workers=[];class FakeWorker extends EventEmitter{async terminate(){this.terminated=true;this.emit('exit',0);}}
  const broker=new KiteBroker('key','token',{workerFactory:(_url,options)=>{const worker=new FakeWorker();worker.tokens=options.workerData.tokens;workers.push(worker);return worker;}});
  const first=Array.from({length:6000},(_,i)=>i+1),latest=first.map(i=>i+10000);
  await Promise.all([broker.stream(first,()=>{},()=>{},()=>{}),broker.stream(latest,()=>{},()=>{},()=>{})]);
  assert.equal(workers.filter(w=>!w.terminated).length,2);assert.deepEqual(broker.sockets.flatMap(w=>w.tokens),latest);await broker.close();
});

test('close cancels a stream waiting for deferred old-worker termination',async()=>{
  let release,started;const retiring=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{started=resolve;}),workers=[];
  class FakeWorker extends EventEmitter{async terminate(){started();await retiring;this.terminated=true;this.emit('exit',0);}}
  const broker=new KiteBroker('key','token',{workerFactory:()=>{const w=new FakeWorker();workers.push(w);return w;}});
  await broker.stream([1],()=>{},()=>{},()=>{});const pending=broker.stream([2],()=>{},()=>{},()=>{});await began;
  const closing=broker.close();release();await Promise.all([pending,closing]);assert.equal(workers.length,1);assert.equal(broker.sockets.length,0);
});

test('unconfirmed close retains old workers and prevents new subscriptions until they exit',async()=>{
  const workers=[];class FakeWorker extends EventEmitter{async terminate(){if(this.uncertain)throw new Error('Cannot confirm termination');this.emit('exit',0);}}
  const broker=new KiteBroker('key','token',{workerFactory:()=>{const w=new FakeWorker();w.uncertain=workers.length===0;workers.push(w);return w;}});
  await broker.stream([1],()=>{},()=>{},()=>{});await assert.rejects(broker.close(),/termination is unconfirmed/);assert.equal(broker.sockets.length,1);
  await assert.rejects(broker.stream([2],()=>{},()=>{},()=>{}),/termination is unconfirmed/);assert.equal(workers.length,1);
  workers[0].emit('exit',1);assert.equal(broker.sockets.length,0);await broker.stream([2],()=>{},()=>{},()=>{});assert.equal(workers.length,2);await broker.close();
});
