import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HistoricalResearch } from '../src/historical-research.js';
import { ResearchService } from '../src/research.js';
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
function dailyCandles() {
  return Array.from({length:56},(_,i)=>({date:new Date(+new Date('2026-09-16T00:00:00+05:30')-(55-i)*86400000),
    open:100,high:101,low:99,close:100,volume:1000}));
}
const report = () => ({ strategy_version: STRATEGY_VERSION, baseline: { metrics: { trade_count: 1 }, trades: [], equity: [] }, enhanced: { metrics: { trade_count: 2 }, trades: [], equity: [] }, dataset: {}, caveats: [] });
class FakeWorker {
  constructor(complete = true) { this.complete = complete; this.inputs = []; this.cancelled = 0; this.job = { status: 'idle', progress: 0 }; }
  start(dataset, options) { this.inputs.push(structuredClone({ dataset, options })); this.job = this.complete ? { status: 'complete', progress: 1, result: report() } : { status: 'running', progress: .5 }; return this.status(); }
  status() { return structuredClone(this.job); }
  async cancel() { this.cancelled++; this.job = { status: 'cancelled', progress: 0 }; }
  async close() { await this.cancel(); }
}
function context(t, { worker = new FakeWorker(), settings: changed = {}, broker: supplied, options = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stock-research-')), store = new Store(join(dir, 'state.sqlite'));
  const calls = [], broker = supplied ?? { async call(...args) { calls.push(args); return args[4]==='day'?dailyCandles():candles(); } };
  const settings = { auto_research: true, research_symbols: 2, research_days: 10, research_fee_rate: .001, research_slippage_rate: .0005,
    risk_per_trade_pct: .0025, max_position_pct: .1, max_positions: 5, entry_cutoff: '14:45', exit_time: '15:10', ...changed };
  const engine = { connected: true, broker, capital: 120000,
    universe: { 99: { tradingsymbol: 'TCS' }, 12: { tradingsymbol: 'INFY' }, 1: { tradingsymbol: 'ABC' } },
    strategy_settings: () => ({ intraday_enabled: true, swing_enabled: false }), _strategy_options: () => ({ enhanced_signals: true, min_signal_score: 60 }) };
  const research = new HistoricalResearch(engine, store, settings, { worker, now: () => NOW, delay: 0, ...options });
  t.after(async () => { await research.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { research, worker, engine, store, settings, calls };
}
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await delay(5); assert.ok(predicate(), 'Expected asynchronous stage was reached'); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class FakeClock {
  constructor(){this.time=+NOW;this.timers=new Set();}
  now=()=>new Date(this.time);
  setTimer=(fn,ms)=>{const timer={fn,at:this.time+ms,unref(){}};this.timers.add(timer);return timer;};
  clearTimer=timer=>this.timers.delete(timer);
  options(){return {now:this.now,monotonicNow:()=>this.time,setTimer:this.setTimer,clearTimer:this.clearTimer,pollInterval:1000,retryBase:2000,retryMax:8000};}
  async advance(ms){this.time+=ms;for(const timer of [...this.timers].filter(timer=>timer.at<=this.time)){this.timers.delete(timer);await timer.fn();}}
}

test('historical collection bounds an explicitly unclassified fallback and cannot submit broker orders', async t => {
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
  assert.equal(state.report.metadata.diversification.status, 'unclassified'); assert.match(state.report.metadata.live_controls, /not reconstructed/);
  assert.deepEqual(store.get('research_report'), state.report);
  assert.equal(Object.hasOwn(worker.inputs[0], 'broker'), false);
});

test('background research summary identifies the download in flight and excludes the full report',async t=>{
  const pending=deferred(),{research}=context(t,{broker:{call:()=>pending.promise}});
  research.start();
  await until(()=>research.summary().message.includes('research candles for ABC'));
  const summary=research.summary();assert.equal(summary.status,'collecting');assert.equal(summary.progress,0);assert.equal(Object.hasOwn(summary,'report'),false);
  assert.deepEqual(summary.progress_detail,{scope:'overall',stage:'Intraday stock history',stage_progress:0,completed:0,total:2,unit:'symbols checked'});
  assert.equal(summary.current_task.title,'Downloading ABC candles');assert.match(summary.current_task.detail,/five-minute.*ABC/);
  assert.equal(summary.automation.reason,summary.current_task.title);
  const cancellation=research.cancel();pending.resolve(candles());await cancellation;await research.task;
  assert.equal(research.summary().status,'cancelled');assert.equal(research.summary().current_task,null);
});

test('research excludes recovery-only instruments before sampling without removing account exposure',async t=>{
  const {research,engine,worker,calls}=context(t);
  engine.universe={
    20:{tradingsymbol:'AAA',entry_eligible:false},
    21:{tradingsymbol:'BBB',entry_eligible:true},
    22:{tradingsymbol:'CCC'},
    23:{tradingsymbol:'DDD',entry_eligible:true},
  };
  research.start();await research.task;
  assert.equal(research.status().status,'complete');
  assert.deepEqual(calls.map(call=>call[1]),[21,22]);
  assert.deepEqual(Object.keys(worker.inputs[0].dataset.symbols),['BBB','CCC']);
  assert.deepEqual(research.status().report.metadata.requested_symbols,['BBB','CCC']);
  assert.equal(engine.universe[20].entry_eligible,false,'Recovery-only account instrument remains in engine state');
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

for(const symbol of [undefined,'OLD'])test(`${symbol?'foreign-symbol':'unbound legacy'} research history must refetch before reuse`,async t=>{
  const {research,worker,store,calls}=context(t,{settings:{research_symbols:1}});
  store.set('research_history:1:5minute',{date:'2026-09-17',from:'2026-09-07T00:00:00+05:30',symbol,rows:candles().map(row=>({...row,open:80,high:81,low:79,close:80}))});
  research.start();await research.task;
  assert.equal(research.status().status,'complete');assert.equal(calls.length,1);
  assert.equal(worker.inputs[0].dataset.symbols.ABC[0].close,100);
  assert.equal(store.get('research_history:1:5minute').symbol,'ABC');
  research.start();await research.task;assert.equal(calls.length,1);
});

test('changed stock identity invalidates automatic deduplication and cannot reuse another symbol history',async t=>{
  const {research,engine,worker,store,calls}=context(t,{settings:{research_symbols:1}});
  await research.maybeStart();await research.task;assert.equal(calls.length,1);
  engine.universe[1]={tradingsymbol:'AAB',entry_eligible:true};
  await research.maybeStart();await research.task;
  assert.equal(calls.length,2);assert.deepEqual(Object.keys(worker.inputs[1].dataset.symbols),['AAB']);
  assert.equal(store.get('research_history:1:5minute').symbol,'AAB');
  assert.deepEqual(research.status().report.metadata.requested_symbols,['AAB']);
});

for(const [label,firstRows] of [
  ['empty',()=>[]],
  ['malformed',()=>candles().map((row,i)=>i===3?{...row,low:row.high+1}:row)],
])test(`${label} history recovers on retry without poisoning the cache or valid peers`,async t=>{
  const requests=new Map(),broker={async call(_method,token){const n=(requests.get(token)||0)+1;requests.set(token,n);return token===1&&n===1?firstRows():candles();}};
  const {research,worker,store}=context(t,{broker});
  research.start();await research.task;
  assert.equal(research.status().status,'complete');assert.deepEqual(research.status().report.dataset.errors,['ABC']);
  assert.equal(store.get('research_history:1:5minute'),null);
  research.start();await research.task;
  assert.equal(research.status().status,'complete');assert.deepEqual(research.status().report.dataset.errors,[]);
  assert.deepEqual(Object.keys(worker.inputs.at(-1).dataset.symbols),['ABC','INFY']);
  assert.equal(requests.get(1),2);assert.equal(requests.get(12),1);
});

test('an empty first run preserves its retry delay and recovers after service restart',async t=>{
  let calls=0;const broker={async call(){return ++calls===1?[]:candles();}};
  const {research,store,engine,settings}=context(t,{broker,settings:{research_symbols:1}});
  await research.maybeStart();await research.task;assert.equal(research.status().status,'failed');
  assert.equal(store.get('research_auto_signature'),null);assert.equal(store.get('research_history:1:5minute'),null);
  await research.close();
  let now=NOW;const restored=new HistoricalResearch(engine,store,settings,{worker:new FakeWorker(),now:()=>now,delay:0});
  t.after(()=>restored.close());await restored.maybeStart();assert.equal(calls,1);assert.equal(restored.status().automation.status,'retry_wait');
  now=new Date(+NOW+60000);await restored.maybeStart();await restored.task;
  assert.equal(restored.status().status,'complete');assert.equal(calls,2);
});

const invalidHistoryCaches=[
  ['empty',()=>[]],
  ['non-array',()=>({bad:true})],
  ['invalid OHLCV',()=>candles().map((row,i)=>i===3?{...row,close:null}:row)],
  ['duplicate timestamp',()=>[candles()[0],...candles()]],
  ['invalid calendar date',()=>[{...candles()[0],date:'2026-09-31T09:15:00+05:30'}]],
  ['off-grid candle',()=>[{...candles()[0],date:'2026-09-16T09:16:00+05:30'}]],
  ['outside the regular session',()=>[{...candles()[0],date:'2026-09-16T15:30:00+05:30'}]],
  ['outside the requested interval',()=>candles('2026-09-01')],
  ['unfinished current day',()=>candles('2026-09-17')],
  ['oversized',()=>Array(5001).fill(candles()[0])],
];
for(const [label,rows] of invalidHistoryCaches)test(`legacy ${label} same-day cache is bypassed and replaced`,async t=>{
  const {research,worker,store,calls}=context(t,{settings:{research_symbols:1}});
  store.set('research_history:1:5minute',{date:'2026-09-17',from:'2026-09-07T00:00:00+05:30',symbol:'ABC',rows:rows()});
  research.start();await research.task;
  assert.equal(research.status().status,'complete');assert.equal(calls.length,1);
  assert.equal(worker.inputs[0].dataset.symbols.ABC.length,75);
  assert.equal(store.get('research_history:1:5minute').rows.length,75);
  research.start();await research.task;assert.equal(calls.length,1,'Valid replacement stays cached');
});

test('valid sparse history remains cached for causal missing-candle reporting',async t=>{
  let calls=0;const sparse=candles().filter((_,i)=>i!==20),broker={async call(){calls++;return sparse;}};
  const {research,worker}=context(t,{broker,settings:{research_symbols:1}});
  research.start();await research.task;research.start();await research.task;
  assert.equal(calls,1);assert.equal(worker.inputs[0].dataset.symbols.ABC.length,74);
  assert.deepEqual(worker.inputs[1].dataset.symbols,worker.inputs[0].dataset.symbols);
});

test('duplicate daily dates cannot persist a worker-invalid cache',async t=>{
  const {research,engine,store,calls}=context(t,{settings:{research_symbols:1}});
  engine.strategy_settings=()=>({intraday_enabled:false,swing_enabled:true});
  store.set('research_history:1:day',{date:'2026-09-17',from:'2026-07-09T00:00:00+05:30',symbol:'ABC',rows:[
    {...candles()[0],date:'2026-09-16T00:00:00+05:30'},
    {...candles()[0],date:'2026-09-16T09:15:00+05:30'},
  ]});
  research.start();await research.task;
  assert.equal(research.status().status,'complete');assert.equal(calls.length,1);
  assert.equal(store.get('research_history:1:day').rows.length,56);
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
  const data=worker.inputs[0].dataset;assert.equal(data.benchmark_bars.length,75);assert.equal(data.sector_bars['NIFTY IT'].length,75);assert.equal(data.symbol_sectors[research._selection()[0][1].tradingsymbol],'NIFTY IT');
  assert.ok(data.benchmark_bars.every(r=>r.time.startsWith('2026-09-16')));assert.deepEqual(calls.map(c=>c[0]),['historical_data','quote','historical_data','historical_data']);
  assert.equal(research.status().report.metadata.context.benchmark,'NIFTY 50');
});

test('research index caches are bound to verified index names rather than recycled numeric tokens',async t=>{
  const calls=[],broker={async call(method,token){calls.push([method,token]);return method==='quote'?{'NSE:NIFTY 50':{instrument_token:500},'NSE:NIFTY IT':{instrument_token:501}}:candles();}};
  const {research,engine,worker,store}=context(t,{broker,settings:{research_symbols:1}});
  engine.market_context={forSymbol:()=>({index_membership:[{index:'NIFTY IT',status:'fresh'}]})};
  store.set('research_index:500:5minute',{date:'2026-09-17',from:'2026-09-07T00:00:00+05:30',symbol:'NIFTY BANK',rows:candles()});
  store.set('research_index:501:5minute',{date:'2026-09-17',from:'2026-09-07T00:00:00+05:30',rows:candles()});
  research.start();await research.task;
  assert.equal(research.status().status,'complete');assert.equal(worker.inputs[0].dataset.benchmark_bars.length,75);
  assert.deepEqual(calls.filter(([method])=>method==='historical_data').map(([,token])=>token),[Number(research._selection()[0][0]),500,501]);
  assert.equal(store.get('research_index:500:5minute').symbol,'NIFTY 50');assert.equal(store.get('research_index:501:5minute').symbol,'NIFTY IT');
  research.start();await research.task;assert.equal(calls.filter(([method])=>method==='historical_data').length,3);
});

test('missing benchmark history is visible and cannot fabricate relative-strength context',async t=>{
  const broker={async call(method){return method==='quote'?{}:candles();}};
  const {research,engine,worker}=context(t,{broker,settings:{research_symbols:1}});engine.market_context={forSymbol:()=>({index_membership:[]})};
  research.start();await research.task;assert.deepEqual(worker.inputs[0].dataset.benchmark_bars,[]);assert.deepEqual(research.status().report.metadata.context.unavailable,['NIFTY 50']);
});

test('empty and malformed index responses recover while valid symbol history remains cached',async t=>{
  const requests=new Map(),broker={async call(method,token){
    if(method==='quote')return {'NSE:NIFTY 50':{instrument_token:500},'NSE:NIFTY IT':{instrument_token:501}};
    const n=(requests.get(token)||0)+1;requests.set(token,n);
    if(token===500&&n===1)return [];
    if(token===501&&n===1)return [{...candles()[0],volume:-1}];
    return candles();
  }};
  const {research,engine,worker,store}=context(t,{broker,settings:{research_symbols:1}});
  engine.market_context={forSymbol:()=>({index_membership:[{index:'NIFTY IT',status:'fresh'}]})};
  research.start();await research.task;
  assert.equal(research.status().status,'complete');assert.deepEqual(research.status().report.metadata.context.unavailable,['NIFTY 50','NIFTY IT']);
  assert.equal(store.get('research_index:500:5minute'),null);assert.equal(store.get('research_index:501:5minute'),null);
  // An older version may already have persisted the unusable result. A manual
  // rerun must bypass that cache as well as avoiding new negative cache entries.
  store.set('research_index:500:5minute',{date:'2026-09-17',from:'2026-09-07T00:00:00+05:30',symbol:'NIFTY 50',rows:[]});
  store.set('research_index:501:5minute',{date:'2026-09-17',from:'2026-09-07T00:00:00+05:30',symbol:'NIFTY IT',rows:[{...candles()[0],volume:-1}]});
  research.start();await research.task;
  const input=worker.inputs.at(-1).dataset;
  assert.equal(input.benchmark_bars.length,75);assert.equal(input.sector_bars['NIFTY IT'].length,75);
  assert.deepEqual(research.status().report.metadata.context.unavailable,[]);
  assert.equal(requests.get(Number(research._selection()[0][0])),1);assert.equal(requests.get(500),2);assert.equal(requests.get(501),2);
  research.start();await research.task;assert.equal(requests.get(500),2);assert.equal(requests.get(501),2);
});

test('real worker accepts unavailable sector history as absent context rather than an invalid symbol mapping',async t=>{
  const broker={async call(method,token){
    if(method==='quote')return {'NSE:NIFTY 50':{instrument_token:500},'NSE:NIFTY IT':{instrument_token:501}};
    if(token===501)throw new Error('Sector history temporarily unavailable');
    return candles();
  }};
  const {research,engine}=context(t,{broker,worker:new ResearchService(),settings:{research_symbols:1}});
  engine.market_context={forSymbol:()=>({index_membership:[{index:'NIFTY IT',status:'fresh'}]})};
  research.start();await research.task;
  assert.equal(research.status().status,'complete');
  assert.deepEqual(research.status().report.metadata.context.unavailable,['NIFTY IT']);
  assert.equal(research.status().report.metadata.context.benchmark,'NIFTY 50');
  assert.equal(research.status().report.dataset.bar_count,75);
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

test('comparison exposes separate CPU telemetry and passes automatic worker reservations',async t=>{
  const worker=new FakeWorker(false),{research,engine,settings}=context(t,{worker,settings:{research_symbols:1,research_tuning_workers:6,analytics_reserve_cpus:7}});
  engine.analytics={snapshot:()=>({active_jobs:2})};
  research.start();await until(()=>worker.inputs.length===1);
  assert.equal(worker.inputs[0].options.parallelism,6);assert.equal(worker.inputs[0].options.reserve_cpus,7);assert.equal(worker.inputs[0].options.live_workers,2);
  const capacity={kind:'comparison',worker_limit:6,usable_cpus:96},parallelism={worker_limit:6,active_workers:4,batch_completed_symbols:5,batch_total_symbols:20,batch_timestamp:'2026-09-16T04:00:00.000Z'};
  worker.job={status:'running',phase:'enhanced',progress:.8,processed_bars:45,total_bars:75,capacity,parallelism};
  await until(()=>research.summary().comparison?.phase==='enhanced');
  assert.deepEqual(research.summary().comparison,{phase:'enhanced',interval:'5minute',symbol_count:1,processed_bars:45,total_bars:75,capacity,parallelism});
  assert.equal(research.summary().progress,90);assert.equal(research.summary().progress_detail.stage_progress,60);
  assert.equal(research.summary().progress_detail.completed,45);assert.equal(research.summary().progress_detail.total,75);assert.equal(research.summary().progress_detail.unit,'candles');
  assert.equal(research.summary().tuning,null,'Comparison workers are not parameter candidates');
  worker.job={status:'complete',progress:1,result:report()};await research.task;
  assert.equal(research.summary().comparison,null);assert.equal(research.summary().progress_detail,null);assert.equal(settings.research_tuning_workers,6);
});

test('overall progress never resets between intraday and swing comparisons and titles follow real simulation work',async t=>{
  const worker=new FakeWorker(false),{research,engine}=context(t,{worker,settings:{research_symbols:1}});
  engine.strategy_settings=()=>({intraday_enabled:true,swing_enabled:true});
  const samples=[],update=research._progress.bind(research);research._progress=value=>{update(value);samples.push(research.state.progress);};
  research.start();await until(()=>worker.inputs.length===1&&research.state.progress===37.5);
  worker.job={status:'running',phase:'enhanced',progress:.75,processed_bars:38,total_bars:75};
  await until(()=>research.summary().current_task.title==='Simulating enhanced rules (intraday)');
  assert.match(research.summary().current_task.detail,/38 of 75 candles processed/);assert.equal(research.state.progress,43.8);
  worker.job={status:'complete',progress:1,result:report()};
  await until(()=>worker.inputs.length===2&&research.state.progress===87.5);
  assert.match(research.summary().current_task.title,/swing/);assert.match(research.summary().current_task.detail,/daily/);
  worker.job={status:'complete',progress:1,result:report()};await research.task;
  assert.ok(samples.every((value,index)=>index===0||value>=samples[index-1]));
  assert.ok(samples.every(value=>value<100),'Only the finished report can reach100%');
  assert.equal(research.status().progress,100);assert.equal(research.status().current_task,null);
});

test('benchmark lookup and index downloads have distinct current-task titles',async t=>{
  const identities=deferred(),history=deferred();
  const broker={call(method,token){return method==='quote'?identities.promise:token===500?history.promise:Promise.resolve(candles());}};
  const {research,engine}=context(t,{broker,settings:{research_symbols:1}});
  engine.market_context={forSymbol:()=>({index_membership:[]})};
  research.start();await until(()=>research.summary().current_task?.title==='Looking up benchmark and sector indexes');
  assert.equal(research.summary().progress,45);
  identities.resolve({'NSE:NIFTY 50':{instrument_token:500}});
  await until(()=>research.summary().current_task?.title==='Downloading NIFTY 50 index candles');
  assert.match(research.summary().current_task.detail,/0 of 1 indexes checked/);
  history.resolve(candles());await research.task;
  assert.equal(research.status().status,'complete');assert.equal(research.status().current_task,null);
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

for(const change of ['token reuse','universe generation','entry eligibility','date rollover'])test(`research drops late history after ${change}`,async t=>{
  const pending=deferred(),broker={call:()=>pending.promise};
  const {research,engine,worker,store}=context(t,{broker,settings:{research_symbols:1}});
  research.state.report={marker:'previous'};research.start();
  if(change==='token reuse')engine.universe[1].tradingsymbol='AAB';
  else if(change==='universe generation')engine._universe_generation=1;
  else if(change==='entry eligibility')engine.universe[1].entry_eligible=false;
  else research.now=()=>new Date(+NOW+86400000);
  pending.resolve(candles());await research.task;
  assert.equal(research.status().status,'cancelled');assert.equal(worker.inputs.length,0);
  assert.equal(store.get('research_history:1:5minute'),null);assert.equal(store.get('research_auto_signature'),null);
  assert.deepEqual(research.status().report,{marker:'previous'});
});

test('late index history cannot populate a cache after the universe refreshes',async t=>{
  const pending=deferred();let indexRequested=false;
  const broker={async call(method,token){if(method==='quote')return {'NSE:NIFTY 50':{instrument_token:500}};if(token===500){indexRequested=true;return pending.promise;}return candles();}};
  const {research,engine,worker,store}=context(t,{broker,settings:{research_symbols:1}});
  engine.market_context={forSymbol:()=>({index_membership:[]})};research.start();await until(()=>indexRequested);
  engine._universe_generation=1;pending.resolve(candles());await research.task;
  assert.equal(research.status().status,'cancelled');assert.equal(worker.inputs.length,0);assert.equal(store.get('research_index:500:5minute'),null);
});

test('a completed worker result from an older universe cannot become the current report',async t=>{
  const worker=new FakeWorker(false),{research,engine,store}=context(t,{worker,settings:{research_symbols:1}});
  research.start();await until(()=>research.status().status==='running');
  engine._universe_generation=1;worker.job={status:'complete',result:report()};await research.task;
  assert.equal(research.status().status,'cancelled');assert.equal(store.get('research_report'),null);assert.equal(store.get('research_auto_signature'),null);
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

test('automatic scheduler observes connected funds, eligible instruments and next-day comparisons without manual starts',async t=>{
  const clock=new FakeClock(),{research,engine,worker,calls}=context(t,{options:clock.options(),settings:{research_symbols:1}});
  engine.connected=false;engine.capital=0;engine.universe={1:{tradingsymbol:'ABC',entry_eligible:false}};
  await research.startAutomatic();await research.startAutomatic();assert.equal(clock.timers.size,1);
  assert.match(research.status().automation.reason,/Connect Zerodha/);assert.equal(calls.length,0);
  engine.connected=true;await clock.advance(1000);assert.match(research.status().automation.reason,/balance/);
  engine.capital=50000;await clock.advance(1000);assert.match(research.status().automation.reason,/instruments/);
  engine.universe[1].entry_eligible=true;await clock.advance(1000);await research.task;
  assert.equal(worker.inputs.length,1);assert.equal(worker.inputs[0].options.initial_capital,50000);
  const signature=research.signature();engine.strategy_settings=()=>({intraday_enabled:true,swing_enabled:false,intraday_capital:engine.capital,swing_capital:0});
  assert.equal(research.signature(),signature);engine.capital=65000;await clock.advance(1000);assert.equal(worker.inputs.length,1);
  await clock.advance(86400000);await research.task;assert.equal(worker.inputs.length,2);
  assert.deepEqual(calls.map(call=>call[0]),['historical_data','historical_data']);
  await research.close();assert.equal(clock.timers.size,0);await clock.advance(86400000);assert.equal(calls.length,2);
});

test('automatic history retries use persistent capped backoff and continue after a long outage',async t=>{
  const clock=new FakeClock();let calls=0,recovered=false;
  const {research,worker,store}=context(t,{options:clock.options(),settings:{research_symbols:1},broker:{async call(){calls++;return recovered?candles():[];}}});
  await research.startAutomatic();await research.task;
  for(const backoff of [2000,4000,8000,8000,8000]){
    const before=calls,status=research.status();assert.equal(status.status,'failed');assert.equal(status.automation.status,'retry_wait');
    assert.equal(+new Date(status.automation.next_retry_at)-clock.time,backoff);
    await clock.advance(backoff-1000);assert.equal(calls,before);
    await clock.advance(1000);await research.task;assert.equal(calls,before+1);
  }
  assert.equal(store.get('research_history:1:5minute'),null);recovered=true;
  await clock.advance(8000);await research.task;assert.equal(research.status().status,'complete');assert.equal(worker.inputs.length,1);
  const count=calls;await clock.advance(8000);assert.equal(calls,count);assert.equal(store.get('research_auto_retry'),null);
});

test('automatic partial reports remain complete and do not repeatedly retry missing peers',async t=>{
  const clock=new FakeClock(),requests=[];
  const {research,worker}=context(t,{options:clock.options(),broker:{async call(_method,token){requests.push(token);return token===1?[]:candles();}}});
  await research.startAutomatic();await research.task;
  assert.deepEqual(research.status().report.dataset.errors,['ABC']);assert.equal(research.status().automation.status,'complete');
  for(let i=0;i<5;i++)await clock.advance(8000);
  assert.deepEqual(requests,[1,12]);assert.equal(worker.inputs.length,1);
});

test('automatic cancellation suppresses pending retries across restarts until a manual run',async t=>{
  const clock=new FakeClock();let calls=0;
  const {research,store,engine,settings}=context(t,{options:clock.options(),settings:{research_symbols:1},broker:{async call(){return ++calls===1?[]:candles();}}});
  await research.startAutomatic();await research.task;await research.cancel();
  assert.equal(research.status().automation.status,'cancelled');await clock.advance(8000);assert.equal(calls,1);
  await research.close();const restored=new HistoricalResearch(engine,store,settings,{worker:new FakeWorker(),delay:0,...clock.options()});t.after(()=>restored.close());
  await restored.startAutomatic();await clock.advance(8000);assert.equal(calls,1);assert.equal(restored.status().automation.status,'cancelled');
  restored.start();await restored.task;assert.equal(calls,2);assert.equal(restored.status().status,'complete');
});

test('scheduler never overlaps pending requests and stale responses cannot publish after an automatic reconnect',async t=>{
  const clock=new FakeClock(),pending=deferred();let calls=0;
  const {research,engine,worker,store}=context(t,{options:clock.options(),settings:{research_symbols:1},broker:{call(){calls++;return pending.promise;}}});
  await research.startAutomatic();const oldTask=research.task;
  await clock.advance(8000);assert.equal(calls,1);assert.equal(clock.timers.size,1);
  await research.cancel({suppressAuto:false});engine.broker={async call(){calls++;return candles();}};engine.universe[1].tradingsymbol='AAB';engine._universe_generation=1;
  await clock.advance(8000);assert.equal(calls,1);assert.equal(research.status().automation.status,'waiting');
  pending.resolve(candles());await oldTask;assert.equal(store.get('research_history:1:5minute'),null);
  await clock.advance(1000);await research.task;assert.equal(calls,2);assert.deepEqual(Object.keys(worker.inputs[0].dataset.symbols),['AAB']);
  assert.deepEqual(research.status().report.metadata.requested_symbols,['AAB']);
});

test('scheduler gate and close prevent retries during restart and pending shutdown',async t=>{
  const clock=new FakeClock(),pending=deferred();let allowed=false,calls=0;
  const {research,worker}=context(t,{options:clock.options(),settings:{research_symbols:1},broker:{call(){calls++;return pending.promise;}}});
  await research.startAutomatic({canRun:()=>allowed});await clock.advance(8000);assert.equal(calls,0);assert.match(research.status().automation.reason,/restart/);
  allowed=true;await clock.advance(1000);assert.equal(calls,1);
  const closing=research.close();assert.equal(clock.timers.size,0);await clock.advance(8000);assert.equal(calls,1);
  pending.resolve(candles());await closing;assert.equal(worker.inputs.length,0);
  await research.close();await research.startAutomatic();assert.equal(clock.timers.size,0);assert.equal(research.status().automation.status,'stopped');
});

test('a restored pending retry can be cancelled before its first scheduler tick',async t=>{
  const clock=new FakeClock(),{research,store,engine,settings,calls}=context(t,{options:clock.options()});
  store.set('research_auto_retry',{signature:research.signature(),failures:2,next_retry_at:new Date(clock.time+8000).toISOString(),cancelled:false});
  await research.close();const restored=new HistoricalResearch(engine,store,settings,{worker:new FakeWorker(),delay:0,...clock.options()});t.after(()=>restored.close());
  assert.equal(restored.status().status,'idle');assert.equal(restored.status().automation.status,'retry_wait');await restored.cancel();
  await restored.startAutomatic();await clock.advance(8000);assert.equal(restored.status().automation.status,'cancelled');assert.equal(calls.length,0);
});

test('HTTP 429 stops the collection immediately and manual retry respects the persisted cooldown while caches survive',async t=>{
  const clock=new FakeClock(),calls=[];let limited=true;
  const broker={async call(method,token){calls.push([method,token]);if(token===12&&limited)throw Object.assign(new Error('private broker response'),{http_status:429,rate_limited:true,retry_after_seconds:5});return candles();}};
  const {research,store,engine,settings,worker}=context(t,{broker,options:clock.options(),settings:{research_symbols:3}});
  research.start();await research.task;
  assert.deepEqual(calls.map(([,token])=>token),[1,12]);assert.equal(worker.inputs.length,0);
  assert.equal(store.get('research_history:1:5minute').symbol,'ABC');assert.equal(store.get('research_history:12:5minute'),null);
  const failed=research.status();assert.equal(failed.error.code,'rate_limit');assert.equal(failed.error.phase,'symbol_history');assert.equal(failed.error.symbol,'INFY');assert.equal(failed.error.http_status,429);
  assert.equal(+new Date(failed.error.next_retry_at)-clock.time,5000);assert.equal(failed.automation.status,'retry_wait');assert.equal(failed.cooldown.next_retry_at,failed.error.next_retry_at);
  assert.throws(()=>research.start(),error=>error.status===429);assert.equal(calls.length,2);
  settings.research_days=11;assert.throws(()=>research.start(),error=>error.status===429);settings.research_days=10;
  await research.cancel();assert.equal(research.status().automation.status,'cancelled');assert.throws(()=>research.start(),error=>error.status===429);
  await research.close();const restored=new HistoricalResearch(engine,store,settings,{worker:new FakeWorker(),delay:0,...clock.options()});t.after(()=>restored.close());
  assert.equal(restored.status().error.code,'rate_limit');assert.throws(()=>restored.start(),error=>error.status===429);
  limited=false;await clock.advance(5000);restored.start();await restored.task;
  assert.equal(restored.status().status,'complete');assert.equal(restored.status().error,null);assert.equal(restored.status().cooldown,null);
  assert.deepEqual(calls.map(([,token])=>token),[1,12,12,99]);
  assert.equal(JSON.stringify(store.events()).includes('private broker response'),false);
});

for(const [http_status,code] of [[401,'authentication'],[403,'permission']])test(`HTTP ${http_status} requires an explicit retry or changed access instead of repeated automatic calls`,async t=>{
  const clock=new FakeClock();let calls=0,denied=true;
  const broker={async call(){calls++;if(denied)throw Object.assign(new Error('access_token secret'),{http_status});return candles();}};
  const {research,store,engine,settings,worker}=context(t,{broker,options:clock.options()});
  await research.startAutomatic();await research.task;
  const failed=research.status();assert.equal(failed.error.code,code);assert.equal(failed.error.retryable,false);assert.equal(failed.error.next_retry_at,null);assert.equal(failed.automation.status,'action_required');
  for(let i=0;i<3;i++)await clock.advance(8000);assert.equal(calls,1);assert.equal(worker.inputs.length,0);
  await research.close();const restored=new HistoricalResearch(engine,store,settings,{worker:new FakeWorker(),delay:0,...clock.options()});t.after(()=>restored.close());
  await restored.startAutomatic();await clock.advance(8000);assert.equal(calls,1);assert.equal(restored.status().automation.status,'action_required');
  denied=false;restored.start();await restored.task;assert.equal(restored.status().status,'complete');assert.equal(calls,3);assert.equal(store.get('research_access_block'),null);
  assert.equal(JSON.stringify(store.events()).includes('access_token secret'),false);
});

test('new saved account session permits a suppressed authentication check without weakening comparison deduplication',async t=>{
  const clock=new FakeClock();let calls=0,denied=true;
  const {research,store}=context(t,{options:clock.options(),settings:{research_symbols:1},broker:{async call(){calls++;if(denied)throw Object.assign(new Error('bad session'),{kind:'TokenException'});return candles();}}});
  await research.maybeStart();await research.task;assert.equal(calls,1);
  await clock.advance(8000);await research.maybeStart();assert.equal(calls,1);
  store.set('kite_session','synthetic replacement encrypted session');denied=false;
  await research.maybeStart();await research.task;assert.equal(calls,2);assert.equal(research.status().status,'complete');
  await research.maybeStart();assert.equal(calls,2);
});

test('partial research reports expose bounded safe symbol/phase failures without raw broker details',async t=>{
  const {research,store}=context(t,{broker:{async call(_method,token){if(token===1)throw Object.assign(new Error('raw credentials should stay private'),{http_status:503,kind:'NetworkException',request:{authorization:'secret'}});return candles();}}});
  research.start();await research.task;const state=research.status();
  assert.equal(state.status,'complete');assert.equal(state.error,null);
  assert.deepEqual(state.report.metadata.issues,[{code:'network',message:state.issues[0].message,http_status:503,phase:'symbol_history',symbol:'ABC',retryable:true,next_retry_at:null}]);
  assert.deepEqual(state.report.dataset.errors,['ABC']);assert.equal(state.issues.length,1);
  assert.equal(JSON.stringify([state,store.events()]).includes('raw credentials'),false);
  assert.equal(JSON.stringify(state).includes('"secret"'),false);
});

test('unusable histories preserve coverage taxonomy with a bounded issues collection',async t=>{
  const {research,engine}=context(t,{settings:{research_symbols:60},broker:{async call(){return [];}}});
  engine.universe=Object.fromEntries(Array.from({length:60},(_,i)=>[i+1,{tradingsymbol:'A'+String(i).padStart(3,'0')}]));
  research.start();await research.task;
  assert.equal(research.status().error.code,'data_coverage');assert.equal(research.status().issues.length,50);assert.equal(research.summary().issues.length,50);
});

for(const phase of ['context_identity','context_history'])test(`HTTP 429 during ${phase} stops index collection and schedules a retry`,async t=>{
  const calls=[];const broker={async call(method,token){calls.push([method,token]);if(method==='quote'){if(phase==='context_identity')throw Object.assign(new Error('throttled'),{http_status:429,retry_after_seconds:3});return {'NSE:NIFTY 50':{instrument_token:500}};}if(token===500)throw Object.assign(new Error('throttled'),{http_status:429,retry_after_seconds:3});return candles();}};
  const {research,engine,worker}=context(t,{broker,settings:{research_symbols:1}});engine.market_context={forSymbol:()=>({index_membership:[]})};
  research.start();await research.task;const state=research.status();
  assert.equal(state.error.code,'rate_limit');assert.equal(state.error.phase,phase);assert.equal(state.error.symbol,phase==='context_history'?'NIFTY 50':null);assert.equal(worker.inputs.length,0);
  assert.equal(calls.length,phase==='context_history'?3:2);
});

test('known local worker timeout is distinct from API rate limiting and suppresses repeated automatic replay',async t=>{
  const clock=new FakeClock(),worker=new FakeWorker();
  worker.start=function(dataset,options){this.inputs.push({dataset,options});this.job={status:'failed',phase:'enhanced',error:'Backtest runtime limit exceeded; use a smaller dataset',error_code:'worker_timeout',progress:.5};};
  const {research,engine,store}=context(t,{worker,options:clock.options(),settings:{research_symbols:1}});
  await research.startAutomatic();await research.task;let state=research.status();
  assert.equal(state.error.code,'worker_timeout');assert.equal(state.error.phase,'worker_enhanced');assert.equal(state.error.http_status,null);assert.equal(state.error.retryable,false);assert.equal(state.automation.status,'action_required');assert.equal(state.cooldown,null);
  for(let i=0;i<3;i++)await clock.advance(8000);assert.equal(worker.inputs.length,1);
  engine._strategy_options=()=>({enhanced_signals:true,min_signal_score:70});await research.maybeStart();await research.task;assert.equal(worker.inputs.length,2);
  research.start();await research.task;assert.equal(worker.inputs.length,3);assert.equal(store.events().filter(event=>event.kind==='research.failed').at(-1).data.code,'worker_timeout');
});

test('unexpected worker failures use safe diagnostics and keep bounded transient retry',async t=>{
  const clock=new FakeClock(),worker=new FakeWorker();worker.start=function(){this.job={status:'failed',error:'secret raw worker detail'};};
  const {research,store}=context(t,{worker,options:clock.options(),settings:{research_symbols:1}});research.start();await research.task;
  assert.equal(research.status().error.code,'worker');assert.equal(research.status().automation.status,'retry_wait');assert.equal(JSON.stringify([research.status(),store.events()]).includes('secret raw worker detail'),false);
});

test('CPU pinning failure waits for action and selecting automatic scheduling unblocks research',async t=>{
  const worker=new FakeWorker(),start=worker.start;
  worker.start=function(dataset,options){start.call(this,dataset,options);if(options.cpu_affinity==='pinned')this.job={status:'failed',phase:'baseline',error_code:'cpu_affinity',error:'Native private detail'};};
  const {research,settings}=context(t,{worker,settings:{research_symbols:1,research_cpu_affinity:'pinned'}});
  await research.maybeStart();await research.task;
  assert.equal(research.status().error.code,'cpu_affinity');assert.equal(research.status().error.retryable,false);assert.match(research.status().error.message,/Automatic scheduling/);
  assert.equal(research.status().automation.status,'action_required');await research.maybeStart();assert.equal(worker.inputs.length,1);
  settings.research_cpu_affinity='automatic';await research.maybeStart();await research.task;
  assert.equal(worker.inputs.length,2);assert.equal(worker.inputs[1].options.cpu_affinity,'automatic');assert.equal(research.status().status,'complete');
});

test('comparison timeout retains actual time limit and candle counts without leaking raw worker details',async t=>{
  const worker=new FakeWorker();
  worker.start=function(){this.job={status:'failed',phase:'enhanced',progress:.8,error_code:'worker_timeout',error:'private worker context',error_details:{phase:'enhanced',budget_ms:1200000,processed_bars:123456,total_bars:500000,kind:'variant',private:'must not reach the dashboard'}};};
  const {research,store}=context(t,{worker,settings:{research_symbols:1}});research.start();await research.task;
  const state=research.status();assert.equal(state.status,'failed');assert.ok(state.progress<100);assert.equal(state.current_task,null);
  assert.equal(state.error.runtime_budget_ms,1200000);assert.equal(state.error.processed_bars,123456);assert.equal(state.error.total_bars,500000);assert.equal(state.error.timeout_kind,'variant');
  assert.match(state.error.message,/enhanced simulation.*20 minutes/);assert.match(state.error.message,/1,23,456 of 5,00,000 candles/);
  assert.equal(JSON.stringify([state,store.events()]).includes('private worker context'),false);assert.equal(JSON.stringify(state).includes('must not reach'),false);
  assert.deepEqual(store.get('research_failure').error,state.error);
});

test('revised comparison budget invalidates only obsolete comparison-timeout blocks',async t=>{
  const {research,store,worker}=context(t,{settings:{research_symbols:1}}),signature=research._accessSignature();
  const old={signature,error:{code:'worker_timeout',phase:'worker_enhanced',message:'Previous comparison budget reached.'}};
  store.set('research_access_block',old);await research.maybeStart();await research.task;
  assert.equal(worker.inputs.length,1);assert.equal(research.status().status,'complete');assert.equal(store.get('research_access_block'),null);
  // Authentication and the separate parameter-search limit still need the same
  // corrective action; a comparison-budget revision cannot silently clear them.
  for(const error of [{code:'authentication',phase:'symbol_history'},{code:'permission',phase:'context_history'},{code:'worker_timeout',phase:'tuning'}]){
    store.delete('research_auto_signature');store.set('research_access_block',{signature,error:{...error,message:'Existing access or tuning block.'}});
    await research.maybeStart();assert.equal(worker.inputs.length,1);assert.equal(research.status().automation.status,'action_required');
  }
});

test('research honors an explicit ten-minute Retry-After instead of the shorter fallback cap',async t=>{
  const clock=new FakeClock();let calls=0;
  const {research}=context(t,{options:clock.options(),settings:{research_symbols:1},broker:{async call(){calls++;throw Object.assign(new Error('throttled'),{http_status:429,retry_after_seconds:600});}}});
  research.start();await research.task;assert.equal(+new Date(research.status().cooldown.next_retry_at)-clock.time,600000);
  await clock.advance(300000);assert.throws(()=>research.start(),error=>error.status===429);assert.equal(calls,1);
  await clock.advance(299999);assert.throws(()=>research.start(),error=>error.status===429);assert.equal(calls,1);
  await clock.advance(1);research.start();await research.task;assert.equal(calls,2);
});

test('clock correction cannot shorten or extend an active research rate-limit cooldown',async t=>{
  const clock=new FakeClock();let elapsed=0,calls=0;
  const {research}=context(t,{options:{...clock.options(),monotonicNow:()=>elapsed},settings:{research_symbols:1},broker:{async call(){calls++;if(calls===1)throw Object.assign(new Error('throttled'),{http_status:429,retry_after_seconds:5});return candles();}}});
  research.start();await research.task;clock.time+=3600000;
  assert.throws(()=>research.start(),error=>error.status===429);assert.equal(calls,1);
  clock.time-=7200000;elapsed=4000;assert.throws(()=>research.start(),error=>error.status===429);assert.equal(calls,1);
  elapsed=5000;await research.maybeStart();await research.task;assert.equal(calls,2);assert.equal(research.status().status,'complete');
});

test('real research worker retires between intraday and swing comparisons before starting the next interval',async t=>{
  const worker=new ResearchService(),{research,engine}=context(t,{worker,settings:{research_symbols:1}});
  engine.strategy_settings=()=>({intraday_enabled:true,swing_enabled:true});
  research.start();await research.task;
  assert.equal(research.status().status,'complete');assert.equal(research.status().report.metadata.interval,'5minute');assert.equal(research.status().report.alternate_reports.day.metadata.interval,'day');assert.equal(worker.worker,null);
});

function tuningContext(t,{result,apply}={}){
  const rows=[];
  for(let offset=44;offset>=0;offset--){const date=new Date(Date.parse('2026-09-16T12:00:00Z')-offset*86400000);if(![0,6].includes(date.getUTCDay()))rows.push(...candles(date.toISOString().slice(0,10)));}
  const worker=new FakeWorker();worker.optimizations=[];
  worker.startOptimization=function(datasets,options){this.optimizations.push(structuredClone({datasets,options}));this.job={status:'complete',progress:1,result:result??{status:'no_improvement',reason:'No candidate passed validation.',parameters:null,trials:[]}};};
  const f=context(t,{worker,broker:{call:async()=>rows},settings:{research_days:45,research_tuning:true,research_tuning_apply:true,research_tuning_trials:9,research_tuning_seconds:600,min_signal_score:60,min_adx:18,min_setup_volume:1.2,max_atr_extension:2.5}});
  f.engine._strategy_options=()=>({enhanced_signals:true,min_signal_score:f.settings.min_signal_score,min_adx:f.settings.min_adx,min_setup_volume:f.settings.min_setup_volume,max_atr_extension:f.settings.max_atr_extension});
  f.applications=[];
  f.research.applyParameters=async request=>{f.applications.push(request.parameters);if(apply)return apply(request,f);assert.equal(request.isCurrent(),true);Object.assign(f.settings,request.parameters);return {status:'applied',reason:'Validated test fixture applied.',changes:[{key:'min_signal_score',before:60,after:65}]};};
  return f;
}
const acceptedTuning=()=>({status:'accepted',reason:'Final test passed.',parameters:{min_signal_score:65},selected_id:'candidate_1',trials:[]});

test('stage progress describes concurrent parameter work separately from weighted overall completion',async t=>{
  const f=tuningContext(t),phase='tuning_train';
  f.worker.startOptimization=function(){this.job={status:'running',phase,progress:.3,parallelism:{total_tasks:2,completed_tasks:0,active_sets:[{parameter_set_id:'P1',phase,progress:.5},{parameter_set_id:'P2',phase,progress:.5}]}};};
  f.research.start();await until(()=>f.research.state.tuning?.phase===phase);
  let state=f.research.summary();assert.equal(state.progress,58);assert.equal(state.progress_detail.stage_progress,50);assert.equal(state.progress_detail.completed,0);assert.equal(state.progress_detail.total,2);
  f.worker.job={status:'running',phase,progress:.45,parallelism:{total_tasks:2,completed_tasks:1,active_sets:[{parameter_set_id:'P2',phase,progress:.5}]}};
  await until(()=>f.research.state.progress===67);state=f.research.summary();assert.equal(state.progress_detail.stage_progress,75);assert.equal(state.progress_detail.completed,1);
  f.worker.job={status:'running',phase:'tuning_validation',progress:.625,parallelism:{total_tasks:1,completed_tasks:0,active_sets:[{parameter_set_id:'P2',phase:'tuning_validation',progress:.1}]}};
  await until(()=>f.research.state.tuning?.phase==='tuning_validation');state=f.research.summary();assert.equal(state.progress,77.5);assert.equal(state.progress_detail.stage_progress,10);assert.match(state.progress_detail.stage,/Validating/);
  f.worker.job={status:'complete',progress:1,result:{status:'no_improvement',reason:'No validation improvement.',parameters:null,trials:[]}};
  await f.research.task;assert.equal(f.research.summary().progress_detail,null);assert.equal(f.research.summary().progress,100);
});

test('one overall bar includes real candidate fractions without restarting at parameter-search phases',async t=>{
  const f=tuningContext(t),samples=[],update=f.research._progress.bind(f.research);
  f.research._progress=value=>{update(value);samples.push(f.research.state.progress);};
  f.worker.startOptimization=function(datasets,options){this.optimizations.push({datasets,options});this.job={status:'running',phase:'tuning_train',progress:0,message:'Training:0 of 9 sets finished.',parallelism:{active_sets:[{parameter_set_id:'P1',progress:0}]}};};
  f.research.start();await until(()=>f.research.state.tuning?.phase==='tuning_train');
  assert.equal(f.research.status().progress,40);assert.equal(f.research.summary().current_task.title,'Training parameter sets');
  f.worker.job={...f.worker.job,progress:.3,message:'Training:0 of 9 sets finished.',parallelism:{active_sets:[{parameter_set_id:'P1',progress:.5}]}};
  await until(()=>f.research.state.progress===58);
  assert.equal(f.research.summary().tuning.parallelism.active_sets[0].progress,.5);
  // Even a delayed/regressing worker snapshot cannot move the main bar back.
  f.worker.job={...f.worker.job,progress:.1};await until(()=>f.research.state.tuning?.progress===.1);
  assert.equal(f.research.status().progress,58);
  f.worker.job={...f.worker.job,phase:'tuning_validation',progress:.6,message:'Validation:0 of 3 sets finished.',parallelism:{active_sets:[]}};
  await until(()=>f.research.state.tuning?.phase==='tuning_validation');
  assert.equal(f.research.status().progress,76);assert.equal(f.research.summary().current_task.title,'Validating shortlisted parameter sets');
  f.worker.job={...f.worker.job,phase:'tuning_test',progress:.85,message:'Testing on reserved dates.'};
  await until(()=>f.research.state.tuning?.phase==='tuning_test');
  assert.equal(f.research.status().progress,91);assert.match(f.research.summary().current_task.title,/Final testing/);
  f.worker.job={status:'complete',progress:1,result:{status:'no_improvement',reason:'No candidate passed validation.',parameters:null,trials:[]}};
  await f.research.task;
  assert.equal(f.research.status().progress,100);assert.equal(f.research.status().current_task,null);
  assert.ok(samples.every((value,index)=>value<100&&(index===0||value>=samples[index-1])));
});

test('a cancelled parameter search clears its active task and does not claim overall completion',async t=>{
  const f=tuningContext(t);
  f.worker.startOptimization=function(){this.job={status:'running',phase:'tuning_train',progress:.2};};
  f.research.start();await until(()=>f.research.state.tuning?.phase==='tuning_train');
  await f.research.cancel();await f.research.task;
  assert.equal(f.research.status().status,'cancelled');assert.equal(f.research.status().progress,52);assert.equal(f.research.status().current_task,null);
});

test('tuning reuses collected candles with frozen risk/cost assumptions and keeps settings after no improvement',async t=>{
  const f=tuningContext(t);f.research.start();await f.research.task;
  assert.equal(f.research.status().status,'complete');assert.equal(f.worker.optimizations.length,1);
  assert.deepEqual(f.worker.optimizations[0].datasets[0],f.worker.inputs[0].dataset);
  const options=f.worker.optimizations[0].options;
  assert.equal(options.initial_capital,120000);assert.equal(options.risk_per_trade_pct,.0025);assert.equal(options.fee_rate,.001);assert.equal(options.slippage_rate,.0005);
  assert.equal(f.research.status().report.optimization.status,'no_improvement');assert.equal(f.applications.length,0);assert.equal(f.settings.min_signal_score,60);
  assert.ok(f.store.get('research_tuning_test_dates')['5minute']);
});

test('only accepted tuning applies, persists its outcome and suppresses a fresh run caused by its own parameter update',async t=>{
  const f=tuningContext(t,{result:acceptedTuning()});f.research.start();await f.research.task;
  assert.deepEqual(f.applications,[{min_signal_score:65}]);assert.equal(f.settings.min_signal_score,65);
  assert.equal(f.store.get('research_pending_tuning'),null);assert.equal(f.store.get('research_report').optimization.application.status,'applied');
  assert.equal(f.store.get('research_auto_signature'),f.research.signature());
  await f.research.maybeStart();assert.equal(f.worker.optimizations.length,1);
});

test('an old empty holdout-wait report is refreshed exactly once after the research workflow signature changes',async t=>{
  const f=tuningContext(t,{result:selectableTuning()});
  const {intraday_capital,swing_capital,...strategies}=f.engine.strategy_settings();
  // Persist the actual pre-workflow-version signature format, as an existing
  // installation would have written it before parameter evidence was retained.
  const legacySignature=createHash('sha256').update(JSON.stringify([
    STRATEGY_VERSION,f.settings.kite_user_id||f.engine.user_id||null,f.settings.publicValues?.(),'2026-09-17',
    f.settings.research_symbols,f.settings.research_days,f.engine._strategy_options(),strategies,f.research._backtestOptions(0),
    f.settings.research_tuning,f.settings.research_tuning_apply,f.settings.research_tuning_trials,f.settings.research_tuning_seconds,f.research._selectionPlan(),
  ])).digest('hex');
  const consumed={'5minute':'2026-09-16'};
  f.store.set('research_report',{...report(),completed_at:NOW.toISOString(),optimization:{status:'waiting_for_fresh_data',reason:'Fresh final-test dates are required.',parameters:null,trials:[],application:{status:'not_applied'}}});
  f.store.set('research_auto_signature',legacySignature);f.store.set('research_tuning_test_dates',consumed);
  await f.research.close();
  const restored=new HistoricalResearch(f.engine,f.store,f.settings,{worker:f.worker,now:()=>NOW,delay:0});t.after(()=>restored.close());
  restored.applyParameters=f.research.applyParameters;
  assert.deepEqual(restored.status().report.optimization.trials,[]);assert.equal(restored.status().automation.status,'ready');
  assert.notEqual(restored.signature(),legacySignature);
  await restored.maybeStart();await restored.task;
  assert.equal(f.worker.inputs.length,1);assert.equal(f.worker.optimizations.length,1);assert.equal(f.worker.optimizations[0].options.final_test_allowed,false);
  assert.equal(restored.status().report.optimization.trials.length,3);assert.equal(restored.status().report.optimization.final_test_allowed,false);
  assert.deepEqual(f.store.get('research_tuning_test_dates'),consumed);assert.equal(f.applications.length,0);
  assert.equal(f.store.get('research_auto_signature'),restored.signature());assert.equal(restored.status().automation.status,'complete');
  await Promise.all([restored.maybeStart(),restored.maybeStart(),restored.maybeStart()]);
  assert.equal(f.worker.inputs.length,1);assert.equal(f.worker.optimizations.length,1,'The new workflow must not cause an automatic same-day retry loop');
  await restored.close();
});

test('overlapping test dates still produce parameter evidence after settings changes and restart without another final test',async t=>{
  const f=tuningContext(t,{result:selectableTuning()});f.research.start();await f.research.task;const consumed=f.store.get('research_tuning_test_dates');
  f.settings.min_signal_score=70;f.research.start();await f.research.task;
  let optimization=f.research.status().report.optimization;
  assert.equal(f.worker.optimizations.length,2);assert.equal(f.worker.optimizations[0].options.final_test_allowed,true);assert.equal(f.worker.optimizations[1].options.final_test_allowed,false);
  assert.equal(optimization.status,'no_improvement');assert.equal(optimization.trials.length,3);assert.equal(optimization.trials[1].train['5minute'].metrics.net_pnl,-100);
  assert.equal(optimization.final_test_allowed,false);assert.equal(optimization.final_test_block.blocked_intervals[0].reserved_through,consumed['5minute']);
  assert.equal(optimization.parameters,null);assert.equal(f.applications.length,0);assert.deepEqual(f.store.get('research_tuning_test_dates'),consumed);
  await f.research.close();
  const worker=new FakeWorker();worker.optimizations=[];worker.startOptimization=f.worker.startOptimization;
  const restored=new HistoricalResearch(f.engine,f.store,f.settings,{worker,now:()=>NOW,delay:0});t.after(()=>restored.close());
  assert.equal(restored.status().progress,100,'Restored completed reports must not show0%');assert.equal(restored.status().report.optimization.trials.length,3);
  restored.start();await restored.task;
  optimization=restored.status().report.optimization;
  assert.equal(worker.optimizations.length,1);assert.equal(worker.optimizations[0].options.final_test_allowed,false);
  assert.equal(optimization.trials.length,3);assert.equal(optimization.final_test_allowed,false);assert.deepEqual(f.store.get('research_tuning_test_dates'),consumed);
});

test('historical coordinator cannot automatically accept a worker result when final-test dates were already reserved',async t=>{
  const candidate={...selectableTuning(),...acceptedTuning()},f=tuningContext(t,{result:candidate});
  f.store.set('research_tuning_test_dates',{'5minute':'2026-09-16'});
  f.research.start();await f.research.task;
  const result=f.research.status().report.optimization;
  assert.equal(f.worker.optimizations[0].options.final_test_allowed,false);assert.equal(result.status,'waiting_for_fresh_data');assert.equal(result.parameters,null);
  assert.equal(result.application.status,'not_applied');assert.equal(f.applications.length,0);assert.equal(f.store.get('research_pending_tuning'),null);assert.equal(f.settings.min_signal_score,60);
});

test('a completed blocked-date set remains explicitly selectable without being automatically qualified',async t=>{
  const f=tuningContext(t,{result:selectableTuning()});f.store.set('research_tuning_test_dates',{'5minute':'2026-09-16'});
  f.research.start();await f.research.task;
  const result=f.research.status().report.optimization;
  assert.equal(result.final_test_allowed,false);assert.equal(result.trials[1].application_eligible,true);assert.equal(f.applications.length,0);
  await f.research.selectParameterSet(result.report_id,'P2');assert.equal(f.settings.min_signal_score,65);
  assert.equal(f.research.status().report.optimization.status,'no_improvement');assert.equal(f.research.status().report.optimization.final_test_allowed,false);
});

test('accepted tuning waits for a safe application point and then applies once without repeating research',async t=>{
  let ready=false;
  const f=tuningContext(t,{result:acceptedTuning(),apply:(request,fixture)=>{if(!ready)return {status:'waiting',reason:'Managed position still open.'};assert.equal(request.isCurrent(),true);Object.assign(fixture.settings,request.parameters);return {status:'applied',reason:'Applied at a safe point.'};}});
  f.research.start();await f.research.task;
  assert.equal(f.research.status().report.optimization.application.status,'waiting');assert.ok(f.store.get('research_pending_tuning').id);assert.equal(f.settings.min_signal_score,60);
  ready=true;await Promise.all([f.research.maybeStart(),f.research.maybeStart()]);
  assert.equal(f.applications.length,2,'One deferred attempt and one successful attempt');assert.equal(f.worker.optimizations.length,1);
  assert.equal(f.store.get('research_pending_tuning'),null);assert.equal(f.store.get('research_report').optimization.application.status,'applied');
});

test('cancelling a waiting application invalidates its lock-time authority and prevents later application',async t=>{
  const gate=deferred();let allowed;
  const f=tuningContext(t,{result:acceptedTuning(),apply:async request=>{await gate.promise;allowed=request.isCurrent();return {status:allowed?'applied':'stale',reason:'Lock-time context checked.'};}});
  f.research.start();await until(()=>f.applications.length===1);
  await f.research.cancel();gate.resolve();await f.research.task;
  assert.equal(allowed,false);assert.equal(f.store.get('research_pending_tuning'),null);assert.equal(f.settings.min_signal_score,60);
  assert.ok(f.store.get('research_tuning_test_dates')['5minute'],'Cancelled searches still consume their reserved test dates');
});

test('accepted research results remain unapplied when automatic application is disabled',async t=>{
  const f=tuningContext(t,{result:acceptedTuning()});f.settings.research_tuning_apply=false;f.research.start();await f.research.task;
  assert.equal(f.research.status().report.optimization.status,'accepted');assert.equal(f.research.status().report.optimization.application.status,'disabled');
  assert.equal(f.applications.length,0);assert.equal(f.settings.min_signal_score,60);
});

test('a newer research run supersedes a candidate already waiting on its application lock',async t=>{
  const f=tuningContext(t,{result:acceptedTuning(),apply:()=>({status:'waiting',reason:'Exposure remains.'})});
  f.research.start();await f.research.task;
  const gate=deferred();let current;
  f.research.applyParameters=async request=>{await gate.promise;current=request.isCurrent();return {status:current?'applied':'stale',reason:'Checked after lock wait.'};};
  const applying=f.research._applyPending();
  f.research.start();await f.research.task;
  gate.resolve();await applying;
  assert.equal(current,false);assert.equal(f.research.status().report.optimization.status,'waiting_for_fresh_data');
  assert.equal(f.store.get('research_pending_tuning'),null);assert.equal(f.settings.min_signal_score,60);
});

test('shutdown waits for a scheduler application and invalidates it before storage can close',async t=>{
  const f=tuningContext(t,{result:acceptedTuning(),apply:()=>({status:'waiting',reason:'Exposure remains.'})});
  f.research.start();await f.research.task;
  const gate=deferred();let current;
  f.research.applyParameters=async request=>{await gate.promise;current=request.isCurrent();return {status:current?'applied':'stale',reason:'Checked after lock wait.'};};
  const tick=f.research.maybeStart();let closed=false;
  const closing=f.research.close().then(()=>closed=true);await delay(5);assert.equal(closed,false);
  gate.resolve();await Promise.all([closing,tick]);
  assert.equal(current,false);assert.equal(closed,true);assert.equal(f.settings.min_signal_score,60);
});

test('a saved candidate cannot cross into a different configured Zerodha account',async t=>{
  const f=tuningContext(t,{result:acceptedTuning(),apply:()=>({status:'waiting',reason:'Exposure remains.'})});
  f.settings.kite_user_id='AB1234';f.research.start();await f.research.task;
  assert.ok(f.store.get('research_pending_tuning'));f.settings.kite_user_id='CD5678';
  const result=await f.research._applyPending();
  assert.equal(result.status,'stale');assert.equal(f.applications.length,1);assert.equal(f.store.get('research_pending_tuning'),null);assert.equal(f.settings.min_signal_score,60);
});

const selectableTuning=()=>({status:'no_improvement',reason:'Training lost money.',parameters:null,
  ranges:{'5minute':{train:{from:'2026-08-01',to:'2026-08-28'}}},
  incumbent_parameters:{min_signal_score:60,min_adx:18,min_setup_volume:1.2,max_atr_extension:2.5},
  trials:[{}, {min_signal_score:65}, {min_adx:21}].map((parameters,index)=>({id:index?'candidate_'+index:'incumbent',parameter_set_id:`P${index+1}`,parameters,status:'rejected',reason:'Training lost money.',train:{'5minute':{metrics:{net_pnl:-100,net_return_pct:-1,max_drawdown_pct:2,trade_count:12}}}}))});

test('manual selection applies the complete P set including losing results without relabeling qualification',async t=>{
  const f=tuningContext(t,{result:selectableTuning()});f.settings.research_tuning_apply=false;
  f.research.start();await f.research.task;
  const result=f.research.status().report.optimization;
  assert.ok(result.report_id);assert.equal(result.trials[0].application_eligible,false);assert.equal(result.trials[1].application_eligible,true);
  await f.research.selectParameterSet(result.report_id,'P2');assert.equal(f.settings.min_signal_score,65);
  await f.research.selectParameterSet(result.report_id,'P3');assert.equal(f.settings.min_signal_score,60,'Switching sets restores unchanged thresholds from the original report');assert.equal(f.settings.min_adx,21);
  assert.deepEqual(f.applications[1],{min_signal_score:60,min_adx:21,min_setup_volume:1.2,max_atr_extension:2.5});
  const applied=f.research.status().report.optimization;
  assert.equal(applied.status,'no_improvement');assert.equal(applied.trials[2].status,'rejected');assert.equal(applied.application.source,'manual');assert.equal(applied.application.parameter_set_id,'P3');
  assert.equal(applied.trials[2].application_eligible,false);assert.equal(applied.trials[0].application_eligible,true);
  assert.equal(f.store.get('research_report').optimization.application.parameter_set_id,'P3');
});

test('manual selection rejects old report IDs, incomplete results and changed account or risk context',async t=>{
  const f=tuningContext(t,{result:selectableTuning()});
  // Real settings supply publicValues; include every fixture field here too.
  f.settings.publicValues=()=>Object.fromEntries(Object.entries(f.settings).filter(([,value])=>typeof value!=='function'));
  f.research.start();await f.research.task;const id=f.research.status().report.optimization.report_id;
  await assert.rejects(f.research.selectParameterSet('old','P2'),/no longer current/);
  await assert.rejects(f.research.selectParameterSet(id,'P17'),/does not belong/);
  delete f.research.state.report.optimization.trials[1].train;
  await assert.rejects(f.research.selectParameterSet(id,'P2'),/not finished/);
  f.settings.kite_user_id='DIFFERENT';await assert.rejects(f.research.selectParameterSet(id,'P3'),/changed/);delete f.settings.kite_user_id;
  f.settings.risk_per_trade_pct=.001;await assert.rejects(f.research.selectParameterSet(id,'P3'),/changed/);
  assert.equal(f.applications.length,0);
});

test('a queued manual choice survives automatic-apply disabled and can be cancelled before exposure clears',async t=>{
  const f=tuningContext(t,{result:selectableTuning(),apply:()=>({status:'waiting',reason:'Managed position open.'})});f.settings.research_tuning_apply=false;
  f.research.start();await f.research.task;const id=f.research.status().report.optimization.report_id;
  const waiting=await f.research.selectParameterSet(id,'P2');assert.equal(waiting.report.optimization.application.status,'waiting');assert.equal(f.store.get('research_pending_tuning').source,'manual');
  await f.research.cancel();await f.research.maybeStart();assert.equal(f.applications.length,1);assert.equal(f.settings.min_signal_score,60);assert.equal(f.store.get('research_pending_tuning'),null);
});

test('parallel worker settings and live activity are passed to the resource scheduler',async t=>{
  const f=tuningContext(t);f.settings.research_tuning_workers=7;f.settings.analytics_reserve_cpus=2;f.engine.analytics={snapshot:()=>({active_jobs:3,live_workers:80})};
  f.research.start();await f.research.task;
  const options=f.worker.optimizations[0].options;assert.equal(options.parallelism,7);assert.equal(options.reserve_cpus,4);assert.equal(options.live_workers,3);
});

test('research downloads a balanced industry sample and preserves its coverage when one history is missing',async t=>{
  const f=context(t,{settings:{research_symbols:20},broker:{async call(method,token){if(method==='quote')return {};if(token===missing)throw new Error('No history');return candles();}}});
  f.engine.universe=Object.fromEntries(Array.from({length:60},(_,i)=>[i+1,{tradingsymbol:'STOCK'+i}]));
  f.engine.market_context={forSymbol:symbol=>({classification_status:'fresh',industry:'Industry '+Number(symbol.slice(5))%5,index_membership:[]})};
  const plan=f.research._selectionPlan(),missing=Number(plan.selected[0][0]);
  assert.equal(plan.selected.length,20);assert.deepEqual(plan.diversification.industries.map(group=>group.symbols.length),[4,4,4,4,4]);
  f.research.start();await f.research.task;
  const result=f.research.status().report;assert.equal(result.metadata.diversification.status,'diversified');assert.equal(result.metadata.diversification.selected_count,20);assert.equal(result.dataset.symbols.length,19);assert.equal(result.metadata.unavailable_symbols.length,1);
  assert.deepEqual(result.metadata.requested_symbols,plan.selected.map(([,i])=>i.tradingsymbol));
});

test('candidate calculation errors retain the report and healthy siblings but disable the failed set',async t=>{
  const result=selectableTuning();result.status='completed_with_errors';result.failed_trials=1;result.reason='One candidate calculation failed; other results were retained.';
  Object.assign(result.trials[1],{status:'error',error:{phase:'validation',interval:'5minute',code:'worker_exit',message:'Candidate worker exited unexpectedly.'},reason:'Validation calculation failed.'});
  const f=tuningContext(t,{result});f.research.start();await f.research.task;
  const complete=f.research.status(),optimization=complete.report.optimization;
  assert.equal(complete.status,'complete');assert.equal(complete.error,null);assert.equal(f.store.get('research_failure'),null);assert.equal(optimization.status,'completed_with_errors');assert.equal(optimization.trials[1].train['5minute'].metrics.net_pnl,-100);
  assert.equal(optimization.trials[1].application_eligible,false);assert.equal(optimization.trials[2].application_eligible,true);
  await assert.rejects(f.research.selectParameterSet(optimization.report_id,'P2'),/calculation error/);
  assert.equal(f.store.events().filter(event=>event.kind==='research.candidate_failed').length,1);assert.equal(f.store.get('research_report').optimization.failed_trials,1);
  await f.research.selectParameterSet(optimization.report_id,'P3');assert.equal(f.settings.min_adx,21);assert.equal(f.research.status().report.optimization.status,'completed_with_errors');
});

test('a healthy validated winner can apply even when a different candidate had a calculation error',async t=>{
  const result=selectableTuning();Object.assign(result,{status:'accepted',parameters:{min_adx:21},selected_id:'candidate_2',failed_trials:1,reason:'P3 passed every check; P2 had a calculation error.'});
  Object.assign(result.trials[1],{status:'error',error:{phase:'train',code:'candidate_error',message:'Calculation failed.'}});result.trials[2].status='accepted';
  const f=tuningContext(t,{result});f.research.start();await f.research.task;
  const complete=f.research.status();assert.equal(complete.status,'complete');assert.equal(complete.report.optimization.application.status,'applied');assert.equal(complete.report.optimization.application.parameter_set_id,'P3');assert.deepEqual(f.applications,[{min_adx:21}]);assert.equal(complete.report.optimization.failed_trials,1);
});
