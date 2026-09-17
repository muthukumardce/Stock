import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryManager, _price, _holding_available } from '../src/delivery.js';
import { Store } from '../src/storage.js';
import { Candle } from '../src/strategy.js';
import { BrokerError } from '../src/broker.js';
import { monotonic } from '../src/util.js';

const clone = value => structuredClone(value);
const NOW = new Date('2026-09-17T10:00:00+05:30');

// Deterministic OMS and GTT simulation. No network connections or real orders.
class FakeBroker {
  constructor(now = NOW) {
    Object.assign(this, { now, rows: [], holdings: [], gtts: {}, calls: [], consent: 'physical',
      buy_fill: null, sell_fill: null, entry_open: false, timeout_order_before: false,
      timeout_order_after: false, timeout_gtt_after: false, timeout_gtt_before: false,
      timeout_delete: false, delete_race: null, stale_quote: false, no_bid: false, quote_price: 100 });
  }
  add_order(payload, fill, status) {
    const row = { ...clone(payload), order_id: String(this.rows.length + 1), status,
      filled_quantity: fill, pending_quantity: payload.quantity - fill, average_price: fill ? payload.price ?? 100 : 0 };
    this.rows.push(row);
    if (payload.transaction_type === 'SELL') for (const h of this.holdings) if (h.tradingsymbol === payload.tradingsymbol) h.used_quantity = (h.used_quantity ?? 0) + fill;
    return row;
  }
  async call(method, ...args) {
    const kwargs = args.at(-1) && !Array.isArray(args.at(-1)) && typeof args.at(-1) === 'object' ? args.at(-1) : {};
    this.calls.push([method, clone(kwargs)]);
    if (method === 'profile') return { meta: { demat_consent: this.consent } };
    if (method === 'orders') return clone(this.rows);
    if (method === 'holdings') return clone(this.holdings);
    if (method === 'positions') return { net: [...new Set(this.rows.map(r => r.tradingsymbol))].map(symbol => ({
      tradingsymbol: symbol, exchange: 'NSE', product: 'CNC',
      quantity: this.rows.filter(r => r.tradingsymbol === symbol).reduce((n, r) => n + (r.transaction_type === 'BUY' ? 1 : -1) * r.filled_quantity, 0),
    })) };
    if (method === 'get_gtts') return clone(Object.values(this.gtts));
    if (method === 'get_gtt') {
      if (!this.gtts[String(args[0])]) throw new Error('Missing GTT');
      return clone(this.gtts[String(args[0])]);
    }
    if (method === 'quote') return Object.fromEntries(args[0].map(symbol => [symbol, {
      timestamp: new Date(+this.now - (this.stale_quote ? 300_000 : 0)), last_price: this.quote_price,
      depth: { buy: this.no_bid ? [] : [{ price: this.quote_price - 0.05, quantity: 1000 }] },
    }]));
    if (method === 'place_order') {
      if (this.timeout_order_before) throw new Error('Unknown OMS submission');
      const partial = kwargs.transaction_type === 'BUY' ? this.buy_fill : this.sell_fill;
      const fill = partial === null ? kwargs.quantity : Math.min(partial, kwargs.quantity);
      let status = fill === kwargs.quantity ? 'COMPLETE' : 'CANCELLED';
      if (this.entry_open && kwargs.transaction_type === 'BUY') status = 'OPEN';
      const row = this.add_order(kwargs, fill, status);
      if (this.timeout_order_after) throw new Error('Accepted but response lost');
      return row.order_id;
    }
    if (method === 'order_history') return clone(this.rows.filter(r => r.order_id === String(args[0])));
    if (method === 'place_gtt') {
      if (this.timeout_gtt_before) throw new Error('Uncertain GTT');
      const gid = String(Object.keys(this.gtts).length + 1);
      this.gtts[gid] = { id: Number(gid), type: kwargs.trigger_type, status: 'active',
        condition: Object.fromEntries(['exchange', 'tradingsymbol', 'trigger_values', 'last_price'].map(k => [k, clone(kwargs[k])])),
        orders: clone(kwargs.orders).map(o => ({ ...o, result: null })) };
      if (this.timeout_gtt_after) throw new Error('Accepted GTT response lost');
      return { trigger_id: Number(gid) };
    }
    if (method === 'delete_gtt') {
      if (this.timeout_delete) throw new Error('Cancellation uncertain');
      const gtt = this.gtts[String(args[0])];
      if (this.delete_race) {
        const [status, fill] = this.delete_race;
        gtt.status = 'triggered';
        const order = this.add_order(gtt.orders[0], fill, status);
        gtt.orders[0].result = { order_result: { status: 'success', order_id: order.order_id } };
      } else gtt.status = 'deleted';
      return { trigger_id: Number(args[0]) };
    }
    if (method === 'cancel_order') {
      const row = this.rows.find(r => r.order_id === kwargs.order_id);
      row.status = 'CANCELLED';
      return row.order_id;
    }
    throw new Error('Unexpected broker method: ' + method);
  }
}

function context(t) {
  const data_dir = mkdtempSync(join(tmpdir(), 'stock-delivery-'));
  const store = new Store(join(data_dir, 'state.sqlite'));
  store.set('strategy_settings', { swing_enabled: true, swing_capital: 100000, manage_existing_holdings: 'selected', managed_symbols: [] });
  const settings = { trading_mode: 'live', live_trading_enabled: true, data_dir };
  const broker = new FakeBroker();
  const manager = new DeliveryManager(store, broker, settings, () => broker.now);
  t.after(() => { store.close(); rmSync(data_dir, { recursive: true, force: true }); });
  return { manager, broker, store, settings, restart: () => new DeliveryManager(store, broker, settings, () => broker.now) };
}
const mutations = (broker, name) => broker.calls.filter(([method]) => method === name).map(([, kw]) => kw);
const enter = manager => manager.submit_entry('INFY', 10, 100, 95, 110, 0.05, 123);
const holding = (symbol = 'INFY', quantity = 5, average_price = 100) => ({ tradingsymbol: symbol, exchange: 'NSE', quantity, product: 'CNC', average_price });
function daily_bars(falling = false) {
  const dates = [];
  let at = new Date('2026-09-16T00:00:00+05:30');
  while (dates.length < 30) {
    const weekday = new Date(+at + 19800000).getUTCDay();
    if (weekday > 0 && weekday < 6) dates.push(at);
    at = new Date(+at - 86400000);
  }
  dates.reverse();
  const values = dates.map((_, n) => 100 + n * 0.5);
  if (falling) values.splice(-5, 5, 105, 104, 103, 102, 101);
  return dates.map((at, i) => new Candle(at, values[i] - 0.5, values[i] + 1, values[i] - 1, values[i], 1000));
}

test('confirmed partial IOC fill is the only quantity protected', async t => {
  const { manager, broker } = context(t); broker.buy_fill = 4;
  assert.equal((await enter(manager)).status, 'protected');
  assert.equal(mutations(broker, 'place_order')[0].validity, 'IOC');
  assert.deepEqual(mutations(broker, 'place_gtt')[0].orders.map(o => o.quantity), [4, 4]);
  const p = manager.snapshot().positions.INFY;
  assert.equal(p.quantity, 4); assert.equal(p.remaining_quantity, 4); assert.equal(p.token, 123); assert.equal(p.is_bot_owned, true);
});

test('accepted entry with lost response is found by tag across restart without duplicate', async t => {
  const { manager, broker, restart } = context(t); broker.timeout_order_after = true;
  assert.equal((await enter(manager)).status, 'protected');
  const resumed = restart(); await resumed.reconcile(); await enter(resumed);
  assert.equal(mutations(broker, 'place_order').length, 1);
});

test('unknown entry stays blocked across restart and pause', async t => {
  const { manager, broker, restart } = context(t); broker.timeout_order_before = true;
  assert.equal((await enter(manager)).blocked, true);
  const resumed = restart();
  assert.equal((await resumed.reconcile()).blocked, true);
  assert.equal((await resumed.cancel_pending_entries()).blocked, true);
  await enter(resumed);
  assert.equal(mutations(broker, 'place_order').length, 1);
  assert.deepEqual(mutations(broker, 'place_gtt'), []);
});

test('lost GTT response adopts only new exact matching trigger after restart', async t => {
  const { manager, broker, restart } = context(t); broker.timeout_gtt_after = true;
  assert.equal((await enter(manager)).blocked, true);
  const resumed = restart();
  assert.equal((await resumed.reconcile()).blocked, false);
  assert.equal(mutations(broker, 'place_gtt').length, 1);
  assert.equal(resumed.snapshot().positions.INFY.gtt_id, '1');
});

test('ambiguous GTT never retries or places unprotected competing exit', async t => {
  const { manager, broker } = context(t); broker.timeout_gtt_before = true;
  await enter(manager); await manager.reconcile();
  assert.equal((await manager.request_exit('INFY', 10, 99)).blocked, true);
  assert.equal(mutations(broker, 'place_gtt').length, 1);
  assert.equal(mutations(broker, 'place_order').length, 1);
});

test('cancel-trigger race with open exchange order blocks second sell', async t => {
  const { manager, broker } = context(t); await enter(manager); broker.delete_race = ['OPEN', 3];
  const result = await manager.request_exit('INFY', 10, 99);
  assert.equal(result.status, 'exit_pending'); assert.equal(result.blocked, true);
  assert.equal(manager.snapshot().positions.INFY.gtt_filled_quantity, 3);
  await manager.request_exit('INFY', 10, 99);
  assert.equal(mutations(broker, 'delete_gtt').length, 1);
  assert.equal(mutations(broker, 'place_order').length, 1);
});

test('cancel-trigger race with complete fill causes no second sell', async t => {
  const { manager, broker } = context(t); await enter(manager); broker.delete_race = ['COMPLETE', 10];
  assert.equal((await manager.request_exit('INFY', 10, 99)).status, 'closed');
  assert.equal(mutations(broker, 'place_order').length, 1);
});

test('cancel-trigger race with terminal partial fill sells only residual', async t => {
  const { manager, broker } = context(t); await enter(manager); broker.delete_race = ['CANCELLED', 3];
  assert.equal((await manager.request_exit('INFY', 10, 99)).status, 'closed');
  assert.equal(mutations(broker, 'place_order').at(-1).quantity, 7);
  assert.equal(manager.snapshot().positions.INFY.sold_quantity, 10);
});

test('unknown delete is not repeated and blocks explicit sell', async t => {
  const { manager, broker } = context(t); await enter(manager); broker.timeout_delete = true;
  assert.equal((await manager.request_exit('INFY', 10, 99)).blocked, true);
  assert.equal((await manager.request_exit('INFY', 10, 99)).blocked, true);
  assert.equal(mutations(broker, 'delete_gtt').length, 1);
  assert.equal(mutations(broker, 'place_order').length, 1);
});

test('explicit partial exit retries only confirmed residual on new evaluation', async t => {
  const { manager, broker } = context(t); await enter(manager); broker.sell_fill = 4;
  assert.equal((await manager.request_exit('INFY', 10, 99)).status, 'exit_pending');
  assert.equal(manager.snapshot().positions.INFY.remaining_quantity, 6);
  broker.sell_fill = null;
  assert.equal((await manager.request_exit('INFY', 10, 99)).status, 'closed');
  assert.equal(mutations(broker, 'place_order').at(-1).quantity, 6);
  assert.equal(mutations(broker, 'place_gtt').length, 1);
});

test('pause cancels pending entry and protects confirmed partial fill', async t => {
  const { manager, broker } = context(t); broker.entry_open = true; broker.buy_fill = 3;
  assert.equal((await enter(manager)).status, 'entry_pending');
  assert.deepEqual(mutations(broker, 'place_gtt'), []);
  assert.equal((await manager.cancel_pending_entries()).blocked, false);
  assert.equal(mutations(broker, 'place_gtt')[0].orders[0].quantity, 3);
});

for (const consent of ['', 'consent', 'ddpi', null]) test(`unverified demat authority ${JSON.stringify(consent)} blocks entry`, async t => {
  const { manager, broker } = context(t); broker.consent = consent;
  assert.equal((await enter(manager)).blocked, true);
  assert.deepEqual(mutations(broker, 'place_order'), []);
});

test('live setting, maintenance, allocation and stale quote gate entries', async t => {
  const { manager, broker, store, settings } = context(t);
  settings.live_trading_enabled = false; assert.equal((await enter(manager)).blocked, true);
  settings.live_trading_enabled = true;
  writeFileSync(join(settings.data_dir, 'maintenance.lock'), ''); assert.equal((await enter(manager)).blocked, true);
  rmSync(join(settings.data_dir, 'maintenance.lock'));
  store.set('strategy_settings', { swing_enabled: true, swing_capital: 100 }); assert.equal((await enter(manager)).blocked, true);
  store.set('strategy_settings', { swing_enabled: true, swing_capital: 100000 });
  broker.stale_quote = true; assert.equal((await enter(manager)).blocked, true);
  assert.deepEqual(mutations(broker, 'place_order'), []);
});

for (const reason of ['stale', 'no_bid', 'closed_session', 'consent']) test(`invalid exit ${reason} leaves protective GTT intact`, async t => {
  const { manager, broker } = context(t); await enter(manager);
  if (reason === 'stale') broker.stale_quote = true;
  else if (reason === 'no_bid') broker.no_bid = true;
  else if (reason === 'closed_session') manager.now = () => new Date('2026-09-17T18:00:00+05:30');
  else broker.consent = 'consent';
  const result = await manager.request_exit('INFY', 10, 99);
  assert.equal(result.blocked, reason !== 'consent');
  if (reason === 'consent') assert.equal(result.status, 'authorization_required');
  assert.deepEqual(mutations(broker, 'delete_gtt'), []);
  assert.equal(mutations(broker, 'place_order').length, 1);
});

test('selected existing holding excludes unselected, used and pledged shares', async t => {
  const { manager, broker } = context(t); broker.quote_price = 115;
  broker.holdings = ['INFY', 'TCS'].map(s => ({ ...holding(s, 10), used_quantity: 1, collateral_quantity: 2, instrument_token: 123 }));
  const result = await manager.evaluate_holdings({ INFY: daily_bars(), TCS: daily_bars() }, { manage_existing_holdings: 'selected', managed_symbols: ['INFY'] });
  assert.equal(result.blocked, false);
  const snap = manager.snapshot();
  assert.deepEqual(Object.keys(snap.positions), ['INFY']); assert.equal(snap.positions.INFY.quantity, 7);
  assert.equal(snap.positions.INFY.is_bot_owned, false);
  assert.deepEqual(mutations(broker, 'place_order'), []);
  assert.equal(mutations(broker, 'place_gtt')[0].orders[0].quantity, 7);
});

test('existing daily trend exit sells without new swing allocation', async t => {
  const { manager, broker, store } = context(t); broker.holdings = [holding('INFY', 5, 110)];
  store.set('strategy_settings', { swing_enabled: false, swing_capital: 0 });
  assert.equal((await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' })).blocked, false);
  assert.equal(mutations(broker, 'place_order')[0].transaction_type, 'SELL');
  assert.equal(mutations(broker, 'place_order')[0].quantity, 5);
  assert.equal(manager.snapshot().positions.INFY.status, 'closed');
});

test('external active GTT prevents automatic existing holding adoption', async t => {
  const { manager, broker } = context(t); broker.holdings = [holding()];
  broker.gtts['999'] = { id: 999, status: 'active', condition: { tradingsymbol: 'INFY', exchange: 'NSE' } };
  assert.equal((await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' })).blocked, true);
  assert.deepEqual(manager.snapshot().positions, {});
  assert.deepEqual(mutations(broker, 'place_order'), []);
});

test('externally changed protective GTT blocks additional entry', async t => {
  const { manager, broker } = context(t); await enter(manager); broker.gtts['1'].orders[0].quantity = 20;
  assert.equal((await manager.reconcile()).blocked, true);
  assert.equal((await manager.submit_entry('TCS', 10, 100, 95, 110)).blocked, true);
  assert.equal(mutations(broker, 'place_order').length, 1);
});

test('zero fill creates no protection', async t => {
  const { manager, broker } = context(t); broker.buy_fill = 0;
  assert.equal((await enter(manager)).status, 'closed'); assert.deepEqual(mutations(broker, 'place_gtt'), []);
});

test('open partial entry exposure remains visible before protection', async t => {
  const { manager, broker } = context(t); broker.entry_open = true; broker.buy_fill = 4;
  assert.equal((await enter(manager)).blocked, true);
  assert.equal(manager.snapshot().positions.INFY.remaining_quantity, 4);
  assert.deepEqual(mutations(broker, 'place_gtt'), []);
});

test('multiple matching GTTs after lost response remain ambiguous', async t => {
  const { manager, broker } = context(t); broker.timeout_gtt_after = true; await enter(manager);
  broker.gtts['2'] = { ...clone(broker.gtts['1']), id: 2 };
  assert.equal((await manager.reconcile()).blocked, true);
  assert.equal((await manager.request_exit('INFY', 10, 99)).blocked, true);
  assert.equal(mutations(broker, 'place_order').length, 1);
});

test('additional active GTT blocks explicit sell after own GTT deletion', async t => {
  const { manager, broker } = context(t); await enter(manager); broker.gtts['2'] = { ...clone(broker.gtts['1']), id: 2 };
  assert.equal((await manager.reconcile()).blocked, true);
  assert.equal((await manager.request_exit('INFY', 10, 99)).blocked, true);
  assert.equal(mutations(broker, 'place_order').length, 1);
});

test('pending partial exit displays remaining exposure without resubmission', async t => {
  const { manager, broker } = context(t); await enter(manager); broker.timeout_order_before = true;
  await manager.request_exit('INFY', 10, 99);
  broker.add_order(mutations(broker, 'place_order').at(-1), 3, 'OPEN');
  assert.equal((await manager.reconcile()).blocked, true);
  assert.equal(manager.snapshot().positions.INFY.remaining_quantity, 7);
  await manager.request_exit('INFY', 10, 99); assert.equal(mutations(broker, 'place_order').length, 2);
});

test('existing holding P&L is separate from allocated bot capital', async t => {
  const { manager, broker } = context(t); broker.holdings = [holding('INFY', 5, 110)];
  await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' });
  const snap = manager.snapshot();
  assert.equal(snap.bot_realised_pnl, 0); assert.ok(snap.existing_holdings_realised_pnl < 0);
  assert.equal(snap.realised_pnl, snap.existing_holdings_realised_pnl);
});

test('settled old GTT permits reentry and archives P&L', async t => {
  const { manager, broker } = context(t); await enter(manager); broker.delete_race = ['COMPLETE', 10];
  await manager.request_exit('INFY', 10, 99); const oldPnl = manager.snapshot().bot_realised_pnl;
  assert.ok(oldPnl < 0); assert.equal((await enter(manager)).status, 'protected');
  assert.equal(manager.snapshot().bot_realised_pnl, oldPnl);
  assert.equal(mutations(broker, 'place_order').length, 2);
});

test('paused management exits prior holdings without adopting new ones', async t => {
  const { manager, broker } = context(t); broker.quote_price = 115; broker.holdings = [holding()];
  const permissions = { manage_existing_holdings: 'all' };
  await manager.evaluate_holdings({ INFY: daily_bars() }, permissions);
  assert.equal(manager.snapshot().positions.INFY.status, 'protected');
  broker.holdings.push(holding('TCS'));
  const result = await manager.evaluate_holdings({ INFY: daily_bars(true), TCS: daily_bars(true) }, permissions, null, { adopt_new: false });
  assert.equal(result.blocked, false); assert.deepEqual(Object.keys(manager.snapshot().positions), ['INFY']);
  assert.equal(manager.snapshot().positions.INFY.status, 'closed');
  assert.equal(mutations(broker, 'place_order').length, 1);
  assert.equal(mutations(broker, 'place_order')[0].tradingsymbol, 'INFY');
});

test('snapshot estimates entry fees only for remaining bot quantity', async t => {
  const { manager, broker } = context(t); await enter(manager);
  assert.equal(manager.snapshot().positions.INFY.entry_fee, 1);
  broker.sell_fill = 4; await manager.request_exit('INFY', 10, 99);
  assert.ok(Math.abs(manager.snapshot().positions.INFY.entry_fee - 0.6) < 1e-10);
  broker.quote_price = 115; broker.holdings = [holding('TCS')];
  await manager.evaluate_holdings({ TCS: daily_bars() }, { manage_existing_holdings: 'all' });
  assert.equal(manager.snapshot().positions.TCS.entry_fee, 0);
});

test('fresh stream quote hint avoids REST evaluation quote', async t => {
  const { manager, broker } = context(t); await enter(manager);
  const before = mutations(broker, 'quote').length;
  const hint = { exchange_timestamp: broker.now, received_at: monotonic(), last_price: 115 };
  await manager.evaluate_holdings({ INFY: daily_bars() }, {}, { INFY: hint }, { adopt_new: false });
  assert.equal(mutations(broker, 'quote').length, before);
  hint.received_at -= 60;
  await manager.evaluate_holdings({ INFY: daily_bars() }, {}, { INFY: hint }, { adopt_new: false });
  assert.ok(mutations(broker, 'quote').length > before);
});

test('offline manual sale never creates stale-quantity protective GTT after restart', async t => {
  const { manager, broker, restart } = context(t); await enter(manager);
  const p = manager.state.positions.INFY;
  delete manager.state.intents[p.gtt_intent]; delete p.gtt_intent; delete p.gtt_id; manager._save(); broker.gtts = {};
  broker.add_order({ exchange: 'NSE', tradingsymbol: 'INFY', product: 'CNC', transaction_type: 'SELL', quantity: 10, price: 99 }, 10, 'COMPLETE');
  const before = mutations(broker, 'place_gtt').length;
  const result = await restart().reconcile();
  assert.equal(result.blocked, true); assert.match(result.reason, /quantity changed while offline/);
  assert.equal(mutations(broker, 'place_gtt').length, before); assert.equal(mutations(broker, 'place_order').length, 1);
});

test('restart adopts lost GTT acknowledgement and confirms its offline fill', async t => {
  const { manager, broker, restart } = context(t); broker.timeout_gtt_after = true; await enter(manager);
  assert.equal(manager.state.positions.INFY.gtt_id, undefined);
  const gtt = broker.gtts['1']; gtt.status = 'triggered';
  const order = broker.add_order(gtt.orders[0], 10, 'COMPLETE');
  gtt.orders[0].result = { order_result: { status: 'success', order_id: order.order_id } };
  const resumed = restart(); const result = await resumed.reconcile();
  assert.equal(result.blocked, false); assert.equal(resumed.snapshot().positions.INFY.status, 'closed');
  assert.equal(mutations(broker, 'place_gtt').length, 1); assert.equal(mutations(broker, 'place_order').length, 1);
});

test('recovery reports only symbols with completed current evaluation', async t => {
  const { manager, broker } = context(t); await enter(manager);
  assert.deepEqual((await manager.evaluate_holdings({ INFY: [] }, {}, null, { adopt_new: false })).evaluated_symbols, []);
  broker.stale_quote = true;
  const stale = await manager.evaluate_holdings({ INFY: daily_bars() }, {}, null, { adopt_new: false });
  assert.equal(stale.blocked, true); assert.deepEqual(stale.evaluated_symbols, []);
  broker.stale_quote = false; broker.quote_price = 115;
  assert.deepEqual((await manager.evaluate_holdings({ INFY: daily_bars() }, {}, null, { adopt_new: false })).evaluated_symbols, ['INFY']);
});

test('tick rounding uses exact decimal ratios and validates numbers', () => {
  assert.equal(_price(100.05), 100.05); assert.equal(_price(100.05, 0.05, true), 100.05);
  assert.equal(_price(100.049), 100); assert.equal(_price(100.049, 0.05, true), 100.05);
  assert.equal(_price(1e-7, 1e-8), 1e-7); assert.equal(_price(0.3, 0.1), 0.3);
  for (const value of [0, -1, Infinity, NaN, true, '100']) assert.throws(() => _price(value));
  assert.equal(_holding_available({ quantity: 10, used_quantity: 1, collateral_quantity: 2 }), 7);
  assert.equal(_holding_available({ quantity: 10, discrepancy: true }), 0);
  assert.equal(_holding_available({ quantity: 10, product: 'MTF' }), 0);
  assert.equal(_holding_available({ quantity: NaN }), 0);
});

test('concurrent entry submissions remain serialized with one broker mutation', async t => {
  const { manager, broker } = context(t);
  const results = await Promise.all([enter(manager), enter(manager), enter(manager)]);
  assert.ok(results.every(r => r.status === 'protected'));
  assert.equal(mutations(broker, 'place_order').length, 1);
  assert.equal(mutations(broker, 'place_gtt').length, 1);
});

test('delivery uses account-derived allocation instead of missing persisted rupee budget', async t => {
  const { manager, broker, store } = context(t);
  store.set('strategy_settings', { swing_enabled: true, swing_allocation_pct: 0.5, intraday_allocation_pct: 0.5 });
  let capital = 1000;
  manager.strategy_settings = () => ({ ...store.get('strategy_settings'), swing_capital: capital * 0.5 });
  assert.equal((await enter(manager)).blocked, true);
  assert.deepEqual(mutations(broker, 'place_order'), []);
  capital = 100000;
  assert.equal((await enter(manager)).status, 'protected');
  assert.equal(mutations(broker, 'place_order').length, 1);
  assert.equal(store.get('strategy_settings').swing_capital, undefined);
});

test('journal and position association are durable before mutations reach broker', async t => {
  const { manager, broker, store } = context(t);
  const call = broker.call.bind(broker);
  broker.call = async (method, ...args) => {
    if (method === 'place_order') {
      const persisted = store.get('delivery_state'), payload = args[0];
      assert.equal(persisted.positions.INFY.entry_intent, payload.tag);
      assert.equal(persisted.intents[payload.tag].state, 'submitting');
    }
    if (method === 'place_gtt') {
      const persisted = store.get('delivery_state'), p = persisted.positions.INFY;
      assert.equal(persisted.intents[p.gtt_intent].state, 'submitting');
      assert.deepEqual(persisted.intents[p.gtt_intent].before_ids, []);
    }
    return call(method, ...args);
  };
  assert.equal((await enter(manager)).status, 'protected');
});

test('persisted SQLite journal survives close and reopen for unknown entry', async t => {
  const data_dir = mkdtempSync(join(tmpdir(), 'stock-delivery-reopen-'));
  const path = join(data_dir, 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(data_dir, { recursive: true, force: true }); });
  store.set('strategy_settings', { swing_enabled: true, swing_capital: 100000 });
  const broker = new FakeBroker(), settings = { trading_mode: 'live', live_trading_enabled: true, data_dir };
  broker.timeout_order_before = true;
  assert.equal((await enter(new DeliveryManager(store, broker, settings, () => broker.now))).blocked, true);
  store.close(); store = new Store(path);
  const resumed = new DeliveryManager(store, broker, settings, () => broker.now);
  assert.equal((await resumed.reconcile()).blocked, true);
  await enter(resumed);
  assert.equal(mutations(broker, 'place_order').length, 1);
});

const authorizedHolding = (quantity = 5, authorised_quantity = quantity, authorised_date = '2026-09-17') => ({
  ...holding('INFY', quantity, 110), isin: 'INE009A01021', authorised_quantity, authorised_date,
});

test('existing holdings wait for official authorization without placing or queueing orders', async t => {
  const { manager, broker } = context(t);
  broker.consent = 'consent'; broker.holdings = [holding()];
  const prompts = []; manager.authorization_needed = prompt => prompts.push(prompt);
  const result = await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' });
  assert.equal(result.status, 'authorization_required'); assert.equal(result.blocked, false);
  assert.deepEqual(result.evaluated_symbols, []); assert.deepEqual(manager.snapshot().positions, {});
  assert.equal(prompts.length, 1); assert.equal(prompts[0].symbol, 'INFY'); assert.equal(prompts[0].quantity, 5);
  assert.deepEqual(mutations(broker, 'place_order'), []); assert.deepEqual(mutations(broker, 'place_gtt'), []);
});

for (const consent of ['consent', '', null]) test(`fresh authorized holdings allow one current-condition sale with consent ${JSON.stringify(consent)}`, async t => {
  const { manager, broker } = context(t); broker.consent = consent; broker.holdings = [authorizedHolding()];
  const result = await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' });
  assert.equal(result.blocked, false); assert.equal(manager.snapshot().positions.INFY.status, 'closed');
  assert.equal(mutations(broker, 'place_order').length, 1); assert.equal(mutations(broker, 'place_order')[0].quantity, 5);
  await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' });
  assert.equal(mutations(broker, 'place_order').length, 1);
});

for (const date of ['2026-09-16', '2026-09-18', 'invalid', '2026-02-30']) test(`authorization date ${date} cannot authorize today's delivery sale`, async t => {
  const { manager, broker } = context(t); broker.consent = 'consent'; broker.holdings = [authorizedHolding(5, 5, date)];
  const result = await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' });
  assert.equal(result.status, 'authorization_required'); assert.equal(result.blocked, false);
  assert.deepEqual(mutations(broker, 'place_order'), []);
});

test('daily authorization excludes used quantity and must cover entire managed residual', async t => {
  const { manager, broker } = context(t); broker.consent = 'consent';
  broker.holdings = [{ ...authorizedHolding(10, 8), used_quantity: 3 }];
  assert.equal((await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' })).status, 'authorization_required');
  assert.deepEqual(mutations(broker, 'place_order'), []);
  broker.holdings[0].authorised_quantity = 10;
  assert.equal((await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' })).blocked, false);
  assert.equal(mutations(broker, 'place_order')[0].quantity, 7);
});

test('authorization wait does not retain a stale sell signal after permissions are granted', async t => {
  const { manager, broker } = context(t); broker.consent = 'consent'; broker.holdings = [holding()];
  assert.equal((await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' })).status, 'authorization_required');
  broker.holdings = [authorizedHolding()]; broker.quote_price = 115;
  assert.equal((await manager.evaluate_holdings({ INFY: daily_bars() }, { manage_existing_holdings: 'all' })).blocked, false);
  assert.equal(manager.snapshot().positions.INFY.status, 'protected');
  assert.deepEqual(mutations(broker, 'place_order'), []);
  assert.equal(mutations(broker, 'place_gtt').length, 1);
});

test('expired authorization on restored protected holdings prompts before cancellation or sell', async t => {
  const { manager, broker, restart } = context(t); broker.quote_price = 115; broker.holdings = [holding()];
  await manager.evaluate_holdings({ INFY: daily_bars() }, { manage_existing_holdings: 'all' });
  broker.consent = 'consent'; broker.holdings = [authorizedHolding(5, 5, '2026-09-16')];
  const resumed = restart(), prompts = []; resumed.authorization_needed = p => prompts.push(p);
  const reconcile = await resumed.reconcile();
  assert.equal(reconcile.status, 'authorization_required'); assert.equal(reconcile.blocked, false);
  const evaluated = await resumed.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' }, null, { adopt_new: false });
  assert.equal(evaluated.status, 'authorization_required'); assert.deepEqual(evaluated.evaluated_symbols, []);
  assert.equal(resumed.state.positions.INFY.exit_requested, undefined);
  assert.deepEqual(mutations(broker, 'delete_gtt'), []); assert.deepEqual(mutations(broker, 'place_order'), []);
  assert.ok(prompts.length > 0);
  broker.holdings[0].authorised_date = '2026-09-17';
  const current = await resumed.evaluate_holdings({ INFY: daily_bars() }, { manage_existing_holdings: 'all' }, null, { adopt_new: false });
  assert.equal(current.blocked, false); assert.deepEqual(current.evaluated_symbols, ['INFY']);
  assert.equal(resumed.state.positions.INFY.status, 'protected');
  assert.deepEqual(mutations(broker, 'delete_gtt'), []); assert.deepEqual(mutations(broker, 'place_order'), []);
});

test('restored offline filled GTT closes before an expired authorization check', async t => {
  const { manager, broker, restart } = context(t); await enter(manager);
  broker.consent = 'consent'; broker.holdings = [authorizedHolding(10, 10, '2026-09-16')];
  const gtt = broker.gtts['1']; gtt.status = 'triggered';
  const order = broker.add_order(gtt.orders[0], 10, 'COMPLETE');
  gtt.orders[0].result = { order_result: { status: 'success', order_id: order.order_id } };
  const resumed = restart(), prompts = []; resumed.authorization_needed = p => prompts.push(p);
  assert.equal((await resumed.reconcile()).blocked, false);
  assert.equal(resumed.snapshot().positions.INFY.status, 'closed'); assert.deepEqual(prompts, []);
});

test('partial GTT fills require authorization only for verified remaining shares', async t => {
  const { manager, broker } = context(t); await enter(manager);
  broker.consent = 'consent'; broker.holdings = [authorizedHolding(10, 10)];
  const gtt = broker.gtts['1']; gtt.status = 'triggered';
  const order = broker.add_order(gtt.orders[0], 3, 'CANCELLED');
  gtt.orders[0].result = { order_result: { status: 'success', order_id: order.order_id } };
  assert.equal((await manager.request_exit('INFY', 10, 99)).status, 'closed');
  assert.equal(mutations(broker, 'place_order').at(-1).quantity, 7);
});

test('unknown consent status blocks even with apparently current authorization', async t => {
  const { manager, broker } = context(t); broker.consent = 'unexpected'; broker.holdings = [authorizedHolding()];
  const result = await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' });
  assert.equal(result.blocked, true); assert.deepEqual(mutations(broker, 'place_order'), []);
});

test('current-day eDIS does not authorize new overnight swing purchases', async t => {
  const { manager, broker } = context(t); broker.consent = 'consent'; broker.holdings = [authorizedHolding(10, 10)];
  const result = await enter(manager);
  assert.equal(result.blocked, true); assert.match(result.reason, /DDPI\/POA/); assert.deepEqual(mutations(broker, 'place_order'), []);
});

test('physical DDPI bypasses daily authorization prompts and holdings refresh', async t => {
  const { manager, broker } = context(t); const prompts = []; manager.authorization_needed = p => prompts.push(p);
  const before = mutations(broker, 'holdings').length;
  assert.equal(await manager._delivery_authority({ symbol: 'INFY' }, 10), null);
  assert.equal(mutations(broker, 'holdings').length, before); assert.deepEqual(prompts, []);
});

test('definitive authorization rejection records no fill and reevaluates before any later sell', async t => {
  const { manager, broker } = context(t); broker.quote_price = 115; broker.holdings = [holding()];
  await manager.evaluate_holdings({ INFY: daily_bars() }, { manage_existing_holdings: 'all' });
  broker.consent = 'consent'; broker.holdings = [authorizedHolding()];
  const prompts = []; manager.authorization_needed = p => prompts.push(p);
  const originalCall = broker.call.bind(broker);
  broker.call = async (method, ...args) => {
    if (method === 'place_order') throw new BrokerError('InputException', 'Authorisation required', { http_status: 428, auth_required: true });
    return originalCall(method, ...args);
  };
  const result = await manager.evaluate_holdings({ INFY: daily_bars(true) }, { manage_existing_holdings: 'all' }, null, { adopt_new: false });
  assert.equal(result.status, 'authorization_required'); assert.equal(result.blocked, false); assert.deepEqual(result.evaluated_symbols, []);
  const p = manager.state.positions.INFY, intent = manager.state.intents[p.exit_intents[0]];
  assert.equal(intent.state, 'terminal'); assert.equal(intent.order.status, 'REJECTED'); assert.equal(intent.order.filled_quantity, 0);
  assert.equal(p.exit_requested, undefined); assert.equal(p.gtt_id, undefined); assert.equal(p.sold_quantity, 0);
  assert.equal(prompts.at(-1).broker_rejected, true);
  broker.call = originalCall;
  await manager.evaluate_holdings({ INFY: daily_bars() }, { manage_existing_holdings: 'all' }, null, { adopt_new: false });
  assert.equal(manager.state.positions.INFY.status, 'protected');
  assert.deepEqual(mutations(broker, 'place_order'), []);
});

test('definitive GTT authorization rejection does not create an ambiguous trigger intent', async t => {
  const { manager, broker } = context(t); broker.quote_price = 115; broker.consent = 'consent'; broker.holdings = [authorizedHolding()];
  const prompts = []; manager.authorization_needed = p => prompts.push(p);
  const originalCall = broker.call.bind(broker);
  broker.call = async (method, ...args) => {
    if (method === 'place_gtt') throw new BrokerError('InputException', 'Authorisation required', { http_status: 428, auth_required: true });
    return originalCall(method, ...args);
  };
  const result = await manager.evaluate_holdings({ INFY: daily_bars() }, { manage_existing_holdings: 'all' });
  assert.equal(result.status, 'authorization_required'); assert.equal(result.blocked, false);
  assert.equal(manager.state.positions.INFY.gtt_intent, undefined);
  assert.equal(Object.values(manager.state.intents)[0].state, 'rejected');
  assert.equal(prompts.at(-1).broker_rejected, true);
});

test('unverified HTTP428-like failure remains unknown and cannot cause a duplicate sell', async t => {
  const { manager, broker } = context(t); await enter(manager);
  const originalCall = broker.call.bind(broker);
  let attempts = 0;
  broker.call = async (method, ...args) => {
    if (method === 'place_order') { attempts++; throw new BrokerError('InputException', 'HTTP428 timeout'); }
    return originalCall(method, ...args);
  };
  assert.equal((await manager.request_exit('INFY', 10, 99)).blocked, true);
  assert.equal((await manager.request_exit('INFY', 10, 99)).blocked, true);
  assert.equal(attempts, 1);
  assert.equal(manager.state.intents[manager.state.positions.INFY.exit_intents[0]].state, 'unknown');
});

test('definitive rejection remains latched until explicit verified authorization check', async t => {
  const { manager, broker } = context(t); broker.quote_price = 115; broker.holdings = [holding()];
  await manager.evaluate_holdings({ INFY: daily_bars() }, { manage_existing_holdings: 'all' });
  broker.consent = 'consent'; broker.holdings = [authorizedHolding()];
  const forced = new Set(); manager.authorization_needed = p => { if (p.broker_rejected) forced.add(p.symbol); };
  manager.authorization_blocked = symbol => forced.has(symbol);
  const originalCall = broker.call.bind(broker);
  let rejected = false, attempts = 0;
  broker.call = async (method, ...args) => {
    if (method === 'place_order') {
      attempts++;
      if (!rejected) { rejected = true; throw new BrokerError('InputException', 'Authorisation required', { http_status: 428, auth_required: true }); }
    }
    return originalCall(method, ...args);
  };
  const options = { adopt_new: false }, settings = { manage_existing_holdings: 'all' };
  assert.equal((await manager.evaluate_holdings({ INFY: daily_bars(true) }, settings, null, options)).status, 'authorization_required');
  assert.equal(attempts, 1); assert.equal(forced.has('INFY'), true);
  assert.equal((await manager.evaluate_holdings({ INFY: daily_bars(true) }, settings, null, options)).status, 'authorization_required');
  assert.equal(attempts, 1);
  assert.equal(Object.values(manager.state.intents).filter(i => i.kind === 'exit').length, 1);
  // The service clears this only after explicit user Check + fresh broker proof.
  forced.delete('INFY');
  assert.equal((await manager.evaluate_holdings({ INFY: daily_bars(true) }, settings, null, options)).blocked, false);
  assert.equal(manager.snapshot().positions.INFY.status, 'closed');
  assert.equal(attempts, 2); assert.equal(mutations(broker, 'place_order').length, 1);
});
