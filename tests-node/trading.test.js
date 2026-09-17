import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingEngine } from '../src/trading.js';
import { Store } from '../src/storage.js';
import { BrokerError } from '../src/broker.js';
import { CandleBook, Candle, Signal } from '../src/strategy.js';
import { monotonic, dateIST, isoIST } from '../src/util.js';

const NOW = new Date('2026-09-17T12:00:00+05:30');
const clone = value => structuredClone(value);
class MemoryStore {
  values = {}; log = [];
  get(key, fallback = null) { return clone(Object.hasOwn(this.values, key) ? this.values[key] : fallback); }
  set(key, value) { this.values[key] = clone(value); }
  event(kind, message, data = null, level = 'info') { this.log.push({ kind, message, data: clone(data), level }); return this.log.length; }
}
const analyticsFactory = () => ({ worker_limit: 2, batch_size: 2, snapshot: () => ({}), close: async () => {}, analyze: async () => [] });
const options = overrides => ({ now: () => NOW, backgroundLoops: false, analyticsFactory, ...overrides });
function settings(path, mode = 'paper') {
  return { trading_mode: mode, live_trading_enabled: mode === 'live', data_dir: path,
    kite_api_key: '', kite_user_id: '', max_position_pct: .1, risk_per_trade_pct: .0025, daily_loss_pct: .01, max_positions: 5, entry_cutoff: '14:45', exit_time: '15:10', max_spread_pct: .003, min_daily_turnover: 10000 };
}
function temp(t) {
  const path = mkdtempSync(join(tmpdir(), 'stock-node-trading-'));
  t.after(() => { assert.ok(path.startsWith(join(tmpdir(), 'stock-node-trading-'))); rmSync(path, { recursive: true, force: true }); });
  return path;
}
function ready(t, mode = 'paper') {
  const store = new MemoryStore(), engine = new TradingEngine(settings(temp(t), mode), store, options());
  engine.connected = engine.running = true; engine.status = 'running'; engine.universe = { 1: { tradingsymbol: 'TEST', tick_size: .05 } };
  engine.quotes = { 1: { last_price: 100, volume_traded: 100000, received_at: monotonic(), depth: { buy: [{ price: 99.95, quantity: 10000 }], sell: [{ price: 100.05, quantity: 10000 }] } } };
  engine.account = { positions: { net: [] }, orders: [], holdings: [], trades: [], margins: { equity: { available: { cash: 100000, live_balance: 100000 } } } };
  engine._update_capital(true);
  engine._account_at = monotonic(); engine._profile_verified = engine._recovery_account_verified = true; Object.assign(engine.recovery, { phase: 'ready', blocked: false }); engine.day = dateIST(NOW);
  return [engine, store];
}
const signal = (strategy = 'intraday') => new Signal(strategy, 100, 98, 104, 'test', 2);

test('paper fill survives reconstruction; pause preserves exposure without trading real account', async t => {
  const [engine, store] = ready(t);
  assert.equal(await engine._enter_locked(1, signal()), 'paper_buy_filled'); await engine.pause();
  const restored = new TradingEngine(engine.settings, store, options());
  assert.ok(restored.positions.TEST.quantity > 0); assert.equal(engine.status, 'paused'); assert.ok(engine.snapshot().safe_to_stop);
});
test('ambiguous live submission is journalled before I/O and never resent after restart', async t => {
  const [engine, store] = ready(t, 'live'); let calls = 0;
  engine.broker = { async buy_cover() { calls++; assert.ok(Object.keys(store.get('bot_state_live').intents).length); throw new Error('timeout'); } };
  assert.equal(await engine._enter_locked(1, signal()), 'cover_order_unknown'); engine.running = true;
  assert.equal(await engine._enter_locked(1, signal()), 'unresolved_order'); assert.equal(calls, 1);
  const restored = new TradingEngine(engine.settings, store, options()); assert.ok(restored._unresolved_intents()); assert.equal(restored.snapshot().safe_to_stop, false);
});
test('maintenance stops entry immediately and after awaited reconciliation', async t => {
  const [engine] = ready(t); writeFileSync(join(engine.settings.data_dir, 'maintenance.lock'), 'maintenance');
  assert.equal(await engine._enter_locked(1, signal()), 'maintenance_active'); assert.deepEqual(engine.positions, {});
  const [second] = ready(t); second.running = false; second.broker = {};
  second._refresh_account_locked = async () => writeFileSync(join(second.settings.data_dir, 'maintenance.lock'), 'maintenance');
  await assert.rejects(second.start(), /Maintenance/); assert.equal(second.running, false);
});
test('daily rollover preserves swing position, resets baseline and requires arming', async t => {
  const [engine, store] = ready(t); store.set('strategy_settings', { intraday_enabled: false, swing_enabled: true, intraday_capital: 0, swing_capital: 100000 });
  assert.equal(await engine._enter_locked(1, signal('swing')), 'paper_buy_filled'); engine.realised = 500; engine.positions.TEST.last = 103;
  engine._now = () => new Date(NOW.getTime() + 86400000); engine._roll_day();
  assert.equal(engine._daily_pnl(), 0); assert.equal(engine.positions.TEST.strategy, 'swing'); assert.equal(engine.running, false);
});
test('flatten paper exits at fresh gap price and preserves manual holdings', async t => {
  const [engine, store] = ready(t); engine.account.holdings = [{ tradingsymbol: 'MANUAL', quantity: 10 }]; await engine._enter_locked(1, signal());
  engine.quotes[1].depth.buy[0].price = 90; await engine.flatten();
  assert.deepEqual(engine.positions, {}); assert.ok(engine.realised < -900); assert.equal(engine.account.holdings[0].quantity, 10); assert.ok(store.log.at(-2).data.exit < 90);
});
function journal(store, at = NOW, quantity = 4) {
  const intent = { tag: 'EB1', symbol: 'TEST', token: 1, strategy: 'intraday', quantity, entry: 100, stop: 98, target: 104, created_at: isoIST(at), state: 'unknown', order_id: 'parent', filled: 0, exit_requested: [], pnl_accounted: 0 };
  store.set('bot_state_live', { day: dateIST(at), intents: { EB1: intent } });
  return [{ order_id: 'parent', tag: 'EB1', variety: 'co', transaction_type: 'BUY', exchange: 'NSE', tradingsymbol: 'TEST', product: 'MIS', quantity, filled_quantity: quantity, average_price: 100, status: 'COMPLETE' },
    { order_id: 'child', parent_order_id: 'parent', variety: 'co', transaction_type: 'SELL', exchange: 'NSE', tradingsymbol: 'TEST', product: 'MIS', quantity, filled_quantity: 0, pending_quantity: quantity, trigger_price: 98, status: 'TRIGGER PENDING' }];
}
test('cover partial fill protects only filled quantity and cancels owned child once', async t => {
  const [engine, store] = ready(t, 'live'), [parent, child] = journal(store, NOW, 10);
  engine.intents = store.get('bot_state_live').intents; parent.status = 'CANCELLED'; parent.filled_quantity = 4; child.quantity = child.pending_quantity = 4;
  engine.account.orders = [parent, child]; engine.account.positions.net = [{ tradingsymbol: 'TEST', exchange: 'NSE', product: 'CO', quantity: 4 }];
  const calls = []; engine.broker = { cancel_cover: async (...args) => calls.push(args) };
  await engine._reconcile_live_locked(); assert.equal(engine.positions.TEST.quantity, 4);
  await engine._exit_locked('TEST', 'test'); await engine._exit_locked('TEST', 'test');
  assert.deepEqual(calls, [['child', 'parent']]); assert.equal(engine.snapshot().safe_to_stop, false);
});
test('zero-fill rejection resolves without position; input rejection never becomes ambiguous', async t => {
  const [engine, store] = ready(t, 'live'), [parent] = journal(store, NOW, 10); engine.intents = store.get('bot_state_live').intents;
  parent.status = 'REJECTED'; parent.filled_quantity = 0; engine.account.orders = [parent]; await engine._reconcile_live_locked();
  assert.equal(engine.intents.EB1.state, 'rejected'); assert.deepEqual(engine.positions, {});
  engine.broker = { buy_cover: async () => { throw new BrokerError('InputException', 'Trigger range'); } };
  assert.equal(await engine._enter_locked(1, signal()), 'cover_order_rejected'); assert.equal(engine._unresolved_intents(), false); assert.ok(store.log.some(e => e.kind === 'order_rejected'));
});
test('intraday historical seed excludes current, future, malformed and invalid candles', t => {
  const [engine] = ready(t); engine.books[1] = new CandleBook();
  const row = { open: 100, high: 101, low: 99, close: 100, volume: 1000 };
  engine._seed_intraday(1, [{ ...row, date: new Date(NOW - 300000) }, { ...row, date: NOW }, { ...row, date: new Date(NOW - 600000), high: 99 }, { ...row, date: new Date(NOW - 360000) }, { ...row, date: 'bad' }], NOW);
  assert.equal(engine.books[1].bars.length, 1); assert.equal(engine.books[1].bars[0].time.getTime(), NOW - 300000);
});
test('paper configuration cannot conceal saved live exposure', async t => {
  const [engine, store] = ready(t); store.set('bot_state_live', { positions: {}, intents: { unknown: { state: 'unknown' } } });
  assert.equal(engine.snapshot().safe_to_stop, false); assert.ok(engine.snapshot().unmanaged_live_exposure); await assert.rejects(engine.start(), /real-money exposure/);
});
test('saved allocations exceeding total available capital cannot arm', async t => {
  const [engine, store] = ready(t); engine.broker = {};
  store.set('strategy_settings', { intraday_enabled: true, intraday_allocation_pct: 1, swing_enabled: false, swing_allocation_pct: .5 });
  await assert.rejects(engine.start(), /allocations/);
});
test('live cash excludes collateral and reserves existing positions full notional', async t => {
  const [engine] = ready(t, 'live'); engine.positions.OTHER = { quantity: 100, entry: 100, last: 100, stop: 98, strategy: 'intraday' };
  engine.account.margins = { equity: { net: 30000, available: { cash: 20000, live_balance: 30000, collateral: 20000 } } };
  assert.equal(await engine._enter_locked(1, signal()), 'insufficient_risk_or_cash_budget');
});
test('delivery sync uses remaining quantity and accounts bot P&L exactly once across restart', t => {
  const [engine, store] = ready(t, 'live');
  const delivery = { snapshot: () => ({ positions: { TEST: { source: 'swing', status: 'protected', symbol: 'TEST', token: 1, entry: 100, last: 101, quantity: 10, remaining_quantity: 4, strategy: 'swing', stop: 95, target: 110 } }, bot_realised_pnl: 100, existing_holdings_realised_pnl: 5000, blocked: false }) };
  engine.delivery = delivery; engine._sync_delivery(); engine._sync_delivery(); assert.equal(engine.realised, 100); assert.equal(engine.positions.TEST.quantity, 4); engine._persist();
  const restored = new TradingEngine(engine.settings, store, options()); restored.delivery = delivery; restored._sync_delivery(); assert.equal(restored.realised, 100);
});
test('analytics queue supersedes old jobs and rejects previous generation and stale results', t => {
  const [engine] = ready(t), bars = [new Candle(NOW, 100, 101, 99, 100, 1000)];
  engine._queue_analysis(1, 'swing', bars); engine._queue_analysis(1, 'swing', bars); assert.equal(engine._analysis_pending.size, 1);
  engine._analysis_finished([{ token: 1, strategy: 'swing', generation: -1 }]); assert.equal(engine.signals.length, 0); assert.equal(engine._analysis_cache.size, 0);
  engine.daily[1] = bars; engine._analysis_finished([{ token: 1, strategy: 'swing', generation: engine._analysis_generation, bar_time: isoIST(NOW), queued_at: monotonic() - 31 }]); assert.equal(engine._stats.stale_analysis_dropped, 1);
});
test('existing-holding paper sell needs selection, is idempotent, and never changes real account/P&L', t => {
  const [engine, store] = ready(t); engine.account.holdings = [{ exchange: 'NSE', tradingsymbol: 'TEST', quantity: 10, instrument_token: 1 }];
  engine.daily[1] = Array.from({ length: 21 }, (_, i) => new Candle(new Date(NOW - (21 - i) * 86400000), 100, 101, 99, 100, 1000));
  engine._analysis_cache.set('swing:1', { holding: { trailing: 95, trend_exit: true } }); engine._analyze_holdings(); assert.deepEqual(engine._paper_holding_actions, {});
  store.set('strategy_settings', { manage_existing_holdings: 'selected', managed_symbols: ['TEST'] }); engine._analyze_holdings(); engine._analyze_holdings();
  assert.equal(Object.keys(engine._paper_holding_actions).length, 1); assert.equal(engine.account.holdings[0].quantity, 10); assert.equal(engine.realised, 0);
});
test('account audit tracks changes without logging every market-price movement', async t => {
  const [engine, store] = ready(t); engine.broker = { account: async () => clone(engine.account) };
  engine.account.holdings = [{ tradingsymbol: 'TEST', exchange: 'NSE', quantity: 10, average_price: 100, last_price: 101 }];
  await engine._refresh_account_locked(); engine.account.holdings[0].last_price = 102; await engine._refresh_account_locked(); assert.equal(store.log.filter(e => e.kind === 'account_holdings').length, 1);
  engine.account.holdings[0].quantity = 5; await engine._refresh_account_locked(); assert.equal(store.log.filter(e => e.kind === 'account_holdings').length, 2);
});
test('flatten exits adopted holdings only and leaves unselected shares untouched', async t => {
  const [engine] = ready(t, 'live'), calls = []; engine.account.holdings = [{ tradingsymbol: 'TEST', quantity: 4 }, { tradingsymbol: 'UNSELECTED', quantity: 20 }];
  engine.delivery = { snapshot: () => ({ positions: { TEST: { source: 'existing', status: 'protected', symbol: 'TEST', token: 1, remaining_quantity: 4 } }, blocked: false, bot_realised_pnl: 0 }), cancel_pending_entries: async () => {}, request_exit: async (symbol, quantity) => { calls.push([symbol, quantity]); return { status: 'requested' }; } };
  engine._refresh_account_locked = async () => {}; await engine.flatten(); assert.deepEqual(calls, [['TEST', 4]]); assert.equal(engine.account.holdings[1].quantity, 20);
});
class RecoveryBroker {
  calls = []; history = {}; profile_id = 'AB1234';
  current = { orders: [], trades: [], holdings: [], positions: { net: [] }, margins: { equity: { available: { cash: 90000, live_balance: 90000 } } } };
  async account() { this.calls.push('account'); return clone(this.current); }
  async call(method, ...args) {
    this.calls.push(method);
    if (method === 'profile') return { user_id: this.profile_id, meta: { demat_consent: 'physical' } };
    if (method === 'instruments') return [{ instrument_token: 22, exchange: 'NSE', segment: 'NSE', instrument_type: 'EQ', tradingsymbol: 'TEST', tick_size: .05 }];
    if (method === 'order_history') return clone(this.history[args[0]] || []);
    if (method in this.current) return clone(this.current[method]);
    if (['historical_data', 'get_gtts'].includes(method)) return [];
    throw new Error(`Unexpected broker request ${method}`);
  }
  async stream(tokens, ticks, orders, status) { this.calls.push('stream'); status(0, true, tokens); }
  async cancel_cover(oid) { this.calls.push('cancel:' + oid); }
  close() { this.calls.push('close'); }
}
test('SQLite restart discovers offline cover fill via history and refreshes manual holdings/cash without duplicate P&L', async t => {
  const path = temp(t), filename = join(path, 'recovery.sqlite'); let store = new Store(filename); const broker = new RecoveryBroker(), [parent, child] = journal(store);
  broker.current.orders = [parent, child]; broker.current.positions.net = [{ exchange: 'NSE', tradingsymbol: 'TEST', product: 'MIS', quantity: 4 }];
  const opts = options({ brokerFactory: () => broker }); const original = new TradingEngine(settings(path, 'live'), store, opts);
  await original.connect('first', 'AB1234'); assert.equal(original.positions.TEST.token, 22); assert.equal(original.recovery.phase, 'warming_up'); await original.shutdown(); store.close();
  broker.current.orders = []; broker.current.positions.net = []; broker.current.holdings = [{ exchange: 'NSE', tradingsymbol: 'MANUAL', quantity: 12 }]; broker.current.margins.equity.available.cash = 87000;
  broker.history.child = [{ ...child, status: 'COMPLETE', filled_quantity: 4, pending_quantity: 0, average_price: 97 }];
  store = new Store(filename); const restarted = new TradingEngine(settings(path, 'live'), store, opts);
  await restarted.connect('second', 'AB1234'); assert.equal(restarted.intents.EB1.state, 'closed'); assert.deepEqual(restarted.positions, {}); assert.ok(restarted.realised < -12);
  assert.equal(restarted.account.holdings[0].quantity, 12); assert.equal(restarted.account.margins.equity.available.cash, 87000); assert.equal(restarted.recovery.phase, 'ready');
  assert.ok(broker.calls.indexOf('profile') < broker.calls.indexOf('account')); assert.ok(broker.calls.indexOf('account') < broker.calls.indexOf('stream')); assert.equal(broker.calls.some(c => c.startsWith('cancel:')), false);
  const pnl = restarted.realised; await restarted.start(); assert.equal(restarted.realised, pnl); await restarted.shutdown(); store.close();
});
test('restart never infers a fill from missing order and retains reconciliation error', async t => {
  const path = temp(t), store = new Store(join(path, 'unknown.sqlite')), broker = new RecoveryBroker(); journal(store, new Date(NOW - 86400000));
  const engine = new TradingEngine(settings(path, 'live'), store, options({ brokerFactory: () => broker })); await engine.connect('session', 'AB1234');
  assert.equal(engine.status, 'error'); assert.ok(engine.error); assert.equal(engine.recovery.phase, 'blocked'); await assert.rejects(engine.start(), /unresolved/); assert.equal(engine.running, false); assert.equal(engine.intents.EB1.state, 'unknown'); assert.equal(broker.calls.some(c => c.startsWith('cancel:')), false);
  await engine.shutdown(); store.close();
});
test('wrong broker profile is rejected before account access or order work', async t => {
  const broker = new RecoveryBroker(); broker.profile_id = 'ZZ9999'; const store = new MemoryStore(), engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker }));
  await assert.rejects(engine.connect('session', 'AB1234'), /Connection setup failed/); assert.equal(broker.calls.includes('account'), false); assert.equal(engine.connected, false); assert.equal(engine.recovery.phase, 'blocked'); await engine.shutdown();
});
test('overdue paper position waits for fresh current-session executable price after restart', async t => {
  const store = new MemoryStore(), broker = new RecoveryBroker(), yesterday = new Date(NOW - 86400000);
  store.set('bot_state_paper', { day: dateIST(yesterday), positions: { TEST: { symbol: 'TEST', token: 1, strategy: 'intraday', quantity: 4, entry: 100, last: 100, stop: 98, target: 104, opened_at: isoIST(yesterday) } } });
  const engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker })); await engine.connect('session', 'AB1234'); await engine.start();
  assert.equal(engine.recovery.blocked, true); assert.equal(await engine._enter_locked(22, signal()), 'recovery_incomplete'); await engine._run_once(); assert.ok(engine.positions.TEST);
  engine._on_ticks([{ instrument_token: 22, exchange_timestamp: NOW, last_price: 90, volume_traded: 1000, depth: { buy: [{ price: 89.95, quantity: 100 }], sell: [{ price: 90.05, quantity: 100 }] } }]); await engine._run_once();
  assert.deepEqual(engine.positions, {}); assert.ok(engine.realised < -40); assert.equal(store.log.filter(e => e.kind === 'paper_fill').at(-1).data.reason, 'overdue_intraday_exit'); await engine.shutdown();
});
test('ready recovery recomputes current bars; stream interruption gates managed risk', t => {
  const [engine] = ready(t); engine.books[1] = new CandleBook(); engine.books[1].bars.push(new Candle(new Date(NOW - 300000), 100, 101, 99, 100, 1000)); engine._candidate(1, signal());
  const prior = engine._analysis_generation; Object.assign(engine.recovery, { phase: 'warming_up', blocked: true }); engine._advance_recovery();
  assert.equal(engine._candidates.length, 0); assert.ok(engine._analysis_generation > prior); assert.ok(engine._analysis_pending.has('intraday:1'));
  engine.positions.TEST = { symbol: 'TEST', token: 1, strategy: 'intraday', entry: 100, quantity: 1, stop: 98 }; engine._on_stream(0, false, [1]); engine._advance_recovery(); assert.equal(engine.recovery.blocked, true); assert.equal(engine._analysis_pending.size, 0);
});
test('new day baseline is set before reconciling offline loss and blocks restart', async t => {
  const [engine] = ready(t, 'live'); engine.day = dateIST(new Date(NOW - 86400000)); engine.broker = {}; engine.realised = 100;
  engine._refresh_account_locked = async () => { engine.realised -= 2000; engine._recovery_account_verified = true; };
  await assert.rejects(engine.start(), /daily loss/); assert.equal(engine.day_baseline, 100); assert.equal(engine._daily_pnl(), -2000); assert.equal(engine.running, false);
});
test('time-of-day and stale-account/quote risk gates prevent entry', async t => {
  const [engine] = ready(t); engine._now = () => new Date('2026-09-17T14:46:00+05:30'); assert.equal(await engine._enter_locked(1, signal()), 'entry_cutoff');
  engine._now = () => new Date('2026-09-19T12:00:00+05:30'); assert.equal(await engine._enter_locked(1, signal()), 'market_closed');
  engine._now = () => NOW; engine._account_at = monotonic() - 46; assert.equal(await engine._enter_locked(1, signal()), 'account_data_stale');
  engine._account_at = monotonic(); engine.quotes = {}; assert.equal(await engine._enter_locked(1, signal()), 'quote_stale');
});
test('cover identity mismatch and missing active child history halt without destructive orders', async t => {
  const [engine, store] = ready(t, 'live'), [parent, child] = journal(store); engine.intents = store.get('bot_state_live').intents; engine.account.orders = [{ ...parent, tradingsymbol: 'OTHER' }, child];
  await engine._reconcile_live_locked(); assert.equal(engine.intents.EB1.state, 'conflict');
  engine.intents.EB1.state = 'open'; engine.intents.EB1.broker_children = [child]; engine.account.orders = [parent]; engine.broker = { call: async () => [] };
  await engine._reconcile_live_locked(); assert.equal(engine.intents.EB1.state, 'unknown'); assert.equal(engine.running, false);
});
test('daily history prioritizes owned holdings, caches completed candles and excludes current day', async t => {
  const [engine, store] = ready(t); engine.account.holdings = [{ exchange: 'NSE', instrument_token: 1, tradingsymbol: 'TEST', quantity: 1 }]; let calls = 0;
  const rows = Array.from({ length: 23 }, (_, i) => ({ date: new Date(NOW - (22 - i) * 86400000), open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
  engine.broker = { call: async method => { assert.equal(method, 'historical_data'); calls++; return rows; } }; await engine._history_pass();
  assert.equal(engine.daily[1].length, 22); assert.equal(dateIST(engine.daily[1].at(-1).time), '2026-09-16'); assert.ok(store.get('daily:1')); engine._history_date = ''; await engine._history_pass(); assert.equal(calls, 1);
});
test('old session history results are discarded after reconnect/cancellation', async t => {
  const [engine] = ready(t); engine.account.holdings = [{ exchange: 'NSE', instrument_token: 1 }]; const controller = new AbortController();
  engine.broker = { call: async () => { controller.abort(); return Array.from({ length: 25 }, (_, i) => ({ date: new Date(NOW - (25 - i) * 86400000), open: 100, high: 101, low: 99, close: 100, volume: 1000 })); } };
  await engine._history_pass(controller.signal); assert.deepEqual(engine.daily, {});
});
test('shutdown aborts sleeping loops and queued mutex work without waiting for 30-second history timer', async t => {
  const broker = new RecoveryBroker(), engine = new TradingEngine(settings(temp(t)), new MemoryStore(), options({ backgroundLoops: true, brokerFactory: () => broker }));
  await engine.connect('session', 'AB1234'); const started = Date.now(); await engine.shutdown(); assert.ok(Date.now() - started < 2000); assert.equal(engine.connected, false); assert.equal(engine._tasks.length, 0);
});
test('capital starts unknown and seeds paper only once from verified cash, excluding collateral', async t => {
  const store = new MemoryStore(), broker = new RecoveryBroker(), engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker }));
  assert.equal(engine.capital, 0); assert.equal(engine.snapshot().feed_fresh, false); assert.equal(engine.snapshot().account_fresh, false);
  broker.current.margins.equity.available = { cash: 70000, live_balance: 80000, collateral: 30000, adhoc_margin: 5000 };
  await engine.connect('session', 'AB1234'); assert.equal(engine.capital, 45000); assert.equal(engine.strategy_settings().intraday_capital, 45000); engine.realised = -1000; engine._persist();
  broker.current.margins.equity.available = { cash: 999000, live_balance: 999000 }; await engine._refresh_account_locked({ rebase_capital: true }); assert.equal(engine.capital, 45000);
  const restored = new TradingEngine(engine.settings, store, options({ brokerFactory: () => broker })); await restored.connect('restart', 'AB1234'); assert.equal(restored.capital, 45000); assert.equal(restored.snapshot().equity, 44000); await restored.shutdown(); await engine.shutdown();
});
test('empty or invalid broker cash cannot start but paper seeds when funds first arrive', async t => {
  const broker = new RecoveryBroker(); broker.current.margins.equity.available = { cash: 0, live_balance: 0 };
  const engine = new TradingEngine(settings(temp(t)), new MemoryStore(), options({ brokerFactory: () => broker })); await engine.connect('session', 'AB1234'); await assert.rejects(engine.start(), /no verified available cash/);
  broker.current.margins.equity.available = { cash: 12000, live_balance: 15000, collateral: 5000 }; await engine.start(); assert.equal(engine.capital, 10000);
  engine.account.margins.equity.available.cash = NaN; assert.equal(engine._available_cash(), 0); await engine.shutdown();
});
test('live budget refreshes from cash while flat and rebasing never double counts prior realized P&L', async t => {
  const broker = new RecoveryBroker(), store = new MemoryStore(), engine = new TradingEngine(settings(temp(t), 'live'), store, options({ brokerFactory: () => broker }));
  await engine.connect('session', 'AB1234'); assert.equal(engine.capital, 90000); engine.realised = -500; broker.current.margins.equity.available = { cash: 89500, live_balance: 89500 };
  await engine.start(); assert.equal(engine.capital, 89500); assert.equal(engine.snapshot().equity, 89500); assert.equal(engine.snapshot().realised_pnl, -500); assert.equal(engine._daily_pnl(), -500); await engine.shutdown();
});
test('live budget remains stable with managed exposure; cash gate independently reflects withdrawals', t => {
  const [engine] = ready(t, 'live'); engine.positions.TEST = { symbol: 'TEST', quantity: 10, entry: 100, last: 100, stop: 98, strategy: 'intraday' };
  engine.account.margins.equity.available = { cash: 99000, live_balance: 99500 }; engine._update_capital(true); assert.equal(engine.capital, 100000); assert.equal(engine._broker_available_cash, 99000);
  engine.account.margins.equity.available = { cash: 0, live_balance: 0 }; engine._update_capital(true); assert.equal(engine.capital, 100000); assert.equal(engine._available_cash(), 0);
});
test('strategy percentages derive actual money and legacy amounts migrate to proportions', t => {
  const [engine, store] = ready(t); store.set('strategy_settings', { intraday_enabled: true, swing_enabled: true, intraday_allocation_pct: .6, swing_allocation_pct: .3 });
  assert.equal(engine.strategy_settings().intraday_capital, 60000); assert.equal(engine.strategy_settings().swing_capital, 30000); engine.capital = 200000; assert.equal(engine.strategy_settings().swing_capital, 60000);
  store.set('strategy_settings', { intraday_enabled: true, swing_enabled: true, intraday_capital: 20000, swing_capital: 30000 }); assert.equal(engine.strategy_settings().intraday_allocation_pct, .4); assert.equal(store.get('strategy_settings').intraday_capital, undefined);
});
test('engine passes derived swing allocation into real delivery lifecycle through confirmed fill and GTT', async t => {
  const [engine, store] = ready(t, 'live'); store.set('strategy_settings', { intraday_enabled: false, swing_enabled: true, intraday_allocation_pct: 0, swing_allocation_pct: 1 });
  const orders = [], gtts = [], calls = [];
  const broker = { async call(method, ...args) {
    calls.push(method);
    if (method === 'profile') return { meta: { demat_consent: 'physical' } };
    if (method === 'orders') return clone(orders);
    if (method === 'holdings') return [];
    if (method === 'positions') return { net: orders.length ? [{ exchange: 'NSE', tradingsymbol: 'TEST', product: 'CNC', quantity: orders[0].filled_quantity }] : [] };
    if (method === 'get_gtts') return clone(gtts);
    if (method === 'get_gtt') return clone(gtts[0]);
    if (method === 'quote') return { 'NSE:TEST': { timestamp: NOW, last_price: 100, depth: { buy: [{ price: 99.95, quantity: 1000 }] } } };
    if (method === 'place_order') { const p = args[0]; orders.push({ ...p, order_id: 'cnc-1', status: 'COMPLETE', average_price: p.price, filled_quantity: p.quantity, pending_quantity: 0 }); return 'cnc-1'; }
    if (method === 'place_gtt') { const p = args[0]; gtts.push({ id: 1, status: 'active', type: p.trigger_type, condition: { exchange: p.exchange, tradingsymbol: p.tradingsymbol, trigger_values: p.trigger_values, last_price: p.last_price }, orders: p.orders }); return { trigger_id: 1 }; }
    throw new Error(method);
  } };
  engine.broker = engine.delivery.broker = broker;
  assert.match(await engine._enter_locked(1, signal('swing')), /^delivery_protected/);
  assert.equal(calls.filter(c => c === 'place_order').length, 1); assert.equal(calls.filter(c => c === 'place_gtt').length, 1);
  assert.equal(engine.positions.TEST.quantity, orders[0].filled_quantity); assert.equal(engine.positions.TEST.protection, '1'); assert.equal(store.get('strategy_settings').swing_capital, undefined);
});
test('fully invested account can start managing authorized settled holdings with zero new-buy allocation', async t => {
  const broker = new RecoveryBroker(), store = new MemoryStore(); broker.current.margins.equity.available = { cash: 0, live_balance: 0 };
  broker.current.holdings = [{ exchange: 'NSE', tradingsymbol: 'TEST', product: 'CNC', quantity: 10, instrument_token: 22 }];
  store.set('strategy_settings', { intraday_enabled: true, swing_enabled: false, intraday_allocation_pct: 1, swing_allocation_pct: 0, manage_existing_holdings: 'selected', managed_symbols: ['TEST'] });
  const engine = new TradingEngine(settings(temp(t), 'live'), store, options({ brokerFactory: () => broker })); await engine.connect('session', 'AB1234'); await engine.start();
  assert.equal(engine.running, true); assert.equal(engine.capital, 0); assert.equal(engine.recovery.blocked, true); assert.deepEqual(engine._managed_recovery_symbols(), { TEST: true });
  assert.equal(await engine._enter_locked(22, signal()), 'invalid_capital_allocation'); assert.match(engine.message, /Holding management armed/); await engine.shutdown();
});
test('zero-cash account cannot adopt unselected, pledged, T1-only or discrepant shares', async t => {
  const broker = new RecoveryBroker(), store = new MemoryStore(); broker.current.margins.equity.available = { cash: 0, live_balance: 0 };
  broker.current.holdings = [{ exchange: 'NSE', tradingsymbol: 'UNSELECTED', quantity: 10 }, { exchange: 'NSE', tradingsymbol: 'PLEDGED', quantity: 10, collateral_quantity: 10 }, { exchange: 'NSE', tradingsymbol: 'UNSETTLED', quantity: 0, t1_quantity: 10 }, { exchange: 'NSE', tradingsymbol: 'DISCREPANT', quantity: 10, discrepancy: true }];
  store.set('strategy_settings', { intraday_enabled: true, swing_enabled: false, intraday_allocation_pct: 1, swing_allocation_pct: 0, manage_existing_holdings: 'selected', managed_symbols: ['PLEDGED', 'UNSETTLED', 'DISCREPANT'] });
  const engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker })); await engine.connect('session', 'AB1234'); await assert.rejects(engine.start(), /no verified available cash/); assert.equal(engine.running, false); await engine.shutdown();
});
test('zero-cash legacy paper exposure resumes exit management without replenishing funds', async t => {
  const broker = new RecoveryBroker(), store = new MemoryStore(); broker.current.margins.equity.available = { cash: 0, live_balance: 0 };
  store.set('bot_state_paper', { day: dateIST(NOW), capital: 0, positions: { TEST: { symbol: 'TEST', token: 22, strategy: 'intraday', quantity: 4, entry: 100, last: 100, stop: 98, target: 104, opened_at: isoIST(NOW) } } });
  const engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker })); await engine.connect('session', 'AB1234'); await engine.start(); assert.equal(engine.running, true); assert.equal(engine.capital, 0);
  engine._on_ticks([{ instrument_token: 22, exchange_timestamp: NOW, last_price: 95, volume_traded: 1000, depth: { buy: [{ price: 94.95, quantity: 100 }], sell: [{ price: 95.05, quantity: 100 }] } }]); await engine._run_once(); assert.deepEqual(engine.positions, {}); assert.ok(engine.realised < 0); await engine.shutdown();
});
