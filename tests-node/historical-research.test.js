import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HistoricalResearch } from '../src/historical-research.js';
import { Store } from '../src/storage.js';
import { STRATEGY_VERSION } from '../src/strategy.js';

const NOW = new Date('2026-09-17T11:30:00+05:30');
function candles(date = '2026-09-16') {
  return Array.from({ length: 75 }, (_, i) => {
    const price = i < 20 ? 100 : 100.6;
    return { date: new Date(+new Date(date + 'T09:15:00+05:30') + i * 300000),
      open: i === 20 ? 100.1 : price, high: i === 20 ? 100.6 : price + .1,
      low: i === 20 ? 100.1 : price - .1, close: price, volume: i === 20 ? 3000 : 1000 };
  });
}
const report = () => ({ strategy_version: STRATEGY_VERSION, baseline: { metrics: { trade_count: 1 }, trades: [], equity: [] }, enhanced: { metrics: { trade_count: 2 }, trades: [], equity: [] }, dataset: {}, caveats: [] });
class FakeWorker {
  constructor(complete = true) { this.complete = complete; this.inputs = []; this.cancelled = 0; this.job = { status: 'idle', progress: 0 }; }
  start(dataset, options) { this.inputs.push(structuredClone({ dataset, options })); this.job = this.complete ? { status: 'complete', progress: 1, result: report() } : { status: 'running', progress: .5 }; return this.status(); }
  status() { return structuredClone(this.job); }
  async cancel() { this.cancelled++; this.job = { status: 'cancelled', progress: 0 }; }
  async close() { await this.cancel(); }
}
function context(t, { worker = new FakeWorker(), settings: changed = {}, broker: supplied } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stock-research-')), store = new Store(join(dir, 'state.sqlite'));
  const calls = [], broker = supplied ?? { async call(...args) { calls.push(args); return candles(); } };
  const settings = { auto_research: true, research_symbols: 2, research_days: 10, research_fee_rate: .001, research_slippage_rate: .0005,
    risk_per_trade_pct: .0025, max_position_pct: .1, max_positions: 5, entry_cutoff: '14:45', exit_time: '15:10', ...changed };
  const engine = { connected: true, broker, capital: 120000,
    universe: { 99: { tradingsymbol: 'TCS' }, 12: { tradingsymbol: 'INFY' }, 1: { tradingsymbol: 'ABC' } },
    strategy_settings: () => ({ intraday_enabled: true, swing_enabled: false }), _strategy_options: () => ({ enhanced_signals: true, min_signal_score: 60 }) };
  const research = new HistoricalResearch(engine, store, settings, { worker, now: () => NOW, delay: 0 });
  t.after(async () => { await research.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { research, worker, engine, store, settings, calls };
}
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await delay(5); assert.ok(predicate(), 'Expected asynchronous stage was reached'); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('historical collection samples bounded alphabetical universe and cannot submit broker orders', async t => {
  const { research, worker, calls, store } = context(t);
  research.start(); await research.task;
  assert.deepEqual(calls.map(c => c[0]), ['historical_data', 'historical_data']);
  assert.deepEqual(calls.map(c => c[1]), [1, 12]);
  assert.equal(calls[0][4], '5minute');
  assert.equal(calls[0][2].toISOString(), new Date('2026-09-07T00:00:00+05:30').toISOString());
  assert.equal(calls[0][3].toISOString(), new Date('2026-09-16T23:59:59+05:30').toISOString());
  assert.deepEqual(Object.keys(worker.inputs[0].dataset.symbols), ['ABC', 'INFY']);
  assert.equal(worker.inputs[0].options.initial_capital, 120000);
  const state = research.status(); assert.equal(state.status, 'complete'); assert.equal(state.progress, 100);
  assert.match(state.report.metadata.selection, /Alphabetical/); assert.match(state.report.metadata.live_controls, /not reconstructed/);
  assert.deepEqual(store.get('research_report'), state.report);
  assert.equal(Object.hasOwn(worker.inputs[0], 'broker'), false);
});

test('collection excludes current-day and out-of-window bars and reuses only same-day range cache', async t => {
  let calls = 0;
  const broker = { async call() { calls++; return [...candles('2026-09-01'), ...candles(), ...candles('2026-09-17')]; } };
  const { research, worker, settings } = context(t, { broker, settings: { research_symbols: 1 } });
  research.start(); await research.task;
  assert.equal(worker.inputs[0].dataset.symbols.ABC.length, 75);
  assert.ok(worker.inputs[0].dataset.symbols.ABC.every(row => row.time.startsWith('2026-09-16')));
  research.start(); await research.task; assert.equal(calls, 1);
  settings.research_days = 11; research.start(); await research.task; assert.equal(calls, 2);
});

test('daily-only scope requests completed daily candles with a sufficient calendar window', async t => {
  const { research, engine, worker, calls } = context(t, { settings: { research_symbols: 1 } });
  engine.strategy_settings = () => ({ intraday_enabled: false, swing_enabled: true });
  research.start(); await research.task;
  assert.equal(calls[0][4], 'day'); assert.equal(+calls[0][3] - +calls[0][2], 70 * 86400000 - 1000);
  assert.equal(worker.inputs[0].dataset.interval, 'day'); assert.match(research.status().report.metadata.scope, /Swing/);
});

test('both enabled scopes run sequentially and persist paired reports only after both complete',async t=>{
  const {research,engine,worker,store}=context(t,{settings:{research_symbols:1}});
  engine.strategy_settings=()=>({intraday_enabled:true,swing_enabled:true});research.start();await research.task;
  assert.deepEqual(worker.inputs.map(i=>i.dataset.interval),['5minute','day']);
  assert.equal(research.status().report.dataset.interval,'5minute');assert.equal(research.status().report.alternate_reports.day.dataset.interval,'day');
  assert.deepEqual(store.get('research_report'),research.status().report);assert.equal(research.status().status,'complete');
});

test('historical relative context uses verified index identity, matching range and completed candles',async t=>{
  const calls=[],broker={async call(...args){calls.push(args);return args[0]==='quote'?{'NSE:NIFTY 50':{instrument_token:500},'NSE:NIFTY IT':{instrument_token:501}}:[...candles(),...candles('2026-09-17')];}};
  const {research,engine,worker}=context(t,{broker,settings:{research_symbols:1}});
  engine.market_context={forSymbol:()=>({index_membership:[{index:'NIFTY IT',status:'fresh'}]})};research.start();await research.task;
  const data=worker.inputs[0].dataset;assert.equal(data.benchmark_bars.length,75);assert.equal(data.sector_bars['NIFTY IT'].length,75);assert.equal(data.symbol_sectors.ABC,'NIFTY IT');
  assert.ok(data.benchmark_bars.every(r=>r.time.startsWith('2026-09-16')));assert.deepEqual(calls.map(c=>c[0]),['historical_data','quote','historical_data','historical_data']);
  assert.equal(research.status().report.metadata.context.benchmark,'NIFTY 50');
});

test('missing benchmark history is visible and cannot fabricate relative-strength context',async t=>{
  const broker={async call(method){return method==='quote'?{}:candles();}};
  const {research,engine,worker}=context(t,{broker,settings:{research_symbols:1}});engine.market_context={forSymbol:()=>({index_membership:[]})};
  research.start();await research.task;assert.deepEqual(worker.inputs[0].dataset.benchmark_bars,[]);assert.deepEqual(research.status().report.metadata.context.unavailable,['NIFTY 50']);
});

test('one unavailable symbol is recorded without hiding available dataset coverage', async t => {
  const broker = { async call(_method, token) { if (token === 1) throw new Error('History unavailable'); return candles(); } };
  const { research, worker } = context(t, { broker }); research.start(); await research.task;
  assert.equal(research.status().status, 'complete');
  assert.deepEqual(Object.keys(worker.inputs[0].dataset.symbols), ['INFY']);
  assert.deepEqual(research.status().report.dataset.errors, ['ABC']);
});

test('invalid account session stops collection without running CPU research', async t => {
  const broker = { async call() { throw Object.assign(new Error('Do not log API credentials'), { kind: 'TokenException' }); } };
  const { research, worker, store } = context(t, { broker }); research.start(); await research.task;
  assert.equal(research.status().status, 'failed'); assert.equal(worker.inputs.length, 0);
  assert.equal(JSON.stringify(store.events()).includes('Do not log API credentials'), false);
});

test('automatic research signature suppresses repeats until strategy options change', async t => {
  const { research, worker, engine } = context(t); await research.maybeStart(); await research.task;
  await research.maybeStart(); assert.equal(worker.inputs.length, 1);
  engine._strategy_options = () => ({ enhanced_signals: true, min_signal_score: 80 });
  await research.maybeStart(); await research.task; assert.equal(worker.inputs.length, 2);
});

test('cancelling idle research preserves idle state without recording a fake cancellation', async t => {
  const { research, worker, store } = context(t), initial = research.status();
  assert.equal(initial.status, 'idle');
  assert.deepEqual(await research.cancel(), initial);
  assert.deepEqual(research.status(), initial);
  assert.equal(worker.inputs.length, 0);
  assert.equal(store.events().some(event => event.kind === 'research.cancelled'), false);
});

test('cancelling completed research preserves its report and same-day automatic deduplication', async t => {
  const { research, worker, calls, store } = context(t);
  await research.maybeStart(); await research.task;
  const completed = research.status(), count = calls.length;
  assert.equal(completed.status, 'complete');
  assert.deepEqual(await research.cancel(), completed);
  await research.maybeStart();
  assert.deepEqual(research.status(), completed);
  assert.deepEqual(store.get('research_report'), completed.report);
  assert.equal(worker.inputs.length, 1); assert.equal(calls.length, count);
});

test('previous compact report is restored without requesting any historical data', async t => {
  const { research, store, calls, engine, settings } = context(t);
  research.start(); await research.task;
  const count = calls.length;
  const restored = new HistoricalResearch(engine, store, settings, { worker: new FakeWorker(), now: () => NOW, delay: 0 });
  t.after(() => restored.close());
  assert.equal(restored.status().status, 'complete');
  assert.deepEqual(restored.status().report, store.get('research_report'));
  assert.equal(calls.length, count);
});

test('worker progress is mapped to dashboard percent and final result retained', async t => {
  const worker = new FakeWorker(false), { research } = context(t, { worker, settings: { research_symbols: 1 } });
  research.start(); await until(() => research.status().status === 'running');
  assert.equal(research.status().progress, 75);
  worker.job = { status: 'complete', progress: 1, result: report() };
  await research.task; assert.equal(research.status().progress, 100);
});

test('cancelling collection retains prior report and ignores a late broker response', async t => {
  const pending = deferred(), broker = { call: () => pending.promise };
  const { research, worker, store } = context(t, { broker });
  research.state.report = { marker: 'previous' }; research.start(); const task = research.task;
  await research.cancel(); pending.resolve(candles()); await task;
  assert.equal(research.status().status, 'cancelled'); assert.deepEqual(research.status().report, { marker: 'previous' });
  assert.equal(worker.inputs.length, 0); assert.equal(store.get('research_history:1:5minute'), null);
});

test('reconnected account generation cannot publish the previous broker response into a new run', async t => {
  const pending = deferred(), oldBroker = { call: () => pending.promise };
  const { research, worker, engine } = context(t, { broker: oldBroker, settings: { research_symbols: 1 } });
  research.start(); const oldTask = research.task;
  await research.cancel(); engine.broker = { async call() { return candles(); } };
  research.start(); await research.task;
  assert.equal(worker.inputs.length, 1); const completed = research.status();
  pending.resolve(candles('2026-09-15')); await oldTask;
  assert.deepEqual(research.status(), completed);
  assert.equal(worker.inputs.length, 1);
});

test('broker replacement during collection cancels rather than sending a stale dataset to worker', async t => {
  const pending = deferred(), broker = { call: () => pending.promise };
  const { research, engine, worker } = context(t, { broker }); research.start();
  engine.broker = { async call() { return candles(); } }; pending.resolve(candles()); await research.task;
  assert.equal(research.status().status, 'cancelled'); assert.equal(worker.inputs.length, 0);
});

test('report persistence caps displayed trade and equity histories while preserving full metrics', async t => {
  const worker = new FakeWorker();
  worker.start = function(data, options) {
    this.inputs.push({ dataset: data, options }); const value = report();
    value.baseline.metrics.trade_count = 250;
    value.baseline.trades = Array.from({ length: 250 }, (_, id) => ({ id }));
    value.baseline.equity = Array.from({ length: 3000 }, (_, id) => ({ id, equity: 100000 + id }));
    this.job = { status: 'complete', progress: 1, result: value };
  };
  const { research, store } = context(t, { worker }); research.start(); await research.task;
  const saved = store.get('research_report');
  assert.equal(saved.baseline.trades.length, 100); assert.equal(saved.baseline.metrics.trade_count, 250);
  assert.ok(saved.baseline.equity.length <= 1001); assert.equal(saved.baseline.equity.at(-1).id, 2999);
});

test('report preserves observed dataset bounds separately from the requested history window', async t => {
  const worker = new FakeWorker(), observed = { from: '2026-09-16T03:45:00.000Z', to: '2026-09-16T09:55:00.000Z' };
  worker.start = function(data, options) {
    this.inputs.push({ dataset: data, options });
    this.job = { status: 'complete', progress: 1, result: { ...report(), dataset: observed } };
  };
  const { research, store } = context(t, { worker }); research.start(); await research.task;
  const saved = store.get('research_report');
  assert.equal(saved.dataset.from, observed.from); assert.equal(saved.dataset.to, observed.to);
  assert.equal(+new Date(saved.dataset.requested_from), +new Date('2026-09-07T00:00:00+05:30'));
  assert.equal(+new Date(saved.dataset.requested_to), +new Date('2026-09-16T23:59:59+05:30'));
});

test('collection prerequisites cannot start offline or with no verified funds', async t => {
  const { research, engine, worker } = context(t); engine.connected = false;
  assert.throws(() => research.start(), /Connect Zerodha/); engine.connected = true; engine.capital = 0;
  assert.throws(() => research.start(), /verified positive/); assert.equal(worker.inputs.length, 0);
});

test('real worker consumes fixture candles from read-only collector and persists a report', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'stock-research-worker-')), store = new Store(join(dir, 'state.sqlite'));
  const calls = [], engine = { connected: true, capital: 100000, universe: { 1: { tradingsymbol: 'INFY' } },
    broker: { async call(...args) { calls.push(args); return candles(); } },
    strategy_settings: () => ({ intraday_enabled: true }), _strategy_options: () => ({ enhanced_signals: true }) };
  const settings = { auto_research: true, research_symbols: 1, research_days: 10, research_fee_rate: .001, research_slippage_rate: .0005,
    risk_per_trade_pct: .0025, max_position_pct: .1, max_positions: 5, entry_cutoff: '14:45', exit_time: '15:10' };
  const research = new HistoricalResearch(engine, store, settings, { now: () => NOW, delay: 0 });
  t.after(async () => { await research.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  research.start(); await research.task;
  assert.equal(research.status().status, 'complete'); assert.equal(research.status().progress, 100);
  assert.equal(research.status().report.baseline.metrics.trade_count, 1);
  assert.equal(research.status().report.dataset.bar_count, 75);
  assert.ok(store.get('research_report').caveats.length > 0);
  assert.deepEqual(calls.map(c => c[0]), ['historical_data']);
});
