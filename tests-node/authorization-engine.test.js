import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TradingEngine } from '../src/trading.js';
import { DeliveryManager } from '../src/delivery.js';
import { HoldingsAuthorization } from '../src/holdings-authorization.js';
import { Store } from '../src/storage.js';
import { Candle, Signal } from '../src/strategy.js';
import { monotonic } from '../src/util.js';

const NOW = new Date('2026-09-17T12:00:00+05:30');
const copy = value => structuredClone(value);
class Broker {
  calls = []; orders = []; gtts = {}; netPositions = []; consent = 'consent'; price = 100; request = 0; rejectGttAuthorization = false;
  holdings = [{ exchange: 'NSE', product: 'CNC', tradingsymbol: 'TEST', instrument_token: 1, isin: 'INE002A01018', quantity: 10, used_quantity: 2, collateral_quantity: 0, average_price: 100, authorised_quantity: 0, authorised_date: '2026-09-16 00:00:00' },
    { exchange: 'NSE', product: 'CNC', tradingsymbol: 'UNSELECTED', instrument_token: 3, isin: 'INE009A01021', quantity: 40, average_price: 100 }];
  async account() {
    this.calls.push(['account']); return { orders: copy(this.orders), trades: [], holdings: copy(this.holdings), positions: this.positions(), margins: { equity: { available: { cash: 100000, live_balance: 100000 } } } };
  }
  positions() { return { net: copy(this.netPositions) }; }
  async call(method, ...args) {
    this.calls.push([method, copy(args)]);
    if (method === 'profile') return { user_id: 'AB1234', meta: { demat_consent: this.consent } };
    if (method === 'instruments') return ['TEST', 'NEW', 'UNSELECTED'].map((tradingsymbol, n) => ({ tradingsymbol, instrument_token: n + 1, exchange: 'NSE', segment: 'NSE', instrument_type: 'EQ', tick_size: .05 }));
    if (method === 'holdings') return copy(this.holdings);
    if (method === 'orders') return copy(this.orders);
    if (method === 'positions') return this.positions();
    if (method === 'historical_data') return [];
    if (method === 'order_history') return copy(this.orders.filter(o => o.order_id === String(args[0])));
    if (method === 'get_gtts') return copy(Object.values(this.gtts));
    if (method === 'get_gtt') return copy(this.gtts[args[0]]);
    if (method === 'quote') return Object.fromEntries(args[0].map(symbol => [symbol, { timestamp: NOW, last_price: this.price, depth: { buy: [{ price: this.price - .05, quantity: 10000 }] } }]));
    if (method === 'authorise_holdings') return { request_id: `request-${++this.request}` };
    if (method === 'place_order') {
      const payload = args[0], order = { ...payload, order_id: String(this.orders.length + 1), status: 'COMPLETE', filled_quantity: payload.quantity, pending_quantity: 0, average_price: payload.price };
      this.orders.push(order);
      if (payload.transaction_type === 'SELL') this.holdings.find(h => h.tradingsymbol === payload.tradingsymbol).used_quantity += payload.quantity;
      else this.netPositions.push({ exchange: 'NSE', tradingsymbol: payload.tradingsymbol, product: payload.product, quantity: payload.quantity });
      return order.order_id;
    }
    if (method === 'place_gtt') {
      if (this.rejectGttAuthorization) throw Object.assign(new Error('Broker requires renewed authorization'), { auth_required: true });
      const p = args[0], id = String(Object.keys(this.gtts).length + 1);
      this.gtts[id] = { id: Number(id), status: 'active', type: p.trigger_type, condition: { exchange: p.exchange, tradingsymbol: p.tradingsymbol, trigger_values: copy(p.trigger_values), last_price: p.last_price }, orders: copy(p.orders) };
      return { trigger_id: Number(id) };
    }
    if (method === 'delete_gtt') { this.gtts[args[0]].status = 'deleted'; return { trigger_id: Number(args[0]) }; }
    throw new Error('Unexpected simulated broker method: ' + method);
  }
  async buy_cover(symbol, quantity, price, trigger_price, tag) {
    this.calls.push(['buy_cover', { symbol, quantity }]);
    const id = 'cover-' + this.orders.length;
    this.orders.push({ order_id: id, tag, variety: 'co', transaction_type: 'BUY', exchange: 'NSE', tradingsymbol: symbol, product: 'MIS', quantity, filled_quantity: 0, pending_quantity: 0, status: 'REJECTED' });
    return id;
  }
  async cancel_cover() { this.calls.push(['cancel_cover']); }
  async stream(tokens, _ticks, _orders, status) { status(0, true, tokens); }
  close() {}
}
function bars(falling = true) {
  const dates = []; let at = new Date('2026-09-16T00:00:00+05:30');
  while (dates.length < 30) { const day = new Date(+at + 19800000).getUTCDay(); if (day && day < 6) dates.unshift(at); at = new Date(+at - 86400000); }
  const prices = dates.map((_, i) => 100 + i * .5); if (falling) prices.splice(-5, 5, 105, 104, 103, 102, 101);
  return dates.map((date, i) => new Candle(date, prices[i] - .5, prices[i] + 1, prices[i] - 1, prices[i], 1000));
}
async function fixture(t, { physical = false, selected = ['TEST'], falling = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpilot-auth-engine-')), store = new Store(path.join(directory, 'engine.sqlite')), broker = new Broker(), engines = new Set();
  if (physical) broker.consent = 'physical';
  const settings = { trading_mode: 'live', live_trading_enabled: true, data_dir: directory, kite_api_key: 'test-app-key', kite_user_id: 'AB1234', max_position_pct: .1, risk_per_trade_pct: .0025, daily_loss_pct: .01, max_positions: 5, entry_cutoff: '14:45', exit_time: '15:10', max_spread_pct: .003, min_daily_turnover: 10000 };
  store.set('strategy_settings', { intraday_enabled: true, swing_enabled: false, intraday_allocation_pct: 1, swing_allocation_pct: 0, manage_existing_holdings: 'selected', managed_symbols: selected });
  const build = () => {
    const engine = new TradingEngine(settings, store, { now: () => NOW, backgroundLoops: false, brokerFactory: () => broker,
      equityUniverse:{resolve:async instruments=>({instruments:instruments.map(i=>({...i,entry_eligible:true})),summary:{status:'verified'}})},
      analyticsFactory: () => ({ worker_limit: 1, batch_size: 32, snapshot: () => ({}), close: async () => {} }) }); engines.add(engine); return engine;
  };
  const engine = build();
  t.after(async () => { try { for (const current of engines) await current.shutdown(); } finally { store.close(); assert.ok(directory.startsWith(path.join(os.tmpdir(), 'stockpilot-auth-engine-'))); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); } });
  const warm = current => {
    current.daily[1] = bars(falling);
    current._on_ticks([1, 2, 3].map(instrument_token => ({ instrument_token, exchange_timestamp: NOW, last_price: broker.price, volume_traded: 1000000,
      depth: { buy: [{ price: broker.price - .05, quantity: 10000 }], sell: [{ price: broker.price + .05, quantity: 10000 }] } })));
  };
  await engine.connect('simulated-token', 'AB1234'); await engine.start(); warm(engine);
  assert.ok(engine.delivery instanceof DeliveryManager); assert.ok(engine.holdings_authorization instanceof HoldingsAuthorization);
  return { engine, store, broker, warm, build, close: async current => { await current.shutdown(); engines.delete(current); } };
}
const mutationCalls = broker => broker.calls.filter(([method]) => ['place_order', 'place_gtt', 'delete_gtt', 'buy_cover', 'cancel_cover'].includes(method));
const sales = broker => broker.orders.filter(order => order.transaction_type === 'SELL');

test('real engine prompts for selected settled holdings, persists authorization need, and builds official request without an order', async t => {
  const f = await fixture(t); await f.engine._run_once();
  const required = f.engine.holdings_authorization.snapshot(); assert.equal(required.required, true); assert.deepEqual(required.items.map(i => [i.symbol, i.quantity]), [['TEST', 8]]);
  assert.equal(f.engine.recovery.phase, 'awaiting_authorization'); assert.equal(f.engine.running, true); assert.equal(mutationCalls(f.broker).length, 0);
  await f.close(f.engine); const restored = f.build(); assert.equal(restored.holdings_authorization.snapshot().required, true);
  await restored.connect('new-simulated-token', 'AB1234'); const result = await restored.start_holdings_authorization();
  assert.equal(result.authorization_url, 'https://kite.zerodha.com/connect/portfolio/authorise/holdings/test-app-key/request-1');
  assert.deepEqual(f.broker.calls.find(([method]) => method === 'authorise_holdings')[1], [{ instruments: [{ isin: 'INE002A01018', quantity: 10 }] }]);
  assert.equal(mutationCalls(f.broker).length, 0); assert.equal(restored.running, false); assert.equal(f.broker.holdings[1].quantity, 40);
});
test('ordinary polls cannot clear a broker rejection or submit repeated sells; explicit check requires current broker quantity', async t => {
  const f = await fixture(t); await f.engine._run_once(); const holding = f.broker.holdings[0]; holding.authorised_quantity = 10; holding.authorised_date = '2026-09-17 00:00:00';
  f.engine.delivery.authorization_needed({ symbol: 'TEST', quantity: 8, holding, broker_rejected: true });
  await f.engine._refresh_account_locked(); await f.engine.refresh_holdings_authorization();
  assert.equal(f.engine.holdings_authorization.isBlocked('TEST'), true); assert.equal(sales(f.broker).length, 0);
  f.engine._last_holdings_scan = 0; await f.engine._run_once(); assert.equal(f.engine.holdings_authorization.isBlocked('TEST'), true); assert.equal(sales(f.broker).length, 0);
  holding.authorised_quantity = 4; await f.engine.refresh_holdings_authorization(true); assert.equal(f.engine.holdings_authorization.isBlocked('TEST'), true);
  const generation = f.engine._analysis_generation; f.engine._candidate(2, new Signal('intraday', 100, 98, 104, 'old candle', 2)); assert.equal(f.engine._candidates.length, 1);
  holding.authorised_quantity = 10; const result = await f.engine.refresh_holdings_authorization(true);
  assert.equal(result.required, false); assert.equal(f.engine._candidates.length, 0); assert.ok(f.engine._analysis_generation > generation); assert.equal(f.engine._recovery_holdings_checked, false); assert.equal(mutationCalls(f.broker).length, 0); assert.equal(f.engine.running, true);
});
test('authorization refresh itself never sells; subsequent fresh evaluation resumes automatically at current price', async t => {
  const f = await fixture(t); await f.engine._run_once(); await f.engine.start_holdings_authorization();
  const holding = f.broker.holdings[0]; holding.authorised_quantity = 10; holding.authorised_date = '2026-09-17 00:00:00';
  const starts = f.store.events().filter(e => e.kind === 'trading_started').length;
  const checked = await f.engine.refresh_holdings_authorization(true); assert.equal(checked.required, false); assert.equal(sales(f.broker).length, 0); assert.equal(f.engine.running, true);
  f.broker.price = 96; f.warm(f.engine); await f.engine._run_once();
  assert.equal(sales(f.broker).length, 1); assert.equal(sales(f.broker)[0].quantity, 8); assert.equal(sales(f.broker)[0].price, 95.95); assert.equal(sales(f.broker)[0].product, 'CNC');
  assert.equal(f.store.events().filter(e => e.kind === 'trading_started').length, starts); assert.equal(f.broker.holdings[1].quantity, 40);
});
test('confirming authorization while paused preserves pause and does not adopt selected shares', async t => {
  const f = await fixture(t); await f.engine._run_once(); await f.engine.pause();
  f.broker.holdings[0].authorised_quantity = 10; f.broker.holdings[0].authorised_date = '2026-09-17 00:00:00';
  await f.engine.refresh_holdings_authorization(true); f.engine._last_holdings_scan = 0; await f.engine._run_once();
  assert.equal(f.engine.running, false); assert.equal(f.engine.status, 'paused'); assert.equal(sales(f.broker).length, 0); assert.deepEqual(f.engine.delivery.snapshot().positions, {});
});
test('intraday cover entry and DDPI existing-holding management never request CDSL permission', async t => {
  const intraday = await fixture(t, { selected: [] }); assert.equal(intraday.engine.holdings_authorization.snapshot().required, false);
  assert.equal(await intraday.engine._enter_locked(2, new Signal('intraday', 100, 98, 104, 'eligible intraday candle', 2)), 'cover_order_pending');
  assert.equal(intraday.broker.calls.some(([method]) => method === 'authorise_holdings'), false); assert.equal(intraday.broker.calls.some(([method]) => method === 'buy_cover'), true);
  const ddpi = await fixture(t, { physical: true }); await ddpi.engine._run_once();
  assert.equal(ddpi.engine.holdings_authorization.snapshot().required, false); assert.equal(ddpi.broker.calls.some(([method]) => method === 'authorise_holdings'), false); assert.equal(sales(ddpi.broker).length, 1);
});
test('authorization HTTP operations do not create protection or sell already-managed shares; ordinary reconciliation does', async t => {
  const f = await fixture(t, { falling: false });
  f.broker.price = 120; f.warm(f.engine); const holding = f.broker.holdings[0]; holding.authorised_quantity = 10; holding.authorised_date = '2026-09-17 00:00:00';
  f.broker.rejectGttAuthorization = true; await f.engine._run_once();
  assert.equal(f.engine.delivery.snapshot().positions.TEST.status, 'authorization_required'); assert.equal(f.engine.holdings_authorization.isBlocked('TEST'), true);
  assert.equal(f.broker.calls.filter(([method]) => method === 'place_gtt').length, 1); assert.deepEqual(f.broker.gtts, {});
  f.broker.rejectGttAuthorization = false;
  const mutationsBefore = mutationCalls(f.broker).length;
  const result = await f.engine.start_holdings_authorization(); assert.match(result.authorization_url, /^https:\/\/kite\.zerodha\.com\/connect\/portfolio\/authorise\/holdings\//);
  assert.equal(mutationCalls(f.broker).length, mutationsBefore);
  f.engine._recovery_account_verified = false;
  assert.equal((await f.engine.refresh_holdings_authorization(true)).required, false);
  assert.equal(mutationCalls(f.broker).length, mutationsBefore); assert.equal(f.engine._recovery_account_verified, false); assert.equal(sales(f.broker).length, 0);
  await f.engine._refresh_account_locked(); assert.equal(f.engine._recovery_account_verified, true);
  assert.equal(f.broker.calls.filter(([method]) => method === 'place_gtt').length, 2); assert.equal(Object.keys(f.broker.gtts).length, 1); assert.equal(sales(f.broker).length, 0);
});
test('CNC fill absent from settled holdings preserves verified authorization rejection and never retries GTT during monitoring', async t => {
  const f = await fixture(t, { physical: true, selected: [] });
  f.store.set('strategy_settings', { intraday_enabled: false, swing_enabled: true, intraday_allocation_pct: 0, swing_allocation_pct: 1, manage_existing_holdings: 'selected', managed_symbols: [] });
  f.broker.rejectGttAuthorization = true;
  f.engine.daily[2]=Array.from({length:21},(_,i)=>new Candle(new Date(NOW-(21-i)*86400000),100,101,99,100,1000));
  const result = await f.engine._enter_locked(2, new Signal('swing', 100, 98, 104, 'confirmed delivery candidate', 2));
  assert.match(result, /^delivery_authorization_required/);
  assert.equal(f.broker.netPositions[0].tradingsymbol, 'NEW'); assert.ok(f.broker.netPositions[0].quantity > 0); assert.equal(f.broker.holdings.some(h => h.tradingsymbol === 'NEW'), false);
  assert.equal(f.engine.delivery.snapshot().positions.NEW.source, 'swing'); assert.equal(f.engine.holdings_authorization.isBlocked('NEW'), true);
  assert.equal(f.broker.calls.filter(([method]) => method === 'place_gtt').length, 1);
  await f.engine._refresh_account_locked(); await f.engine._refresh_account_locked();
  assert.equal(f.engine.holdings_authorization.isBlocked('NEW'), true); assert.equal(f.broker.calls.filter(([method]) => method === 'place_gtt').length, 1);
  assert.equal((await f.engine.refresh_holdings_authorization(true)).required, true); assert.equal(f.engine.holdings_authorization.isBlocked('NEW'), true);
  assert.equal(f.broker.calls.filter(([method]) => method === 'place_gtt').length, 1); assert.deepEqual(f.broker.gtts, {});
});
