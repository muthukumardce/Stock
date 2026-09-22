import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingEngine } from '../src/trading.js';
import { Store } from '../src/storage.js';
import { BrokerError, KiteBroker } from '../src/broker.js';
import { CandleBook, Candle, Signal } from '../src/strategy.js';
import { marketBreadth } from '../src/decision-controls.js';
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
const options = overrides => ({ now: () => NOW, backgroundLoops: false, analyticsFactory,
  equityUniverse:{resolve:async instruments=>({instruments:instruments.filter(i=>i.exchange==='NSE'&&i.segment==='NSE'&&i.instrument_type==='EQ').map(i=>({...i,entry_eligible:true})),summary:{status:'verified'}})}, ...overrides });
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
const entryDailyBars = () => Array.from({length:21},(_,i)=>new Candle(new Date(NOW-(21-i)*86400000),100,101,99,100,1000));

test('startup cancellation while account data is pending never arms entries',async t=>{
  const [engine]=ready(t);engine.running=false;engine.status='paused';let release,cancelled=false;
  const pending=new Promise(resolve=>{release=resolve;});
  engine.broker={account:async onProgress=>{onProgress({phase:'holdings',message:'Downloading holdings from Zerodha.',completed:1,total:5});await pending;return clone(engine.account);}};
  const steps=[],starting=engine.start({isCancelled:()=>cancelled,onProgress:step=>steps.push(step)});
  await new Promise(resolve=>setImmediate(resolve));
  const job=engine.snapshot().background.tasks.find(task=>task.id==='account');
  assert.equal(job.status,'running');assert.match(job.message,/Downloading holdings/);assert.equal(job.completed,1);
  cancelled=true;release();await starting;
  assert.equal(engine.running,false);assert.equal(steps.some(step=>step.phase==='armed'),false);
  assert.equal(engine.snapshot().background.tasks.find(task=>task.id==='account').status,'waiting');
});

test('daily telemetry counts required holdings instead of the full NSE universe and retains incomplete coverage',async t=>{
  const [engine]=ready(t);engine.universe[2]={tradingsymbol:'OTHER'};
  engine.account.holdings=[{exchange:'NSE',tradingsymbol:'TEST',instrument_token:1,quantity:1}];
  let release;const pending=new Promise(resolve=>{release=resolve;});
  engine.broker={call:async()=>{await pending;return [];}};
  const loading=engine._history_pass();await new Promise(resolve=>setImmediate(resolve));
  let job=engine.snapshot().background.tasks.find(task=>task.id==='daily_history');
  assert.equal(job.total,1);assert.equal(job.current_item,'TEST');assert.equal(job.completed,0);assert.match(job.message,/Downloading daily candles/);
  release();await loading;
  job=engine.snapshot().background.tasks.find(task=>task.id==='daily_history');
  assert.equal(job.status,'waiting');assert.equal(job.completed,0);assert.equal(job.failed,1);assert.equal(job.current_item,null);assert.ok(job.next_retry_at);
});

test('intraday telemetry describes closed-market waiting without a fake active download',async t=>{
  const [engine]=ready(t);engine._now=()=>new Date('2026-09-17T20:00:00+05:30');
  await engine._intraday_history_pass();
  const job=engine.snapshot().background.tasks.find(task=>task.id==='intraday_history');
  assert.equal(job.status,'waiting');assert.match(job.message,/market hours/);assert.equal(job.completed,0);assert.equal(job.current_item,null);
});

for (const [scope,method] of [['daily','_history_pass'],['intraday','_intraday_history_pass']]) test(`${scope} history stops a rate-limited pass without cascading requests or false symbol failures`,async t=>{
  const [engine]=ready(t);engine.universe[2]={tradingsymbol:'OTHER'};
  if(scope==='intraday')for(let token=3;token<=10;token++)engine.universe[token]={tradingsymbol:`OTHER${token}`};
  engine.account.holdings=[{exchange:'NSE',tradingsymbol:'TEST',instrument_token:1,quantity:1},{exchange:'NSE',tradingsymbol:'OTHER',instrument_token:2,quantity:1}];
  let calls=0,limited=false;const retry=new Date(+NOW+60000).toISOString();
  engine.broker={call:async()=>{calls++;limited=true;throw new BrokerError('RateLimitException','private broker detail',{http_status:429,retry_after_seconds:60,retry_at:retry});},rate_limit_health:()=>({status:limited?'cooldown':'ready',categories:[{category:'historical',status:limited?'cooldown':'ready',retry_after_seconds:limited?60:0,retry_at:limited?retry:null}]})};
  const expected=scope==='daily'?1:6;
  await engine[method]();assert.equal(calls,expected,'Only already-dispatched requests can finish after throttling');
  let job=engine.snapshot().background.tasks.find(task=>task.id===scope+'_history');
  assert.equal(job.status,'waiting');assert.match(job.message,/rate limit \(HTTP 429\)/);assert.equal(job.failed,0);assert.equal(job.next_retry_at,retry);
  await engine[method]();assert.equal(calls,expected,'cooling history category sends no additional requests');
  assert.equal(engine.snapshot().api_limits.status,'cooldown');assert.equal(engine.connected,true);assert.equal(engine.running,true);
});

test('analytics activity exposes current symbols and strategies then retires completed batches',async t=>{
  const [engine]=ready(t);let release;const pending=new Promise(resolve=>{release=resolve;});
  engine.analytics.analyze=async()=>{await pending;return [];};
  engine._queue_analysis(1,'intraday',entryDailyBars());
  const controller=new AbortController(),loop=engine._analysis_loop(controller.signal);
  await new Promise(resolve=>setImmediate(resolve));
  const view=engine.snapshot();assert.equal(view.performance.active_batch_count,1);assert.deepEqual(view.performance.active_batches[0].symbols,['TEST']);assert.deepEqual(view.performance.active_batches[0].strategies,['intraday']);
  assert.equal(view.background.tasks.find(task=>task.id==='analytics').status,'running');
  release();await Promise.allSettled([...engine._analysis_tasks]);controller.abort();await assert.rejects(loop,{name:'AbortError'});
  assert.equal(engine.snapshot().performance.active_batch_count,0);
  assert.equal(engine.snapshot().background.tasks.find(task=>task.id==='analytics').status,'waiting');
});

test('broker clock health blocks new entries until measured alignment recovers without rearming a pause',async t=>{
  const [engine]=ready(t);let health={status:'skewed',blocked:true,stale:false};
  engine.broker={clock_health:()=>health};
  assert.equal(await engine._enter_locked(1,signal()),'system_clock_skew');
  assert.equal(engine.readiness().checks.find(c=>c.key==='system_clock').ok,false);
  assert.deepEqual(engine.snapshot().broker_clock,health);assert.deepEqual(engine.positions,{});
  for(const next of [{status:'unknown',blocked:false,stale:false},{status:'uncertain',blocked:false,stale:false},{status:'aligned',blocked:false,stale:true}]){
    health=next;assert.equal(await engine._enter_locked(1,signal()),'system_clock_unverified');
  }
  health={status:'aligned',blocked:false,stale:false};
  assert.equal(engine.readiness().checks.find(c=>c.key==='system_clock').ok,true);
  const [funded]=ready(t);funded.broker=engine.broker;
  assert.equal(await funded._enter_locked(1,signal()),'paper_buy_filled');
  await engine.pause();assert.equal(engine.running,false);
  assert.equal(await engine._enter_locked(1,signal()),'entries_paused');
  assert.deepEqual(engine.positions,{});
});

test('known clock skew rejects matching old ticks and clears earlier executable quotes on account refresh',async t=>{
  const [engine]=ready(t);let health={status:'skewed',blocked:true,stale:false};
  engine.broker={clock_health:()=>health,account:async()=>clone(engine.account)};
  engine._candidates.push(['old']);
  await engine._refresh_account_locked();assert.deepEqual(engine.quotes,{});assert.equal(engine._candidates.length,0);
  engine._on_ticks([{instrument_token:1,exchange_timestamp:NOW,last_price:100,volume_traded:100000}]);
  assert.deepEqual(engine.quotes,{});assert.equal(engine.snapshot().feed_fresh,false);
  health={status:'aligned',blocked:false,stale:false};engine.books[1]=new CandleBook();
  engine._on_ticks([{instrument_token:1,exchange_timestamp:NOW,last_price:100,volume_traded:100000}]);
  assert.equal(engine.quotes[1].last_price,100);
});

function shortSignal(){const s=signal();Object.assign(s,{side:'SELL',stop:102,target:96});return s;}

test('paper shorts reserve full cash, mark adverse direction and cover at executable ask after restart',async t=>{
  const [engine,store]=ready(t);engine.settings.intraday_short_enabled=true;
  assert.equal(await engine._enter_locked(1,shortSignal()),'paper_short_filled');
  const p=engine.positions.TEST;assert.equal(p.side,'SELL');assert.ok(p.entry<100);assert.equal(engine._exposure(),p.entry*p.quantity);
  p.last=98;assert.ok(engine._unrealised()>0);assert.ok(engine.snapshot().risk_used>0);engine._persist();
  const restored=new TradingEngine(engine.settings,store,options());assert.equal(restored.positions.TEST.side,'SELL');assert.equal(restored.running,false);
  engine.quotes[1].depth.sell[0].price=98;await engine._exit_locked('TEST','test');assert.ok(engine.realised>0);
  assert.match(store.log.at(-1).message,/Simulated BUY/);assert.equal(store.log.at(-1).data.exit,98*1.0005);
});

test('shorts require intraday permission, declining breadth and bid liquidity; event risk blocks entry but not exits',async t=>{
  const [engine]=ready(t),s=shortSignal();assert.equal(await engine._enter_locked(1,s),'short_strategy_disabled');
  engine.settings.intraday_short_enabled=true;s.strategy='swing';assert.equal(await engine._enter_locked(1,s),'short_strategy_disabled');s.strategy='intraday';
  Object.assign(engine.settings,{market_regime_filter:true,min_market_samples:1,min_market_coverage:1,min_market_breadth:.5});
  engine.quotes[1].ohlc={open:90};assert.equal(await engine._enter_locked(1,s),'market_breadth_defensive');
  engine.quotes[1].ohlc.open=110;engine.quotes[1].depth.buy[0].quantity=0;assert.equal(await engine._enter_locked(1,s),'insufficient_visible_liquidity');
  engine.quotes[1].depth.buy[0].quantity=10000;engine.settings.event_risk_enabled=true;
  engine.market_context.forSymbol=()=>({entry_blocked:true,blackout:true});assert.equal(await engine._enter_locked(1,s),'scheduled_event_blackout');
  engine.market_context.forSymbol=()=>({entry_blocked:false});assert.equal(await engine._enter_locked(1,s),'paper_short_filled');
  engine.market_context.forSymbol=()=>({entry_blocked:true,blackout:true});await engine._exit_locked('TEST','event');assert.equal(engine.positions.TEST,undefined);
});

test('short cover reconciliation verifies opposite child side, signed net and partial-fill profit once across restart',async t=>{
  const [engine,store]=ready(t,'live');engine.settings.intraday_short_enabled=true;
  let submissions=0;engine.broker={sell_cover:async()=>{submissions++;assert.equal(Object.values(store.get(engine.state_key).intents)[0].side,'SELL');return 'parent';}};
  assert.equal(await engine._enter_locked(1,shortSignal()),'cover_order_pending');assert.equal(submissions,1);
  const intent=Object.values(engine.intents)[0],q=intent.quantity,[parent,child]=journal(new MemoryStore(),NOW,q);
  Object.assign(parent,{tag:intent.tag,transaction_type:'SELL'});Object.assign(child,{transaction_type:'BUY',trigger_price:102});
  engine.account.orders=[parent,child];engine.account.positions.net=[{exchange:'NSE',tradingsymbol:'TEST',product:'MIS',quantity:-q}];
  await engine._reconcile_live_locked();assert.equal(intent.state,'open');assert.equal(engine.positions.TEST.side,'SELL');
  Object.assign(child,{filled_quantity:2,pending_quantity:q-2,average_price:98});engine.account.positions.net[0].quantity=-(q-2);
  await engine._reconcile_live_locked();assert.equal(engine.positions.TEST.quantity,q-2);assert.ok(Math.abs(engine.realised-(4-0.396))<1e-9);
  engine._persist();const restored=new TradingEngine(engine.settings,store,options());restored.account=engine.account;restored.broker=engine.broker;
  await restored._reconcile_live_locked();assert.equal(restored.realised,engine.realised);
  child.trigger_price=103;await engine._reconcile_live_locked();assert.equal(intent.state,'unprotected');assert.equal(engine.running,false);
  child.trigger_price=101;child.transaction_type='SELL';await engine._reconcile_live_locked();assert.equal(intent.state,'conflict');assert.equal(submissions,1);
});

test('ambiguous short order persists SELL and cannot be sent a second time',async t=>{
  const [engine,store]=ready(t,'live');engine.settings.intraday_short_enabled=true;let calls=0;
  engine.broker={sell_cover:async()=>{calls++;throw new Error('timeout');}};
  assert.equal(await engine._enter_locked(1,shortSignal()),'cover_order_unknown');assert.equal(Object.values(store.get(engine.state_key).intents)[0].side,'SELL');
  engine.running=true;assert.equal(await engine._enter_locked(1,shortSignal()),'unresolved_order');assert.equal(calls,1);
});

test('machine readiness blocks new orders under disk, memory or event-loop pressure and keeps exits available',async t=>{
  const [engine]=ready(t);Object.assign(engine.settings,{min_free_disk_mib:512,min_free_memory_mib:256,max_event_loop_delay_ms:2000});
  const resources={disk_free_mib:0,memory_free_mib:4096,event_loop_delay_ms:20};engine.runtime_health=()=>resources;
  assert.equal(await engine._enter_locked(1,signal()),'journal_disk_capacity');assert.equal(engine.readiness().checks.find(c=>c.key==='machine_capacity').ok,false);
  resources.disk_free_mib=1024;resources.memory_free_mib=16;assert.equal(await engine._enter_locked(1,signal()),'system_memory_pressure');
  resources.memory_free_mib=4096;resources.event_loop_delay_ms=5000;assert.equal(await engine._enter_locked(1,signal()),'event_loop_pressure');
  resources.event_loop_delay_ms=20;assert.equal(await engine._enter_locked(1,signal()),'paper_buy_filled');resources.disk_free_mib=0;
  await engine._exit_locked('TEST','test');assert.equal(engine.positions.TEST,undefined);
});

test('paper swing daily trailing reference ratchets durably and exits at fresh price using shared holding rules',async t=>{
  const [engine,store]=ready(t);engine.positions.TEST={symbol:'TEST',token:1,strategy:'swing',tick_size:.5,quantity:10,entry:100,last:110,stop:95,target:150,protection:'simulated',opened_at:'2026-09-01T12:00:00+05:30'};
  engine.daily[1]=Array.from({length:30},(_,i)=>new Candle(new Date(Date.UTC(2026,7,18+i)),100+i*.3,102+i*.3,98+i*.3,100+i*.3,1000));
  engine.quotes[1].last_price=110;engine._last_holdings_scan=monotonic();await engine._run_once();
  const trail=engine.positions.TEST.trailing_stop;assert.ok(trail>95);assert.equal(trail*2%1,0);assert.equal(store.get(engine.state_key).positions.TEST.trailing_stop,trail);
  engine.daily[1]=engine.daily[1].map(b=>new Candle(b.time,b.open-1,b.high-1,b.low-1,b.close-1,b.volume));await engine._run_once();assert.equal(engine.positions.TEST.trailing_stop,trail);
  engine.quotes[1].last_price=trail-1;await engine._run_once();assert.equal(engine.positions.TEST,undefined);assert.equal(store.log.at(-1).data.reason,'Daily ATR trailing exit');
});

test('incomplete historical warmup retries with backoff and preserves valid prior-session context',async t=>{
  const [engine,store]=ready(t);engine.settings.enhanced_signals=true;engine.books[1]=new CandleBook();
  const prior=Array.from({length:75},(_,i)=>({date:new Date(+new Date('2026-09-16T09:15:00+05:30')+i*300000),open:100,high:101,low:99,close:100,volume:100}));
  const today=Array.from({length:33},(_,i)=>({...prior[i],date:new Date(+new Date('2026-09-17T09:15:00+05:30')+i*300000)}));
  let calls=0;engine.broker={async call(){calls++;return [...prior,...(calls===1?today.filter((_,i)=>i!==4):today)];}};
  await engine._intraday_history_pass();assert.equal(calls,1);assert.equal(engine._intraday_history_loaded.has(1),false);assert.equal(engine.previous_intraday[1].length,75);assert.equal(store.get('intraday_seed:1').bars.length,75);
  await engine._intraday_history_pass();assert.equal(calls,1);engine._intraday_history_retry[1]=0;await engine._intraday_history_pass();
  assert.equal(calls,2);assert.equal(engine._intraday_history_loaded.has(1),true);assert.equal(engine.books[1].bars.length,33);assert.equal(engine._strategy_context(1).previous_bars.length,75);
});

function priorSessionRows(){
  return Array.from({length:75},(_,i)=>({date:new Date(+new Date('2026-09-16T09:15:00+05:30')+i*300000),open:100,high:101,low:99,close:100,volume:100}));
}
function currentSessionRows(){return priorSessionRows().slice(0,33).map(row=>({...row,date:new Date(+row.date+86400000)}));}

test('intraday warmup overlaps six downloads, refills completed slots and keeps progress accurate out of order',async t=>{
  const [engine]=ready(t),requests=[];
  for(let token=1;token<=8;token++){engine.universe[token]={tradingsymbol:`STOCK${token}`};engine.books[token]=new CandleBook();}
  engine.positions.STOCK8={symbol:'STOCK8',token:8};
  engine.broker={call:async(method,token)=>new Promise(resolve=>requests.push({token,resolve}))};
  const task=()=>engine._activity.snapshot().find(task=>task.id==='intraday_history');
  const pass=engine._intraday_history_pass();
  assert.equal(requests.length,6);assert.equal(requests[0].token,8,'Managed positions keep priority');
  assert.equal(task().completed,0);assert.match(task().current_item,/STOCK8/);
  requests[3].resolve(currentSessionRows());await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,7);assert.equal(task().completed,1);assert.equal(task().ready,1);
  assert(!task().current_item.includes(`STOCK${requests[3].token}`),'Finished downloads leave the current-symbol list');
  requests[1].resolve(currentSessionRows());await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,8);
  for(const request of requests)request.resolve(currentSessionRows());await pass;
  assert.equal(task().completed,8);assert.equal(task().ready,8);assert.equal(task().failed,0);assert.equal(task().current_item,null);
});

for(const change of ['cancel','universe','broker','date'])test(`concurrent intraday downloads cannot publish or enqueue more work after ${change}`,async t=>{
  const [engine,store]=ready(t),requests=[],controller=new AbortController();engine.settings.enhanced_signals=true;
  for(let token=1;token<=8;token++){engine.universe[token]={tradingsymbol:`STOCK${token}`};engine.books[token]=new CandleBook();}
  engine.broker={call:async(method,token)=>new Promise(resolve=>requests.push({token,resolve}))};
  const pass=engine._intraday_history_pass(controller.signal);assert.equal(requests.length,6);
  if(change==='cancel')controller.abort();
  if(change==='universe')engine._universe_generation++;
  if(change==='broker')engine.broker={};
  if(change==='date')engine._now=()=>new Date(+NOW+86400000);
  for(const request of requests)request.resolve([...priorSessionRows(),...currentSessionRows()]);await pass;
  assert.equal(requests.length,6);assert.equal(engine._intraday_history_loaded.size,0);assert.equal(engine._analysis_pending.size,0);
  for(let token=1;token<=8;token++){assert.equal(store.get(`intraday_seed:${token}`),null);assert.equal(engine.books[token].bars.length,0);}
});

test('an intraday pass drains in-flight work after an unexpected error before reporting failure',async t=>{
  const [engine]=ready(t),requests=[];
  for(let token=1;token<=8;token++){engine.universe[token]={tradingsymbol:`STOCK${token}`};engine.books[token]=new CandleBook();}
  engine.broker={call:async()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))};
  let finished=false;
  const pass=engine._intraday_history_pass().finally(()=>{finished=true;});
  const rejected=assert.rejects(pass,/Unexpected fixture error/);
  requests[0].reject(new Error('Unexpected fixture error'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(finished,false);assert.equal(requests.length,6);
  for(const request of requests.slice(1))request.resolve(currentSessionRows());await rejected;
  assert.equal(engine._activity.snapshot().find(task=>task.id==='intraday_history').status,'failed');
});
test('intraday warmup progress survives feed gaps, retries and repeat passes while readiness stays accurate',async t=>{
  const [engine]=ready(t);engine.books[1]=new CandleBook();
  let failed=false,calls=0;
  engine.broker={call:async()=>{calls++;if(failed)throw new BrokerError('NetworkException');return currentSessionRows();}};
  const task=()=>engine.snapshot().background.tasks.find(task=>task.id==='intraday_history');
  await engine._intraday_history_pass();
  assert.equal(task().completed,1);assert.equal(task().ready,1);assert.equal(task().total,1);
  await engine._intraday_history_pass();assert.equal(calls,1);assert.equal(task().completed,1);
  engine._on_stream(0,false,[1]);
  assert.equal(task().completed,1);assert.equal(task().ready,0);
  engine.quotes[1]={last_price:100,volume_traded:100000,received_at:monotonic()};failed=true;
  await engine._intraday_history_pass();assert.equal(task().completed,1);assert.equal(task().ready,0);assert.equal(task().failed,1);
  failed=false;engine._intraday_history_retry[1]=0;await engine._intraday_history_pass();
  assert.equal(task().completed,1);assert.equal(task().ready,1);assert.equal(calls,3);
  engine._now=()=>new Date('2026-09-18T12:00:00+05:30');engine._roll_day();
  assert.equal(task().completed,0);assert.equal(task().ready,0);assert.equal(task().progress_date,'2026-09-18');
});

test('intraday progress counts each completed stock once and retains progress across same-universe refresh',async t=>{
  const [engine]=ready(t);engine.universe[2]={tradingsymbol:'OTHER'};engine.books={1:new CandleBook(),2:new CandleBook()};
  engine.broker={call:async()=>currentSessionRows(),stream:async()=>{}};
  const task=()=>engine.snapshot().background.tasks.find(task=>task.id==='intraday_history');
  await engine._intraday_history_pass();assert.equal(task().completed,2);assert.equal(task().total,2);
  await engine._refresh_universe_locked([cashInstrument('TEST',1),cashInstrument('OTHER',2)]);
  assert.equal(task().completed,2);assert.equal(task().ready,0);
  await engine._refresh_universe_locked([cashInstrument('REPLACEMENT',1)]);
  assert.equal(task().completed,0);assert.equal(task().total,1);
});

test('routine candle coverage logs are bounded while Background retains live counts',async t=>{
  const [engine,store]=ready(t);engine.account.holdings=[{exchange:'NSE',tradingsymbol:'TEST',quantity:1,instrument_token:1}];
  engine.broker={call:async()=>[]};
  for(let pass=0;pass<10;pass++)await engine._history_pass();
  assert.equal(store.log.filter(event=>event.kind==='daily_history').length,1);
  assert.equal(engine.snapshot().background.tasks.find(task=>task.id==='daily_history').completed,0);
  for(let ready=1;ready<50;ready++)engine._history_progress_event('intraday_history',{ready,total:100});
  assert.equal(store.log.filter(event=>event.kind==='intraday_history').length,1);
  engine._history_logged.intraday_history.at-=301;engine._history_progress_event('intraday_history',{ready:50,total:100});
  engine._history_progress_event('intraday_history',{ready:100,total:100});engine._history_progress_event('intraday_history',{ready:100,total:100});
  assert.equal(store.log.filter(event=>event.kind==='intraday_history').length,3,'Changed coverage is sampled, and completion is reported once');
});

test('scanner keeps per-stock decisions on screen but aggregates routine activity and retains order failures',async t=>{
  const [engine,store]=ready(t);engine.running=false;engine._last_summary=monotonic();
  for(let i=0;i<50;i++){
    engine._candidate(1,signal(),{},{});await engine._run_once();
  }
  assert.equal(store.log.filter(event=>event.kind==='signal'||event.kind==='decision').length,0);
  assert.equal(engine.signals[0].status,'entries_paused');assert.equal(engine._stats['decision:entries_paused'],50);
  engine._last_summary-=301;await engine._run_once();const summary=store.log.find(event=>event.kind==='scan_summary');
  assert.equal(summary.data['decision:entries_paused'],50);assert.equal(summary.data['candidates:intraday'],50);
  engine._event('order_rejected','Order failure',{kind:'InputException'},'error');assert.equal(store.log.at(-1).kind,'order_rejected');
});
for(const [label,invalid]of[
  ['malformed OHLCV',()=>{const rows=priorSessionRows();rows[5].close=0;return rows;}],
  ['stale date',()=>priorSessionRows().map(row=>({...row,date:new Date(+row.date-7*86400000)}))],
  ['current date',()=>priorSessionRows().map(row=>({...row,date:new Date(+row.date+86400000)}))],
  ['future date',()=>priorSessionRows().map(row=>({...row,date:new Date(+row.date+2*86400000)}))],
  ['short history',()=>priorSessionRows().slice(-33)],
  ['unfinished prior session',()=>priorSessionRows().slice(0,-1)],
  ['gapped history',()=>priorSessionRows().filter((_,i)=>i!==10)],
  ['multiple sessions',()=>priorSessionRows().map((row,i)=>({...row,date:new Date(+row.date-(i<10?86400000:0))}))],
])test(`invalid same-day ${label} seed cache is replaced from prior-session history before marking intraday warmup complete`,async t=>{
  const [engine,store]=ready(t);engine.settings.enhanced_signals=true;engine.books[1]=new CandleBook();
  store.set('intraday_seed:1',{date:dateIST(NOW),symbol:'TEST',bars:invalid()});const ranges=[];
  engine.broker={call:async(method,token,from)=>{ranges.push(from);return [...priorSessionRows(),...currentSessionRows()];}};
  await engine._intraday_history_pass();
  assert.equal(ranges.length,1);assert.equal(+ranges[0],+new Date('2026-09-10T09:15:00+05:30'));
  assert.equal(engine.previous_intraday[1].length,75);assert(engine._valid_intraday_seed(engine.previous_intraday[1],dateIST(NOW)));
  assert.equal(engine._intraday_history_loaded.has(1),true);assert.equal(store.get('intraday_seed:1').bars[5].close,100);
  await engine._intraday_history_pass();assert.equal(ranges.length,1);
});

test('invalid in-memory prior seed invalidates old warmup completion and refetches despite a previous retry delay',async t=>{
  const [engine]=ready(t);engine.settings.enhanced_signals=true;engine.books[1]=new CandleBook();
  engine.previous_intraday[1]=priorSessionRows().map(row=>new Candle(row.date,row.open,row.high,row.low,row.close,row.volume));engine.previous_intraday[1][3].volume=-1;
  engine._intraday_history_loaded.add(1);engine._intraday_history_retry[1]=monotonic()+600;let calls=0;
  engine.broker={call:async(method,token,from)=>{calls++;assert.equal(dateIST(from),'2026-09-10');return [...priorSessionRows(),...currentSessionRows()];}};
  await engine._intraday_history_pass();assert.equal(calls,1);assert(engine._valid_intraday_seed(engine.previous_intraday[1],dateIST(NOW)));assert.equal(engine._intraday_history_loaded.has(1),true);
});

test('valid prior cache and in-memory seeds retain current-session-only requests and no repeated download',async t=>{
  for(const memory of [false,true]){
    const [engine,store]=ready(t);engine.settings.enhanced_signals=true;engine.books[1]=new CandleBook();
    store.set('intraday_seed:1',{date:dateIST(NOW),symbol:'TEST',bars:memory?[{close:0}]:priorSessionRows()});
    if(memory)engine.previous_intraday[1]=priorSessionRows().map(row=>new Candle(row.date,row.open,row.high,row.low,row.close,row.volume));
    const ranges=[];engine.broker={call:async(method,token,from)=>{ranges.push(from);return currentSessionRows();}};
    await engine._intraday_history_pass();await engine._intraday_history_pass();
    assert.equal(ranges.length,1);assert.equal(+ranges[0],+new Date('2026-09-17T09:15:00+05:30'));assert.equal(engine.previous_intraday[1].length,75);assert.equal(engine._intraday_history_loaded.has(1),true);
  }
});

test('invalid downloaded prior seed cannot mark a short current-session history fully warmed',async t=>{
  const [engine,store]=ready(t);engine.settings.enhanced_signals=true;engine.books[1]=new CandleBook();
  const prior=priorSessionRows();prior[7].open=null;
  engine.broker={call:async()=>[...prior,...currentSessionRows()]};await engine._intraday_history_pass();
  assert.equal(engine.previous_intraday[1],undefined);assert.equal(engine._intraday_history_loaded.has(1),false);assert.equal(store.get('intraday_seed:1'),null);assert(engine._intraday_history_retry[1]>monotonic());
});

test('candidate collection ranks opportunities, replaces stale symbol candidates and executes only after collection window',async t=>{
  const [engine]=ready(t);engine.settings.candidate_wait_ms=1500;engine.universe[2]={tradingsymbol:'SECOND'};
  const low=new Signal('intraday',100,98,104,'low',30),high=new Signal('intraday',100,98,104,'high',85),middle=new Signal('intraday',100,98,104,'replacement',50);
  const candidate=(token,s)=>{engine.books[token]=new CandleBook();engine.books[token].bars=[new Candle(new Date(NOW-300000),100,101,99,100,1000)];engine._queue_analysis(token,'intraday',engine.books[token].bars);engine._analysis_finished([{...engine._analysis_pending.get('intraday:'+token),signal:s,reason:'test'}]);};
  candidate(1,low);candidate(2,high);candidate(1,middle);
  assert.deepEqual(engine._candidates.map(row=>row[1].score),[85,50]);assert.equal(engine._candidates.length,2);
  const entered=[];engine._enter_locked=async token=>{entered.push(token);return 'checked';};engine._last_holdings_scan=monotonic();
  await engine._run_once();assert.deepEqual(entered,[]);
  engine._candidate_batch_at=monotonic()-2;await engine._run_once();assert.deepEqual(entered,[2,1]);
});

test('loss cooldown survives restart without recounting the same loss and does not restart paused trading',async t=>{
  const [engine,store]=ready(t);Object.assign(engine.settings,{loss_streak_limit:2,loss_cooldown_minutes:30});
  engine.realised=-10;engine._update_loss_control();engine.realised=-20;engine._update_loss_control();
  assert.equal(await engine._enter_locked(1,signal()),'loss_cooldown');const until=engine._loss_control.until;
  const restored=new TradingEngine(engine.settings,store,options());restored._update_loss_control();assert.equal(restored._loss_control.until,until);assert.equal(restored._loss_control.loss_events,0);
  assert.equal(restored.running,false);engine._now=()=>new Date(NOW.getTime()+31*60000);engine.running=false;engine._update_loss_control();assert.equal(engine.running,false);
});

test('breadth and account stress gates block new orders while basic entry checks otherwise pass',async t=>{
  const [engine]=ready(t);Object.assign(engine.settings,{market_regime_filter:true,min_market_samples:1,min_market_coverage:1,min_market_breadth:.5});
  engine.quotes[1].ohlc={open:110};assert.equal(await engine._enter_locked(1,signal()),'market_breadth_defensive');
  engine.settings.market_regime_filter=false;Object.assign(engine.settings,{portfolio_risk_enabled:true,max_account_stock_pct:.25,max_account_gross_pct:.9,max_account_risk_pct:.01,unprotected_stress_pct:.05});
  engine.account.holdings=[{tradingsymbol:'MANUAL',exchange:'NSE',quantity:1000,last_price:100}];
  assert.equal(await engine._enter_locked(1,signal()),'account_stress_budget');assert.deepEqual(engine.positions,{});
});

test('missing correlation history requests prioritized warmup and correlated existing exposure blocks a new buy',async t=>{
  const [engine]=ready(t);Object.assign(engine.settings,{correlation_filter:true,max_correlation:.85,max_correlated_exposure_pct:.1});engine.universe[2]={tradingsymbol:'MANUAL'};
  engine.account.holdings=[{tradingsymbol:'MANUAL',exchange:'NSE',instrument_token:2,quantity:500,last_price:100}];
  assert.equal(await engine._enter_locked(1,signal()),'correlation_history_unavailable');assert.ok(engine._correlation_wanted.has(1)&&engine._correlation_wanted.has(2));
  const bars=Array.from({length:26},(_,i)=>new Candle(new Date(Date.UTC(2026,7,i+1)),100+i,103+i,97+i,100+i+Math.sin(i),100));engine.daily[1]=bars;engine.daily[2]=bars;
  assert.equal(await engine._enter_locked(1,signal()),'correlated_exposure_limit');assert.deepEqual(engine.positions,{});
});

test('daily attempted-symbol limit and strategy metadata reach persisted execution state',async t=>{
  const [engine,store]=ready(t);engine.settings.max_trades_per_day=1;engine.traded.add('EARLIER');assert.equal(await engine._enter_locked(1,signal()),'daily_trade_limit');
  engine.traded.clear();const chosen=signal();chosen.setup='trend_pullback';assert.equal(await engine._enter_locked(1,chosen),'paper_buy_filled');
  assert.equal(store.get(engine.state_key).positions.TEST.setup,'trend_pullback');
});

test('a narrow reversion target already crossed by the executable ask cannot become a buy',async t=>{
  const [engine]=ready(t),candidate=signal();candidate.setup='range_reversion';candidate.target=100.05;
  assert.equal(await engine._enter_locked(1,candidate),'invalid_executable_reward');assert.deepEqual(engine.positions,{});
});

test('delivery allocation releases terminal IOC remainder but reserves unresolved entry quantity',t=>{
  const [engine]=ready(t,'live');const state={positions:{TEST:{symbol:'TEST',source:'swing',strategy:'swing',status:'protected',entry:100,entry_price:100,quantity:4,remaining_quantity:4,requested_quantity:10,entry_intent:'entry',token:1}},intents:{entry:{state:'terminal',order:{status:'CANCELLED'}}}};
  engine.delivery={snapshot:()=>state};engine._sync_delivery();assert.equal(engine._exposure('swing'),400);
  state.intents.entry={state:'acknowledged',order:{status:'OPEN'}};assert.equal(engine._exposure('swing'),1000);
});

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
  engine.daily[1]=entryDailyBars();
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
  engine.broker = { buy_cover: async () => { throw new BrokerError('InputException', 'Trigger range',{http_status:400,definitive_rejection:true}); } };
  assert.equal(await engine._enter_locked(1, signal()), 'cover_order_rejected'); assert.equal(engine._unresolved_intents(), false); assert.ok(store.log.some(e => e.kind === 'order_rejected'));
});

test('malformed cover entry fills retain ownership and reservation instead of resolving as an unfilled order',async t=>{
  for(const patch of [{filled_quantity:undefined},{filled_quantity:null},{filled_quantity:''},{filled_quantity:false},{filled_quantity:-1},{filled_quantity:1.5},{filled_quantity:11},{filled_quantity:0},{filled_quantity:4},{average_price:undefined},{average_price:0},{average_price:Infinity}]){
    const [engine,store]=ready(t,'live'),[parent]=journal(store,NOW,10);
    engine.intents=store.get('bot_state_live').intents;Object.assign(parent,patch);
    engine.account.orders=[parent];engine.account.positions.net=[{exchange:'NSE',tradingsymbol:'TEST',product:'MIS',quantity:10}];
    let mutations=0;engine.broker={cancel_cover:async()=>{mutations++;}};
    await engine._reconcile_live_locked();
    assert.equal(engine.intents.EB1.state,'conflict',JSON.stringify(patch));
    assert.equal(engine._unresolved_intents(),true);assert.ok(engine._exposure()>=1000);
    assert.equal(engine._portfolio().rows.find(row=>row.symbol==='TEST').exposure,2000,'Unverified fill ownership retains its reservation alongside reported account exposure');
    assert.equal(engine.snapshot().safe_to_stop,false);assert.equal(engine.running,false);assert.equal(mutations,0);
    assert.equal(engine.intents.EB1.broker_parent,undefined,'Malformed terminal data must not replace verified cached broker evidence');
    const [verifiedParent,verifiedChild]=journal(new MemoryStore(),NOW,10);engine.account.orders=[verifiedParent,verifiedChild];
    await engine._reconcile_live_locked();assert.equal(engine.intents.EB1.state,'open');assert.equal(engine.positions.TEST.quantity,10);
    assert.equal(engine._exposure(),1000);assert.equal(engine.running,false,'Verified recovery must not rearm entries');
  }
});

test('legacy malformed terminal cover cache is refreshed from order history before releasing owned exposure',async t=>{
  const [engine,store]=ready(t,'live'),[parent,child]=journal(store);engine.intents=store.get('bot_state_live').intents;
  engine.account.orders=[parent,child];engine.account.positions.net=[{exchange:'NSE',tradingsymbol:'TEST',product:'MIS',quantity:4}];
  await engine._reconcile_live_locked();
  Object.assign(engine.intents.EB1.broker_children[0],{status:'COMPLETE',filled_quantity:undefined});
  engine.account.orders=[parent];engine.account.positions.net[0].quantity=0;
  const requests=[];engine.broker={call:async(method,id)=>{requests.push([method,id]);return [{...child,status:'COMPLETE',filled_quantity:4,pending_quantity:0,average_price:98}];}};
  await engine._reconcile_live_locked();assert.deepEqual(requests,[['order_history','child']]);
  assert.equal(engine.intents.EB1.state,'closed');assert.deepEqual(engine.positions,{});assert.equal(engine._exposure(),0);
  assert.ok(engine.realised<0);
});

test('malformed cover exit fills preserve the previous owned position and verified order cache',async t=>{
  for(const patch of [{filled_quantity:undefined},{filled_quantity:null},{filled_quantity:''},{filled_quantity:false},{filled_quantity:0},{filled_quantity:4,average_price:0}]){
    const [engine,store]=ready(t,'live'),[parent,child]=journal(store);
    engine.intents=store.get('bot_state_live').intents;engine.account.orders=[parent,child];
    engine.account.positions.net=[{exchange:'NSE',tradingsymbol:'TEST',product:'MIS',quantity:4}];
    let mutations=0;engine.broker={cancel_cover:async()=>{mutations++;}};
    await engine._reconcile_live_locked();const verified=clone(engine.intents.EB1.broker_children);
    Object.assign(child,{status:'COMPLETE',pending_quantity:0,filled_quantity:4,average_price:98},patch);
    engine.account.positions.net[0].quantity=0;
    await engine._reconcile_live_locked();
    assert.equal(engine.intents.EB1.state,'conflict',JSON.stringify(patch));assert.equal(engine.positions.TEST.quantity,4);
    assert.equal(engine.realised,0);assert.deepEqual(engine.intents.EB1.broker_children,verified);
    assert.equal(engine.snapshot().safe_to_stop,false);assert.equal(mutations,0);
  }
});

test('contradictory broker rejection retains ownership and cash until the accepted cover order is reconciled',async t=>{
  const [engine]=ready(t,'live');let calls=0;
  engine.broker=new KiteBroker('test-key','test-token',{clock:()=>0,wallClock:()=>+NOW,sleep:async()=>{},fetch:async(url,request)=>{
    const headers={Date:NOW.toUTCString()};
    if(request.method==='GET'){
      assert.equal(new URL(url).pathname,'/user/profile');
      return new Response(JSON.stringify({status:'success',data:{user_id:'TEST'}}),{headers});
    }
    calls++;return new Response(JSON.stringify({status:'error',error_type:'InputException',message:'Contradictory acknowledgement',data:{order_id:'parent'}}),{status:500,headers});
  }});
  // Entry begins after the authenticated response has verified the host clock.
  await engine.broker.call('profile');assert.equal(engine.broker.clock_health().status,'aligned');
  assert.equal(await engine._enter_locked(1,signal()),'cover_order_unknown');
  const intent=Object.values(engine.intents)[0];assert.equal(calls,1);assert.equal(engine._unresolved_intents(),true);assert.ok(engine._exposure()>0);assert.equal(engine.running,false);
  const [parent,child]=journal(new MemoryStore(),NOW,intent.quantity);parent.tag=intent.tag;
  engine.account.orders=[parent,child];engine.account.positions.net=[{exchange:'NSE',tradingsymbol:'TEST',product:'MIS',quantity:intent.quantity}];
  await engine._reconcile_live_locked();assert.equal(intent.order_id,'parent');assert.equal(intent.state,'open');assert.equal(engine.positions.TEST.quantity,intent.quantity);assert.equal(calls,1);
});

test('malformed turnover and visible depth cannot authorize a new order',async t=>{
  const [engine]=ready(t);engine.quotes[1].volume_traded='invalid';assert.equal(await engine._enter_locked(1,signal()),'turnover_too_low');
  engine.quotes[1].volume_traded=100000;engine.quotes[1].depth.sell[0].quantity='invalid';assert.equal(await engine._enter_locked(1,signal()),'insufficient_visible_liquidity');
  engine.books[1]=new CandleBook();const before=engine.quotes[1];engine._on_ticks([{instrument_token:1,exchange_timestamp:NOW,last_price:200,volume_traded:'invalid'}]);assert.equal(engine.quotes[1],before);
});

test('older exchange ticks cannot roll back quotes, depth or position marks; equal timestamps still update',t=>{
  let clock=100000,now=NOW;t.mock.method(process.hrtime,'bigint',()=>BigInt(clock)*1000000n);
  const [engine]=ready(t);engine._now=()=>now;engine.books[1]=new CandleBook();engine.positions.TEST={last:100};
  const tick={...engine.quotes[1],instrument_token:1,exchange_timestamp:NOW};engine._on_ticks([tick]);
  const quote=engine.quotes[1],heartbeat=engine._heartbeat,freshness=engine._last_tick_received;
  clock+=2000;now=new Date(+NOW+2000);
  engine._on_ticks([{...tick,exchange_timestamp:new Date(+NOW-1000),last_price:90,volume_traded:99999,depth:{buy:[{price:89.95,quantity:100}],sell:[{price:90.05,quantity:100}]}}]);
  assert.equal(engine.quotes[1],quote);assert.equal(engine.positions.TEST.last,100);assert.equal(engine.books[1].current.close,100);
  assert.equal(engine._last_tick_received,freshness);assert.equal(engine._heartbeat,heartbeat);
  engine._on_ticks([{...tick,last_price:100.1,volume_traded:100001,depth:{buy:[{price:100.05,quantity:100}],sell:[{price:100.15,quantity:100}]}}]);
  assert.equal(engine.quotes[1].last_price,100.1);assert.equal(engine.quotes[1].depth.sell[0].price,100.15);assert.equal(engine.positions.TEST.last,100.1);
  assert.equal(engine.books[1].current.close,100.1);assert.equal(engine.quotes[1].received_at,freshness,'Same exchange timestamp does not renew its freshness window');
});

test('same-session cumulative volume rollbacks cannot contaminate quotes, freshness, positions or completed analytics candles',t=>{
  let now=new Date('2026-09-17T09:15:00+05:30');const [engine]=ready(t);engine._now=()=>now;engine.books[1]=new CandleBook();engine.positions.TEST={last:100};
  const base={...engine.quotes[1],instrument_token:1};
  const tick=(at,volume,price=100)=>{now=new Date(at);engine._on_ticks([{...base,exchange_timestamp:now,last_price:price,volume_traded:volume}]);};
  tick('2026-09-17T09:15:00+05:30',1000);tick('2026-09-17T09:19:50+05:30',1100);tick('2026-09-17T09:20:00+05:30',1200);
  const quote=engine.quotes[1],book=structuredClone(engine.books[1]),heartbeat=engine._heartbeat,freshness=engine._last_tick_received;
  for(const at of ['09:20:00','09:20:01']){
    tick(`2026-09-17T${at}+05:30`,1000,999);
    assert.equal(engine.quotes[1],quote);assert.equal(engine.positions.TEST.last,100);assert.deepEqual(structuredClone(engine.books[1]),book);
    assert.equal(engine._heartbeat,heartbeat);assert.equal(engine._last_tick_received,freshness);assert.equal(engine._analysis_pending.size,0);
  }
  tick('2026-09-17T09:24:50+05:30',1400);tick('2026-09-17T09:25:00+05:30',1500);
  assert.equal(engine.books[1].bars[0].volume,300);assert.equal(engine._analysis_pending.get('intraday:1').bars[0].volume,300);assert.equal(engine.quotes[1].volume_traded,1500);
  tick('2026-09-18T09:15:00+05:30',100,101);
  assert.equal(engine.quotes[1].volume_traded,100);assert.equal(engine.positions.TEST.last,101);assert.equal(engine.books[1].bars.length,0);assert.equal(engine.books[1].current.volume,0);assert.equal(engine.books[1].complete,false);
  tick('2026-09-18T09:15:00+05:30',101,102);
  assert.equal(engine.quotes[1].volume_traded,101);assert.equal(engine.books[1].current.volume,1);assert.equal(engine.positions.TEST.last,102);
  tick('2026-09-18T09:15:00+05:30',101,103);
  assert.equal(engine.quotes[1].last_price,103);assert.equal(engine.books[1].current.volume,1);assert.equal(engine.books[1].current.close,102,'An unchanged-volume quote is accepted without inventing a candle trade');
});

test('cumulative volume rollback is rejected against retained candle history after quotes are cleared',t=>{
  const [engine]=ready(t);engine.books[1]=new CandleBook();engine.books[1].update(NOW,100,1000);delete engine.quotes[1];
  engine._on_ticks([{instrument_token:1,exchange_timestamp:NOW,last_price:999,volume_traded:900}]);
  assert.equal(engine.quotes[1],undefined);assert.equal(engine.books[1].last_volume,1000);assert.equal(engine.books[1].current.close,100);
});

test('delayed ticks expire at ten seconds of exchange age for breadth, entries, exits and readiness',async t=>{
  let clock=100000,now=NOW;t.mock.method(process.hrtime,'bigint',()=>BigInt(clock)*1000000n);
  const [engine]=ready(t);engine._now=()=>now;engine.books[1]=new CandleBook();
  const tick={...engine.quotes[1],instrument_token:1,exchange_timestamp:new Date(+NOW-9000),ohlc:{open:99}};
  engine._on_ticks([tick]);assert.equal(engine.quotes[1].received_at,91);assert.equal(engine._last_tick_received,91);
  const breadthSettings={...engine.settings,market_regime_filter:true,min_market_samples:1,min_market_coverage:1,min_market_breadth:.5};
  assert.equal(marketBreadth(engine.universe,engine.quotes,breadthSettings,monotonic()).status,'eligible');assert.equal(engine.snapshot().feed_fresh,true);
  clock+=2000;now=new Date(+NOW+2000);
  assert.equal(marketBreadth(engine.universe,engine.quotes,breadthSettings,monotonic()).status,'warming_up');
  assert.equal(engine.snapshot().feed_fresh,false);assert.equal(engine.readiness().checks.find(check=>check.key==='live_feed').ok,false);
  assert.equal(await engine._enter_locked(1,signal()),'quote_stale');
  engine.positions.TEST={symbol:'TEST',token:1,strategy:'intraday',side:'BUY',quantity:10,entry:100,last:100,stop:98,target:104,opened_at:isoIST(NOW)};
  await engine._exit_locked('TEST','test');assert.ok(engine.positions.TEST,'Stale executable quote cannot fill a simulated exit');
  const stale=engine.quotes[1];engine._on_ticks([tick]);assert.equal(engine.quotes[1],stale,'Repeated stale packet cannot renew freshness');
});

test('freshness windows never move into the future and older instruments cannot reset feed freshness',t=>{
  let clock=100000;t.mock.method(process.hrtime,'bigint',()=>BigInt(clock)*1000000n);
  const [engine]=ready(t);engine.books[1]=new CandleBook();engine.universe[2]={tradingsymbol:'SECOND'};engine.books[2]=new CandleBook();
  const tick={...engine.quotes[1],instrument_token:1,exchange_timestamp:new Date(+NOW+10000)};
  engine._on_ticks([tick]);assert.equal(engine.quotes[1].received_at,100);
  engine._on_ticks([{...tick,instrument_token:2,exchange_timestamp:new Date(+NOW-9000)}]);
  assert.equal(engine.quotes[2].received_at,91);assert.equal(engine._last_tick_received,100);
  const before=engine.quotes[1];engine._on_ticks([{...tick,exchange_timestamp:new Date(+NOW+10001),last_price:200}]);assert.equal(engine.quotes[1],before);
  clock+=10001;assert.equal(engine.snapshot().feed_fresh,false,'Future tolerance does not extend receipt freshness beyond ten seconds');
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

test('new candle and no-signal result invalidate a queued candidate before execution',async t=>{
  const [engine]=ready(t);let now=new Date('2026-09-17T10:04:59+05:30');engine._now=()=>now;engine.books[1]=new CandleBook();
  engine.books[1].bars=[new Candle(new Date('2026-09-17T09:55:00+05:30'),100,101,99,100,1000)];
  engine._queue_analysis(1,'intraday',engine.books[1].bars);const first={...engine._analysis_pending.get('intraday:1'),signal:signal(),reason:'test'};
  engine._analysis_finished([first]);assert.equal(engine._candidates.length,1);const saved=engine._candidates[0];
  now=new Date('2026-09-17T10:05:01+05:30');engine.books[1].bars.push(new Candle(new Date('2026-09-17T10:00:00+05:30'),100,101,99,100,1000));
  engine._queue_analysis(1,'intraday',engine.books[1].bars);assert.equal(engine._candidates.length,0);assert.equal(saved[3].status,'superseded_analysis');
  engine._analysis_finished([{...engine._analysis_pending.get('intraday:1'),signal:null,reason:'no_enhanced_setup'}]);
  assert.equal(engine._candidates.length,0);assert.equal(await engine._enter_locked(1,saved[1],saved[3].source),'signal_superseded');assert.deepEqual(engine.positions,{});
});

test('same-candle context revisions reject older worker results and deduplicate refreshes',async t=>{
  const [engine]=ready(t);engine.books[1]=new CandleBook();engine.books[1].bars=[new Candle(new Date(NOW-300000),100,101,99,100,1000)];
  const reference=[new Candle(new Date(NOW-600000),100,101,99,100,1000)];engine.market_context.contextForSymbol=()=>({benchmark_bars:clone(reference)});
  engine._queue_analysis(1,'intraday',engine.books[1].bars);const first={...engine._analysis_pending.get('intraday:1'),signal:signal(),reason:'test'};
  engine._analysis_finished([first]);assert.equal(engine._candidates.length,1);
  reference.push(new Candle(new Date(NOW-300000),100,101,99,100,1000));
  const controller=new AbortController();let refreshes=0;engine.market_context.refresh=async()=>{refreshes++;};
  const refresh=engine._refresh_context_analyses.bind(engine);engine._refresh_context_analyses=()=>{refresh();controller.abort();};
  await assert.rejects(engine._market_context_loop(controller.signal),/aborted/);assert.equal(refreshes,1);assert.equal(engine._candidates.length,0);
  const current=engine._analysis_pending.get('intraday:1');assert.ok(current.analysis_id>first.analysis_id);assert.equal(current.context.benchmark_bars.length,2);
  engine._analysis_finished([first]);assert.equal(engine._candidates.length,0);
  engine._analysis_finished([{...current,signal:signal(),reason:'test'}]);assert.equal(engine._candidates.length,1);
  refresh();assert.equal(engine._analysis_pending.get('intraday:1').analysis_id,current.analysis_id);assert.equal(engine._candidates.length,1);
});

test('source candle ages out at the next boundary even before a replacement tick arrives',async t=>{
  const [engine]=ready(t);let now=new Date('2026-09-17T10:04:59+05:30');engine._now=()=>now;engine.books[1]=new CandleBook();
  engine.books[1].bars=[new Candle(new Date('2026-09-17T09:55:00+05:30'),100,101,99,100,1000)];engine._queue_analysis(1,'intraday',engine.books[1].bars);
  engine._analysis_finished([{...engine._analysis_pending.get('intraday:1'),signal:signal(),reason:'test'}]);const candidate=engine._candidates[0];
  now=new Date('2026-09-17T10:05:00+05:30');assert.equal(await engine._enter_locked(1,candidate[1],candidate[3].source),'signal_candle_stale');assert.deepEqual(engine.positions,{});
});
test('existing-holding paper sell needs selection, is idempotent, and never changes real account/P&L', t => {
  const [engine, store] = ready(t); engine.account.holdings = [{ exchange: 'NSE', tradingsymbol: 'TEST', quantity: 10, instrument_token: 1 }];
  engine.daily[1] = Array.from({ length: 21 }, (_, i) => new Candle(new Date(NOW - (21 - i) * 86400000), 100, 101, 99, 100, 1000));
  engine._analysis_cache.set('swing:1', { holding: { trailing: 95, trend_exit: true } }); engine._analyze_holdings(); assert.deepEqual(engine._paper_holding_actions, {});
  store.set('strategy_settings', { manage_existing_holdings: 'selected', managed_symbols: ['TEST'] }); engine._analyze_holdings(); engine._analyze_holdings();
  assert.equal(Object.keys(engine._paper_holding_actions).length, 1); assert.equal(engine.account.holdings[0].quantity, 10); assert.equal(engine.realised, 0);
});

for (const mode of ['paper','live']) test(`ignore existing stocks blocks long, short and swing entries in ${mode} mode`,async t=>{
  const [engine,store]=ready(t,mode);engine.settings.intraday_short_enabled=true;
  store.set('strategy_settings',{intraday_enabled:true,swing_enabled:true,intraday_allocation_pct:.5,swing_allocation_pct:.5,manage_existing_holdings:'ignore',managed_symbols:['TEST']});
  for(const holding of [{quantity:5},{quantity:0,t1_quantity:5},{quantity:0,collateral_quantity:5},{quantity:5,used_quantity:5},{quantity:5,discrepancy:true},{quantity:5,exchange:'BSE'}]){
    engine.account.holdings=[{exchange:'NSE',tradingsymbol:'TEST',...holding}];
    for (const entry of [signal(),shortSignal(),signal('swing')]) assert.equal(await engine._enter_locked(1,entry),'existing_holdings_ignored');
  }
  engine.account.holdings=[];engine.account.positions.net=[{tradingsymbol:'TEST',product:'CNC',quantity:5}];
  assert.equal(await engine._enter_locked(1,signal()),'existing_holdings_ignored');
  assert.deepEqual(engine.positions,{});assert.deepEqual(engine.intents,{});assert.equal(store.log.some(e=>e.kind==='order_intent'||e.kind==='paper_fill'),false);
  engine.account.positions.net=[];engine.account.holdings=[{tradingsymbol:'OTHER',quantity:5}];
  if(mode==='live')engine.broker={buy_cover:async()=> 'unrelated-entry'};
  assert.equal(await engine._enter_locked(1,signal()),mode==='paper'?'paper_buy_filled':'cover_order_pending');
});

test('ignored holdings override saved selections, suppress sales and authorization, and remain in risk exposure',t=>{
  const [engine,store]=ready(t);store.set('strategy_settings',{...engine.strategy_settings(),manage_existing_holdings:'ignore',managed_symbols:['TEST']});
  engine.account.holdings=[{exchange:'NSE',tradingsymbol:'TEST',quantity:10,instrument_token:1,last_price:100,average_price:100}];
  engine.daily[1]=entryDailyBars();engine._analysis_cache.set('swing:1',{holding:{trailing:105,trend_exit:true}});
  assert.deepEqual(engine._authorized_holdings(),[]);assert.deepEqual(engine._holding_management_settings().managed_symbols,[]);
  engine._analyze_holdings();assert.deepEqual(engine._paper_holding_actions,{});
  assert.equal(engine.holdings_signals[0].status,'ignored');assert.equal(engine.holdings_signals[0].managed,false);
  assert.ok(engine._portfolio().rows.some(row=>row.symbol==='TEST'&&row.exposure>0));
});
test('holding snapshots explain excluded and other-exchange holdings without taking paper actions', t => {
  const [engine,store]=ready(t);engine.universe_summary={status:'verified'};engine._universe_date=dateIST(NOW);
  store.set('strategy_settings',{manage_existing_holdings:'all'});
  engine.account.holdings=[
    {exchange:'NSE',tradingsymbol:'TEST',instrument_token:1,quantity:10},
    {exchange:'NSE',tradingsymbol:'EXCLUDED',instrument_token:99,quantity:10},
    {exchange:'BSE',tradingsymbol:'TEST',instrument_token:1,quantity:10},
  ];
  for(const token of [1,99]){engine.daily[token]=entryDailyBars();engine._analysis_cache.set(`swing:${token}`,{holding:{trailing:95,trend_exit:true}});}
  const rows=engine.snapshot().holdings_signals;
  assert.equal(rows.length,3);assert.equal(rows[0].status,'exit_candidate');assert.equal(rows[0].managed,true);
  assert.equal(rows[1].status,'unsupported');assert.match(rows[1].reason,/Outside the verified NSE/);assert.equal(rows[1].managed,false);
  assert.equal(rows[2].status,'unsupported');assert.equal(rows[2].exchange,'BSE');assert.equal(rows[2].managed,false);
  assert.deepEqual(engine._paper_holding_actions,{});assert.equal(store.log.some(row=>row.kind==='paper_holding_exit'),false);
  engine._analyze_holdings();assert.deepEqual(Object.keys(engine._paper_holding_actions),[`${engine.day}:TEST`]);
  assert.deepEqual(engine.account.holdings.map(row=>row.quantity),[10,10,10]);
});
test('holding statuses distinguish unverified eligibility from unsupported instruments after verification', t => {
  const [engine]=ready(t);engine.universe={};engine.universe_summary={status:'unavailable'};
  engine.account.holdings=[{exchange:'NSE',tradingsymbol:'UNKNOWN',instrument_token:99,quantity:10}];
  assert.equal(engine.snapshot().holdings_signals[0].status,'universe_unavailable');
  engine.universe_summary={status:'verified'};
  assert.equal(engine.snapshot().holdings_signals[0].status,'unsupported');
});
test('recovery-only holdings retain exit analysis without allowing new holding adoption', t => {
  const [engine,store]=ready(t);store.set('strategy_settings',{manage_existing_holdings:'all'});
  engine.universe[1].entry_eligible=false;engine.universe[1].recovery_only=true;
  engine.account.holdings=[{exchange:'NSE',tradingsymbol:'TEST',instrument_token:1,quantity:10}];
  engine.daily[1]=entryDailyBars();engine._analysis_cache.set('swing:1',{holding:{trailing:95,trend_exit:true}});
  let row=engine.snapshot().holdings_signals[0];assert.equal(row.scope,'recovery_only');assert.equal(row.status,'exit_candidate');assert.equal(row.managed,false);
  engine._analyze_holdings();assert.deepEqual(engine._paper_holding_actions,{});assert.deepEqual(engine._authorized_holdings(),[]);
  engine.delivery={snapshot:()=>({positions:{TEST:{status:'protected',source:'existing',remaining_quantity:10}},blocked:false})};
  row=engine.snapshot().holdings_signals[0];assert.equal(row.scope,'recovery_only');assert.equal(row.managed,true);assert.equal(row.status,'exit_candidate');
  assert.deepEqual(engine._paper_holding_actions,{},'Reading status must never execute a simulated exit');
});
test('holding history and status follow the current matching symbol token and recover from unusable history', async t => {
  const [engine]=ready(t);engine.universe[2]={tradingsymbol:'OTHER',tick_size:.05};
  engine.account.holdings=[{exchange:'NSE',tradingsymbol:'TEST',instrument_token:2,quantity:10}];
  let usable=false;const requests=[];engine.broker={call:async(method,token)=>{assert.equal(method,'historical_data');requests.push(token);return usable?completedDailyRows():[];}};
  assert.equal(engine.snapshot().holdings_signals[0].status,'warming_up');
  await engine._history_pass();let row=engine.snapshot().holdings_signals[0];assert.equal(row.token,1);assert.equal(row.status,'history_unavailable');assert.match(row.reason,/retry automatically/);
  usable=true;engine._daily_history_retry[1].next_at=0;await engine._history_pass();
  assert.deepEqual(requests,[1,1]);assert.equal(engine.snapshot().holdings_signals[0].status,'analysing');
  engine._analysis_cache.set('swing:1',{holding:{trailing:95,trend_exit:false}});
  assert.equal(engine.snapshot().holdings_signals[0].status,'hold');
  engine.quotes[1].received_at=monotonic()-20;row=engine.snapshot().holdings_signals[0];assert.equal(row.status,'awaiting_market_data');assert.match(row.reason,/fresh quote/);
  engine._analysis_cache.delete('swing:1');assert.match(engine.snapshot().holdings_signals[0].reason,/start exit analysis/);
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
test('connection classifies the full broker master before applying the streaming capacity limit', async t => {
  const broker=new RecoveryBroker(),original=broker.call.bind(broker),master=Array.from({length:10111},(_,i)=>({instrument_token:i+1,exchange:'NSE',segment:'NSE',instrument_type:'EQ',tradingsymbol:i===0?'TEST':`DEBT${i}`,tick_size:.05}));
  broker.call=async(method,...args)=>method==='instruments'?master:original(method,...args);
  let subscribed;
  broker.stream=async tokens=>{subscribed=tokens;};
  const engine=new TradingEngine(settings(temp(t)),new MemoryStore(),options({brokerFactory:()=>broker,equityUniverse:{resolve:async instruments=>{
    assert.equal(instruments.length,10111);
    return {instruments:[{...instruments[0],entry_eligible:true}],summary:{status:'verified',entry_eligible_count:1,excluded_counts:{outside_equity_directory:10110}}};
  }}}));
  t.after(()=>engine.shutdown());await engine.connect('synthetic-session','AB1234');
  assert.equal(engine.connected,true);assert.deepEqual(subscribed,[1]);assert.equal(engine.snapshot().universe_count,1);
  assert.equal(engine.readiness().checks.find(c=>c.key==='equity_universe').ok,true);
  assert.equal(engine.snapshot().universe_classification.excluded_counts.outside_equity_directory,10110);
});

test('unavailable equity directory blocks entries and automatically recovers through bounded monitoring retry',async t=>{
  const broker=new RecoveryBroker();let available=false,resolutions=0;
  const engine=new TradingEngine(settings(temp(t)),new MemoryStore(),options({brokerFactory:()=>broker,equityUniverse:{resolve:async instruments=>{
    resolutions++;return {instruments:available?instruments.map(i=>({...i,entry_eligible:true})):[],summary:{status:available?'verified':'unavailable'}};
  }}}));
  t.after(()=>engine.shutdown());await engine.connect('synthetic-session','AB1234');await engine.start();
  assert.equal(engine.connected,true);assert.equal(engine.running,true);assert.equal(engine.recovery.blocked,true);assert.equal(engine.universe_summary.status,'unavailable');
  const pass=async()=>{const controller=new AbortController();engine._wait_reconciliation=async()=>controller.abort();await engine._monitor(controller.signal);};
  await pass();assert.equal(resolutions,1,'failed sources are not retried on every account poll');
  available=true;engine._universe_retry_at=0;await pass();
  assert.equal(resolutions,2);assert.equal(engine.recovery.phase,'ready');assert.equal(engine.running,true);assert.equal(engine.universe[22].entry_eligible,true);
  assert.equal(broker.calls.filter(c=>c==='instruments').length,1,'same-day retry reuses the broker master');
});

test('directory outage retains owned instruments for exits without authorizing fresh entries or new holding adoption',async t=>{
  const [engine,store]=ready(t);t.after(()=>engine.shutdown());
  const instrument={instrument_token:22,exchange:'NSE',segment:'NSE',instrument_type:'EQ',tradingsymbol:'TEST',tick_size:.05};
  engine.positions.TEST={symbol:'TEST',token:1,strategy:'intraday',side:'BUY',quantity:1,entry:100,last:100,stop:98,target:104,entry_fee:.1,opened_at:isoIST(NOW),protection:'simulated'};
  engine.broker=new RecoveryBroker();engine.equity_universe={resolve:async(instruments,{managedSymbols})=>{
    assert.deepEqual(managedSymbols,['TEST']);return {instruments:[{...instruments[0],entry_eligible:false}],summary:{status:'unavailable'}};
  }};
  store.set('strategy_settings',{intraday_enabled:true,swing_enabled:false,intraday_allocation_pct:1,swing_allocation_pct:0,manage_existing_holdings:'all',managed_symbols:[]});
  engine.account.holdings=[{exchange:'NSE',product:'CNC',tradingsymbol:'TEST',quantity:10}];
  await engine._refresh_universe_locked([instrument]);engine._advance_recovery();
  assert.equal(engine.positions.TEST.token,22);assert.equal(engine.connected,true);assert.equal(engine.recovery.blocked,true);
  assert.equal(await engine._enter_locked(22,signal()),'instrument_not_entry_eligible');assert.deepEqual(engine._authorized_holdings(),[]);
  engine.quotes[22]={last_price:97,received_at:monotonic(),depth:{buy:[{price:97,quantity:100}],sell:[{price:97.05,quantity:100}]}};
  await engine._run_once();assert.equal(engine.positions.TEST,undefined,'existing simulated stop still exits during directory failure');
  assert.ok(store.log.some(row=>row.kind==='paper_fill'&&row.data.reason==='stop_loss'));
});

test('a new trading day refreshes both the broker master and official directory before admitting entries',async t=>{
  const broker=new RecoveryBroker();let now=NOW,resolutions=0;
  const engine=new TradingEngine(settings(temp(t)),new MemoryStore(),options({now:()=>now,brokerFactory:()=>broker,equityUniverse:{resolve:async instruments=>{
    resolutions++;return {instruments:instruments.map(i=>({...i,entry_eligible:true})),summary:{status:'verified'}};
  }}}));
  t.after(()=>engine.shutdown());await engine.connect('synthetic-session','AB1234');await engine.start();
  now=new Date(+NOW+86400000);
  assert.equal(await engine._enter_locked(22,signal()),'equity_directory_unavailable');
  engine._universe_retry_at=0;
  const controller=new AbortController();engine._wait_reconciliation=async()=>controller.abort();await engine._monitor(controller.signal);
  assert.equal(resolutions,2);assert.equal(broker.calls.filter(c=>c==='instruments').length,2);assert.equal(engine._universe_date,dateIST(now));
});

const cashInstrument=(symbol,token=1)=>({instrument_token:token,exchange:'NSE',segment:'NSE',instrument_type:'EQ',tradingsymbol:symbol,tick_size:.05});
const repriceRows=(rows,delta)=>rows.map(row=>({...row,open:row.open+delta,high:row.high+delta,low:row.low+delta,close:row.close+delta}));

test('token reuse discards the previous security memory and disk history before analysing its replacement',async t=>{
  const [engine,store]=ready(t);engine.settings.enhanced_signals=true;
  store.set('strategy_settings',{intraday_enabled:true,swing_enabled:true,intraday_allocation_pct:.5,swing_allocation_pct:.5});
  engine.books[1]=new CandleBook();engine.books[1].bars=currentSessionRows().map(row=>new Candle(row.date,row.open,row.high,row.low,row.close,row.volume));
  engine.daily[1]=completedDailyRows().map(row=>new Candle(row.date,row.open,row.high,row.low,row.close,row.volume));
  engine.previous_intraday[1]=priorSessionRows().map(row=>new Candle(row.date,row.open,row.high,row.low,row.close,row.volume));
  store.set('daily:1',{date:dateIST(NOW),symbol:'TEST',rows:completedDailyRows()});
  store.set('intraday_seed:1',{date:dateIST(NOW),symbol:'TEST',bars:priorSessionRows()});
  engine._daily_history_retry[1]={attempts:4,next_at:monotonic()+300};engine._intraday_history_loaded.add(1);
  const calls=[];engine.broker={stream:async()=>{},call:async(method,token,from,to,interval)=>{
    calls.push({method,token,from,interval});return repriceRows(interval==='day'?completedDailyRows():[...priorSessionRows(),...currentSessionRows()],100);
  }};
  await engine._refresh_universe_locked([cashInstrument('NEW')]);
  assert.equal(engine.books[1].bars.length,0);assert.equal(engine.daily[1],undefined);assert.equal(engine.previous_intraday[1],undefined);
  assert.equal(engine._daily_history_retry[1],undefined);assert.equal(engine._intraday_history_loaded.has(1),false);
  engine.quotes[1]={last_price:200,received_at:monotonic()};await engine._history_pass();await engine._intraday_history_pass();
  assert.deepEqual(calls.map(call=>call.interval),['day','5minute']);assert.equal(dateIST(calls[1].from),'2026-09-10');
  assert.equal(engine.daily[1][0].close,200);assert.equal(engine.books[1].bars[0].close,200);
  assert.equal(engine._strategy_context(1).previous_bars[0].close,200);
  assert.equal(store.get('daily:1').symbol,'NEW');assert.equal(store.get('intraday_seed:1').symbol,'NEW');
  const daily=engine.daily[1],prior=engine.previous_intraday[1];
  await engine._refresh_universe_locked([cashInstrument('NEW')]);
  assert.equal(engine.daily[1],daily);assert.equal(engine.previous_intraday[1],prior,'Unchanged identity retains verified memory');
});

for(const symbol of [undefined,'OTHER'])test(`${symbol?'mismatched':'legacy unbound'} history caches refetch rather than borrowing a token identity`,async t=>{
  const [engine,store]=ready(t);requireHistoryForHolding(engine);engine.settings.enhanced_signals=true;engine.books[1]=new CandleBook();
  store.set('daily:1',{date:dateIST(NOW),symbol,rows:repriceRows(completedDailyRows(),-20)});
  store.set('intraday_seed:1',{date:dateIST(NOW),symbol,bars:repriceRows(priorSessionRows(),-20)});
  const calls=[];engine.broker={call:async(method,token,from,to,interval)=>{calls.push(interval);return interval==='day'?completedDailyRows():[...priorSessionRows(),...currentSessionRows()];}};
  await engine._history_pass();await engine._intraday_history_pass();
  assert.deepEqual(calls,['day','5minute']);assert.equal(engine.daily[1][0].close,100);assert.equal(engine.previous_intraday[1][0].close,100);
  assert.equal(store.get('daily:1').symbol,'TEST');assert.equal(store.get('intraday_seed:1').symbol,'TEST');
  const restored=new TradingEngine(engine.settings,store,options());restored.connected=true;restored.broker=engine.broker;restored.universe=clone(engine.universe);restored.account=clone(engine.account);
  await restored._history_pass();assert.equal(calls.length,2,'Verified symbol-bound daily cache is reusable after restart');
});

for(const interval of ['day','5minute'])for(const change of ['token reuse','same-symbol refresh','broker replacement','date rollover'])test(`late ${interval} response cannot publish after ${change}`,async t=>{
  const [engine,store]=ready(t);requireHistoryForHolding(engine);engine.settings.enhanced_signals=true;engine.books[1]=new CandleBook();
  let resolve,requests=0;const pending=new Promise(done=>{resolve=done;});
  engine.broker={stream:async()=>{},call:async()=>{requests++;return pending;}};
  const task=interval==='day'?engine._history_pass():engine._intraday_history_pass();assert.equal(requests,1);
  if(change==='token reuse'||change==='same-symbol refresh')await engine._refresh_universe_locked([cashInstrument(change==='token reuse'?'NEW':'TEST')]);
  else if(change==='broker replacement')engine.broker={call:async()=>{throw new Error('Not requested');}};
  else{engine._now=()=>new Date(+NOW+86400000);engine._roll_day();}
  resolve(interval==='day'?completedDailyRows():[...priorSessionRows(),...currentSessionRows()]);await task;
  assert.equal(engine.daily[1],undefined);assert.equal(engine.previous_intraday[1],undefined);assert.equal(engine.books[1].bars.length,0);
  assert.equal(store.get('daily:1'),null);assert.equal(store.get('intraday_seed:1'),null);
  assert.equal(engine._analysis_pending.size,0);assert.equal(engine._history_date,'');assert.equal(engine._intraday_history_loaded.has(1),false);
});

test('failed stream replacement remains blocked and retries through the bounded monitor path',async t=>{
  const broker=new RecoveryBroker(),engine=new TradingEngine(settings(temp(t)),new MemoryStore(),options({brokerFactory:()=>broker}));
  t.after(()=>engine.shutdown());await engine.connect('synthetic-session','AB1234');await engine.start();
  const stream=broker.stream.bind(broker);let attempts=0;
  broker.stream=async(...args)=>{if(++attempts===1)throw new Error('Feed worker termination unconfirmed');return stream(...args);};
  const began=monotonic();await assert.rejects(engine._refresh_universe_locked(),/termination unconfirmed/);engine._advance_recovery();
  assert.equal(engine._universe_date,'');assert.equal(engine.recovery.blocked,true);
  assert.equal(engine.readiness().checks.find(check=>check.key==='equity_universe').ok,false);
  assert.equal(await engine._enter_locked(22,signal()),'equity_directory_unavailable');
  assert(engine._universe_retry_at>=began+60);
  const pass=async()=>{const controller=new AbortController();engine._wait_reconciliation=async()=>controller.abort();await engine._monitor(controller.signal);};
  await pass();assert.equal(attempts,1,'Account polling cannot bypass the setup retry delay');
  engine._universe_retry_at=0;await pass();
  assert.equal(attempts,2);assert.equal(engine._universe_date,dateIST(NOW));assert.equal(engine.recovery.phase,'ready');
  assert.equal(engine.streams[0],true);assert.equal(broker.calls.filter(method=>method==='instruments').length,1);
});

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

const diagnosticSecret = 'synthetic-private-session-value';
const sensitiveFailureText = `${diagnosticSecret} https://broker.invalid/?access_token=${diagnosticSecret} Authorization: token private-key:${diagnosticSecret}`;
function assertPrivateFailure(engine, store) {
  const recorded = JSON.stringify({ events: store.log, journal: store.values, snapshot: engine.snapshot() });
  assert.equal(recorded.includes(diagnosticSecret), false); assert.equal(recorded.includes('broker.invalid'), false);
  assert.equal(recorded.includes('Authorization:'), false); assert.equal(recorded.includes('private-key'), false);
}
for (const [stage, makeError, kind, http_status] of [
  ['profile', () => new BrokerError('TokenException', sensitiveFailureText, { http_status: 403 }), 'TokenException', 403],
  ['account', () => new BrokerError('PermissionException', sensitiveFailureText, { http_status: 403 }), 'PermissionException', 403],
  ['universe', () => new BrokerError('NetworkException', sensitiveFailureText, { http_status: 502 }), 'NetworkException', 502],
  ['stream', () => new TypeError(sensitiveFailureText), 'TypeError', null],
  ['account', () => Object.assign(new Error(sensitiveFailureText), { name: sensitiveFailureText, kind: 'TokenException', http_status: 403 }), 'Error', null],
  ['profile', () => new BrokerError('SyntheticPrivateKind', sensitiveFailureText, { http_status: 403 }), 'BrokerException', 403],
  ['account', () => null, 'Error', null],
]) test(`connection ${stage} failure records safe ${kind} diagnostics without credentials`, async t => {
  const broker = new RecoveryBroker(), store = new MemoryStore(), error = makeError(), original = broker.call.bind(broker);
  if (stage === 'account') broker.account = async () => { throw error; };
  else if (stage === 'stream') broker.stream = async () => { throw error; };
  else broker.call = async (method, ...args) => { if (method === (stage === 'profile' ? 'profile' : 'instruments')) throw error; return original(method, ...args); };
  const engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker })); t.after(() => engine.shutdown());
  await assert.rejects(engine.connect('synthetic-session', 'AB1234'), rejected => { assert.equal(rejected.message.includes(diagnosticSecret), false); return rejected.message.includes(kind); });
  const event = store.log.find(row => row.kind === 'connection_error');
  assert.deepEqual(event.data, { operation: 'connect', stage, kind, http_status }); assert.equal(event.level, 'error');
  assert.equal(engine.running, false); assert.equal(engine.connected, false); assert.equal(engine.recovery.phase, 'blocked'); assertPrivateFailure(engine, store);
});

for (const [kind, http_status] of [['TokenException', 403], ['PermissionException', 403], ['NetworkException', 502]]) test(`monitor retains ${kind} and HTTP status while preserving halt behavior`, async t => {
  const [engine, store] = ready(t), controller = new AbortController(), originalHalt = engine._halt.bind(engine);
  engine._refresh_account_locked = async () => { throw new BrokerError(kind, sensitiveFailureText, { http_status }); };
  engine._halt = (...args) => { originalHalt(...args); controller.abort(); };
  await assert.rejects(engine._monitor(controller.signal), { name: 'AbortError' });
  const event = store.log.find(row => row.kind === (kind === 'TokenException' ? 'auth_expired' : 'account_error'));
  assert.deepEqual(event.data, { operation: 'account_monitor', stage: 'account', kind, http_status });
  assert.equal(engine.running, false); assert.equal(engine.connected, kind !== 'TokenException'); assert.equal(engine.status, 'error'); assertPrivateFailure(engine, store);
});

test('monitor identifies stream renewal failures separately from account reads', async t => {
  const [engine, store] = ready(t), broker = new RecoveryBroker(), controller = new AbortController(), originalHalt = engine._halt.bind(engine);
  engine.broker = broker; engine._refresh_account_locked = async () => {};
  broker.stream = async () => { throw new BrokerError('NetworkException', sensitiveFailureText, { http_status: 503 }); };
  engine._halt = (...args) => { originalHalt(...args); controller.abort(); };
  await assert.rejects(engine._monitor(controller.signal), { name: 'AbortError' });
  assert.deepEqual(store.log.find(row => row.kind === 'account_error').data, { operation: 'account_monitor', stage: 'stream', kind: 'NetworkException', http_status: 503 });
  assert.equal(engine.running, false); assertPrivateFailure(engine, store);
});

for (const [makeError, kind, http_status] of [
  [() => new BrokerError('NetworkException', sensitiveFailureText, { http_status: 502 }), 'NetworkException', 502],
  [() => Object.assign(new Error(sensitiveFailureText), { name: sensitiveFailureText, http_status: 999 }), 'Error', null],
  [() => Object.assign(new BrokerError('TokenException', sensitiveFailureText), { http_status: '403 private-key' }), 'TokenException', null],
  [() => undefined, 'Error', null],
]) test(`trading loop safely classifies ${kind} failures with status ${http_status}`, async t => {
  const [engine, store] = ready(t), controller = new AbortController(), originalHalt = engine._halt.bind(engine);
  engine._run_once = async () => { throw makeError(); };
  engine._halt = (...args) => { originalHalt(...args); controller.abort(); };
  await assert.rejects(engine._run(controller.signal), { name: 'AbortError' });
  assert.deepEqual(store.log.find(row => row.kind === 'engine_error').data, { operation: 'trading_loop', stage: 'execution', kind, http_status });
  assert.equal(engine.running, false); assertPrivateFailure(engine, store);
});

test('definitive broker rejection journals useful metadata without raw broker detail', async t => {
  const [engine, store] = ready(t, 'live');
  engine.broker = { buy_cover: async () => { throw new BrokerError('InputException', sensitiveFailureText, { http_status: 400, definitive_rejection: true }); } };
  assert.equal(await engine._enter_locked(1, signal()), 'cover_order_rejected');
  const event = store.log.find(row => row.kind === 'order_rejected');
  assert.equal(event.data.kind, 'InputException'); assert.equal(event.data.http_status, 400); assert.equal(event.data.operation, 'cover_entry');
  assert.equal(event.data.stage, 'submission'); assert.equal(Object.hasOwn(event.data, 'detail'), false); assertPrivateFailure(engine, store);
});

test('permission rejection explains HTTP 403 in the halt, activity and saved intent without exposing raw detail',async t=>{
  const [engine,store]=ready(t,'live');let attempts=0;
  engine.broker={buy_cover:async()=>{attempts++;throw new BrokerError('PermissionException',`IP is not whitelisted ${sensitiveFailureText}`,{http_status:403,definitive_rejection:true});}};
  assert.equal(await engine._enter_locked(1,signal()),'cover_order_rejected');
  assert.equal(engine.running,false);assert.equal(engine.connected,true);
  assert.match(engine.message,/PermissionException, HTTP 403/);assert.match(engine.message,/IP Whitelist/);
  assert.equal(Object.values(engine.intents)[0].rejection.code,'ip_not_allowed');
  assert.match(store.log.find(e=>e.kind==='order_rejected').message,/HTTP 403/);assertPrivateFailure(engine,store);
  assert.equal(await engine._enter_locked(1,signal()),'entries_paused');assert.equal(attempts,1);
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
function completedDailyRows(count=55,age=1){
  return Array.from({length:count},(_,i)=>({date:new Date(NOW-(count-1-i+age)*86400000),open:100,high:101,low:99,close:100,volume:1000}));
}
function requireHistoryForHolding(engine){engine.account.holdings=[{exchange:'NSE',instrument_token:1,tradingsymbol:'TEST',quantity:1}];}

test('empty daily history is not cached or marked complete and later recovers in the same engine',async t=>{
  const [engine,store]=ready(t);requireHistoryForHolding(engine);let calls=0;
  engine.broker={call:async()=>++calls===1?[]:completedDailyRows()};
  await engine._history_pass();assert.equal(calls,1);assert.equal(engine.daily[1],undefined);assert.equal(engine._history_date,'');assert.equal(engine._history_failures,1);
  assert.equal(store.get('daily:1'),null);assert.equal(engine._daily_history_retry[1].attempts,1);
  await engine._history_pass();assert.equal(calls,1,'Immediate retry respects the per-symbol delay');assert.equal(engine._history_date,'');
  engine._daily_history_retry[1].next_at=0;await engine._history_pass();
  assert.equal(calls,2);assert.equal(engine.daily[1].length,55);assert.equal(engine._history_failures,0);assert.equal(engine._daily_history_retry[1],undefined);
  assert.equal(engine._history_date,'2026-09-17:holdings:1');assert.equal(store.get('daily:1').rows.length,55);
});

test('restart after an empty response can fetch recovered daily history without retaining a poisoned cache',async t=>{
  const [engine,store]=ready(t);requireHistoryForHolding(engine);let calls=0;
  const broker={call:async()=>++calls===1?[]:completedDailyRows()};engine.broker=broker;await engine._history_pass();
  const restored=new TradingEngine(engine.settings,store,options());restored.connected=true;restored.broker=broker;restored.universe=clone(engine.universe);restored.account=clone(engine.account);
  await restored._history_pass();assert.equal(calls,2);assert.equal(restored.daily[1].length,55);assert.equal(restored._history_failures,0);assert.notEqual(restored._history_date,'');
});

for(const [label,invalid] of [
  ['empty',()=>[]],['insufficient',()=>completedDailyRows(20)],['stale',()=>completedDailyRows(55,8)],
  ['nonfinite price',()=>{const rows=completedDailyRows();rows[10].close=null;return rows;}],
  ['duplicate date',()=>{const rows=completedDailyRows();rows[10].date=rows[9].date;return rows;}],
  ['daily gap',()=>{const rows=completedDailyRows();for(let i=0;i<20;i++)rows[i].date=new Date(rows[i].date-8*86400000);return rows;}],
  ['price discontinuity',()=>{const rows=completedDailyRows();Object.assign(rows[10],{open:50,low:49});return rows;}],
])test(`legacy same-day ${label} daily cache is bypassed and replaced only with validated history`,async t=>{
  const [engine,store]=ready(t);requireHistoryForHolding(engine);store.set('daily:1',{date:dateIST(NOW),symbol:'TEST',rows:invalid()});let calls=0;
  engine.broker={call:async()=>{calls++;return completedDailyRows();}};await engine._history_pass();
  assert.equal(calls,1);assert.equal(engine.daily[1].length,55);assert.equal(engine.daily[1][10].open,100);assert.equal(engine._history_failures,0);
  assert.equal(store.get('daily:1').rows.length,55);assert.notEqual(engine._history_date,'');
});

test('daily retry backoff is bounded and failed managed history never starves other symbols',async t=>{
  const [engine,store]=ready(t);requireHistoryForHolding(engine);
  store.set('strategy_settings',{intraday_enabled:true,swing_enabled:true,intraday_allocation_pct:.5,swing_allocation_pct:.5});
  engine.universe[2]={tradingsymbol:'SECOND',tick_size:.05};engine.quotes[2]={last_price:100,volume_traded:1e9};
  const calls=[];let recover=false;
  engine.broker={call:async(method,token)=>{calls.push(token);return token===1&&!recover?[]:completedDailyRows();}};
  for(const delay of [60,120,240,300,300]){
    if(engine._daily_history_retry[1])engine._daily_history_retry[1].next_at=0;
    const began=monotonic();await engine._history_pass();const next=engine._daily_history_retry[1].next_at;
    assert(next>=began+delay&&next<=monotonic()+delay);
    assert.equal(engine._history_date,'');assert.equal(engine._history_failures,1);assert.equal(engine.daily[2].length,55);
    const previousCount=calls.length;await engine._history_pass();assert.equal(calls.length,previousCount);
  }
  assert.deepEqual(calls.slice(0,2),[1,2],'The holding is tried first despite the other symbol higher turnover');
  assert.equal(calls.filter(token=>token===2).length,1,'Valid history is reused while another symbol backs off');
  recover=true;engine._daily_history_retry[1].next_at=0;await engine._history_pass();
  assert.equal(engine._history_date,'2026-09-17:all');assert.equal(engine._history_failures,0);assert.equal(engine._daily_history_retry[1],undefined);
});

test('daily broker read errors back off per symbol and do not mark coverage complete',async t=>{
  const [engine]=ready(t);requireHistoryForHolding(engine);let calls=0;
  engine.broker={call:async()=>{calls++;throw new BrokerError('NetworkException','temporary history outage');}};
  await engine._history_pass();await engine._history_pass();assert.equal(calls,1);assert.equal(engine._history_failures,1);assert.equal(engine._history_date,'');assert.equal(engine._daily_history_retry[1].attempts,1);
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
test('same-day pay-ins count once and stay capped by current unleveraged free cash', t => {
  const [engine] = ready(t, 'live');
  const base = {cash:17787.1, opening_balance:17787.1, intraday_payin:50000, live_balance:64148.34406, collateral:0, adhoc_margin:0};
  for (const [changes, expected] of [
    [{}, 64148.34406],
    [{live_balance:67787.1}, 67787.1],
    [{cash:67787.1, live_balance:117787.1}, 67787.1], // Cash already includes the deposit.
    [{live_balance:95000, collateral:30000, adhoc_margin:5000}, 60000],
    [{live_balance:2500}, 2500], // Used margin/withdrawals still reduce availability.
    [{cash:67787.1, opening_balance:67787.1, intraday_payin:0, live_balance:64000}, 64000],
    [{opening_balance:'17787.1', intraday_payin:'50000'}, 64148.34406],
    [{opening_balance:undefined}, 17787.1], // No unverified addition to possibly funded cash.
    [{opening_balance:-10000, cash:-10000, intraday_payin:50000, live_balance:40000}, 40000],
  ]) {
    engine.account.margins.equity.available = {...base, ...changes};
    assert.equal(engine._cash_balance(), expected, JSON.stringify(changes));
  }
  engine.account.margins.equity = {net:64148.34406, available:{...base, live_balance:undefined}};
  assert.equal(engine._cash_balance(), 64148.34406);
});

test('malformed deposit data never enlarges available cash or overwrites capital', t => {
  const [engine] = ready(t, 'live'), capital = engine.capital;
  for (const changes of [{intraday_payin:-1}, {intraday_payin:NaN}, {intraday_payin:''}, {intraday_payin:null},
    {opening_balance:Infinity}, {opening_balance:true}, {opening_balance:''}, {opening_balance:null},
    {opening_balance:Number.MAX_VALUE, intraday_payin:Number.MAX_VALUE}]) {
    engine.account.margins.equity.available = {cash:17787.1, opening_balance:17787.1, intraday_payin:50000, live_balance:64148.34406, ...changes};
    engine._update_capital(true);
    assert.equal(engine._cash_balance(), null); assert.equal(engine.snapshot().broker_available_cash, 0);
    assert.equal(engine.capital, capital);
  }
});

test('account refresh shows a deposit with unchanged raw cash and funds a flat live budget without resetting P&L', async t => {
  const broker = new RecoveryBroker(), engine = new TradingEngine(settings(temp(t), 'live'), new MemoryStore(), options({brokerFactory:()=>broker}));
  t.after(()=>engine.shutdown());
  broker.current.margins.equity.available = {cash:17787.1, opening_balance:17787.1, intraday_payin:0, live_balance:17787.1};
  await engine.connect('session', 'AB1234'); await engine.start();
  engine.realised = -100;
  broker.current.margins.equity.available = {cash:17787.1, opening_balance:17787.1, intraday_payin:50000, live_balance:67687.1};
  await engine._refresh_account_locked();
  assert.equal(engine.snapshot().broker_available_cash, 67687.1);
  assert.equal(engine.capital, 67787.1); assert.equal(engine.snapshot().equity, 67687.1);
  assert.equal(engine.realised, -100); assert.equal(engine._daily_pnl(), -100); assert.equal(engine.running, true);
  engine.running = false;
  broker.current.margins.equity.available.intraday_payin = 60000;
  broker.current.margins.equity.available.live_balance = 77687.1;
  await engine._refresh_account_locked();
  assert.equal(engine.snapshot().broker_available_cash, 77687.1);
  assert.equal(engine.running, false); assert.equal(engine.capital, 67787.1);
});

test('capital starts unknown and seeds paper only once from verified cash, excluding collateral', async t => {
  const store = new MemoryStore(), broker = new RecoveryBroker(), engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker }));
  assert.equal(engine.capital, 0); assert.equal(engine.snapshot().feed_fresh, false); assert.equal(engine.snapshot().account_fresh, false);
  broker.current.margins.equity.available = { cash: 70000, live_balance: 80000, collateral: 30000, adhoc_margin: 5000 };
  await engine.connect('session', 'AB1234'); assert.equal(engine.capital, 45000); assert.equal(engine.strategy_settings().intraday_capital, 45000); engine.realised = -1000; engine._persist();
  broker.current.margins.equity.available = { cash: 999000, live_balance: 999000 }; await engine._refresh_account_locked({ rebase_capital: true }); assert.equal(engine.capital, 45000);
  const restored = new TradingEngine(engine.settings, store, options({ brokerFactory: () => broker })); await restored.connect('restart', 'AB1234'); assert.equal(restored.capital, 45000); assert.equal(restored.snapshot().equity, 44000); await restored.shutdown(); await engine.shutdown();
});
for (const mode of ['paper', 'live']) test(`${mode} Start waits for verified funding and admits a later deposit only through existing entry gates`, async t => {
  const broker = new RecoveryBroker(); broker.current.margins.equity.available = { cash: 0, live_balance: 0 };
  const engine = new TradingEngine(settings(temp(t), mode), new MemoryStore(), options({ brokerFactory: () => broker }));
  t.after(() => engine.shutdown()); await engine.connect('session', 'AB1234'); await engine.start();
  assert.equal(engine.running, true); assert.equal(engine.snapshot().waiting_for_funds, true); assert.match(engine.message, /waiting for verified trading cash/);
  assert.equal(engine.readiness().checks.find(c => c.key === 'trading_cash').ok, false);
  for (const available of [{ cash: NaN, live_balance: 15000 }, { cash: 12000, live_balance: Infinity }, {}, { cash: 12000, live_balance: 15000, collateral: 20000 }]) {
    broker.current.margins.equity.available = available; await engine._refresh_account_locked();
    assert.equal(engine.capital, 0); assert.equal(engine.snapshot().waiting_for_funds, true);
    assert.equal(await engine._enter_locked(22, signal()), 'invalid_capital_allocation');
  }
  const generation = engine._analysis_generation;
  broker.current.margins.equity.available = { cash: 12000, live_balance: 15000, collateral: 5000 };
  await engine._refresh_account_locked();
  assert.equal(engine.running, true); assert.equal(engine.capital, 10000); assert.equal(engine.snapshot().waiting_for_funds, false);
  assert.match(engine.message, /Strategies armed\. Entries wait/); assert.ok(engine._analysis_generation > generation);
  assert.equal(await engine._enter_locked(22, signal()), 'quote_stale');
  engine._on_ticks([{ instrument_token: 22, exchange_timestamp: NOW, last_price: 100, volume_traded: 100000, depth: { buy: [{ price: 99.95, quantity: 10000 }], sell: [{ price: 100.05, quantity: 10000 }] } }]);
  engine._account_at = monotonic() - 46; assert.equal(await engine._enter_locked(22, signal()), 'account_data_stale');
  engine._account_at = monotonic(); engine.realised = -101; assert.equal(await engine._enter_locked(22, signal()), 'daily_loss_limit');
  engine.realised = 0;
  let submits = 0; broker.buy_cover = async () => { submits++; return 'funded-order'; };
  assert.equal(await engine._enter_locked(22, signal()), mode === 'paper' ? 'paper_buy_filled' : 'cover_order_pending');
  assert.equal(submits, mode === 'paper' ? 0 : 1);
});

for (const mode of ['paper', 'live']) for (const stop of ['pause', 'risk halt', 'restart', 'day rollover']) test(`${mode} later verified funds cannot rearm after ${stop}`, async t => {
  const broker = new RecoveryBroker(), store = new MemoryStore(); broker.current.margins.equity.available = { cash: 0, live_balance: 0 };
  let engine = new TradingEngine(settings(temp(t), mode), store, options({ brokerFactory: () => broker }));
  t.after(() => engine.shutdown()); await engine.connect('session', 'AB1234'); await engine.start();
  if (stop === 'pause') await engine.pause();
  else if (stop === 'risk halt') engine._halt('Synthetic risk halt; Start is required again.');
  else if (stop === 'day rollover') { engine._now = () => new Date(+NOW + 86400000); engine._roll_day(); }
  else { await engine.shutdown(); engine = new TradingEngine(engine.settings, store, options({ brokerFactory: () => broker })); await engine.connect('restart', 'AB1234'); }
  const message = engine.message, status = engine.status;
  broker.current.margins.equity.available = { cash: 20000, live_balance: 20000 }; await engine._refresh_account_locked();
  assert.equal(engine.capital, 20000); assert.equal(engine.running, false); assert.equal(engine.snapshot().waiting_for_funds, false);
  assert.equal(engine.message, message); assert.equal(engine.status, status); assert.equal(await engine._enter_locked(22, signal()), 'entries_paused');
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

test('running live account reconciles flat deposits and withdrawals without treating realised results as funding', async t => {
  const broker = new RecoveryBroker(), store = new MemoryStore(), engine = new TradingEngine(settings(temp(t), 'live'), store, options({ brokerFactory: () => broker }));
  t.after(() => engine.shutdown()); await engine.connect('session', 'AB1234'); await engine.start();
  engine.realised = -500; engine._update_loss_control();
  const baseline = engine.day_baseline, accounted = engine._capital_accounted_pnl, losses = clone(engine._loss_control);
  broker.current.margins.equity.available = { cash: 109500, live_balance: 109500 }; await engine._refresh_account_locked();
  assert.equal(engine.capital, 110000); assert.equal(engine.strategy_settings().intraday_capital, 110000); assert.equal(engine.snapshot().equity, 109500);
  assert.equal(engine._capital_accounted_pnl, accounted); assert.equal(engine.day_baseline, baseline); assert.equal(engine._daily_pnl(), -500); assert.deepEqual(engine._loss_control, losses);
  await engine._refresh_account_locked(); assert.equal(engine.capital, 110000);
  broker.current.margins.equity.available = { cash: 99500, live_balance: 99500 }; await engine._refresh_account_locked();
  assert.equal(engine.capital, 100000); assert.equal(engine.snapshot().equity, 99500); assert.equal(engine._daily_pnl(), -500);
  engine.realised = 500; broker.current.margins.equity.available = { cash: 100500, live_balance: 100500 }; await engine._refresh_account_locked();
  assert.equal(engine.capital, 100000); assert.equal(engine.snapshot().equity, 100500); assert.equal(engine._capital_accounted_pnl, accounted);
});

for (const cash of [0, 100, 500, 600]) test(`flat live profit withdrawal leaving ${cash} cash reconciles once without changing realised risk history`, async t => {
  const broker = new RecoveryBroker(), store = new MemoryStore(); broker.current.margins.equity.available = { cash: 100000, live_balance: 100000 };
  const engine = new TradingEngine(settings(temp(t), 'live'), store, options({ brokerFactory: () => broker }));
  t.after(() => engine.shutdown()); await engine.connect('session', 'AB1234'); await engine.start();
  engine.realised = 500; engine.day_baseline = 100; engine.day_open_unrealised = 25;
  engine._loss_control = { day: engine.day, last_realised: 500, loss_events: 2, until: isoIST(new Date(+NOW + 60000)) };
  const losses = clone(engine._loss_control), accounted = cash <= 500 ? 500 : 0, budget = cash <= 500 ? cash : cash - 500;
  for (let repeat = 0; repeat < 2; repeat++) {
    broker.current.margins.equity.available = { cash, live_balance: cash }; await engine._refresh_account_locked();
    assert.equal(engine.snapshot().equity, cash); assert.equal(engine.capital, budget); assert.equal(engine._capital_accounted_pnl, accounted);
    assert.equal(engine.snapshot().waiting_for_funds, cash === 0); assert.equal(engine.realised, 500); assert.equal(engine._daily_pnl(), 375);
    assert.equal(engine.day_baseline, 100); assert.equal(engine.day_open_unrealised, 25); assert.deepEqual(engine._loss_control, losses);
    assert.equal(store.get(engine.state_key).capital_accounted_pnl, accounted);
  }
  broker.current.margins.equity.available = { cash: cash + 10000, live_balance: cash + 10000 };
  await engine._refresh_account_locked(); await engine._refresh_account_locked();
  assert.equal(engine.snapshot().equity, cash + 10000); assert.equal(engine.capital, budget + 10000); assert.equal(engine._capital_accounted_pnl, accounted);
  assert.equal(engine.running, true); assert.equal(engine.realised, 500); assert.equal(engine._daily_pnl(), 375); assert.deepEqual(engine._loss_control, losses);
});

test('profit withdrawal boundary cannot hide a daily loss or allow a later deposit to evade the reduced risk limit', async t => {
  const broker = new RecoveryBroker(), engine = new TradingEngine(settings(temp(t), 'live'), new MemoryStore(), options({ brokerFactory: () => broker }));
  t.after(() => engine.shutdown()); await engine.connect('session', 'AB1234'); await engine.start();
  engine.realised = 500; engine.day_baseline = 600;
  broker.current.margins.equity.available = { cash: 100, live_balance: 100 }; await engine._refresh_account_locked();
  assert.equal(engine.capital, 100); assert.equal(engine._daily_pnl(), -100); assert.equal(await engine._enter_locked(22, signal()), 'daily_loss_limit');
  broker.current.margins.equity.available = { cash: 100100, live_balance: 100100 }; await engine._refresh_account_locked();
  assert.equal(engine.running, false); assert.match(engine.error, /Daily loss limit/); assert.equal(engine.capital, 100);
  assert.equal(engine.realised, 500); assert.equal(engine.day_baseline, 600); assert.equal(engine._daily_pnl(), -100);
});

test('malformed live balances cannot replenish or erase funded risk capital', async t => {
  const broker = new RecoveryBroker(), engine = new TradingEngine(settings(temp(t), 'live'), new MemoryStore(), options({ brokerFactory: () => broker }));
  t.after(() => engine.shutdown()); await engine.connect('session', 'AB1234'); await engine.start(); engine.realised = -500;
  for (const available of [{ cash: NaN, live_balance: 200000 }, { cash: 200000, live_balance: Infinity }, {}, { cash: '', live_balance: 200000 }, { cash: 200000, live_balance: 200000, collateral: -10000 }]) {
    broker.current.margins.equity.available = available; await engine._refresh_account_locked();
    assert.equal(engine.capital, 90000); assert.equal(engine._available_cash(), 0); assert.equal(engine._capital_accounted_pnl, 0);
    assert.equal(engine.snapshot().waiting_for_funds, true); assert.equal(engine._daily_pnl(), -500);
  }
  broker.current.margins.equity.available = { cash: 99500, live_balance: 99500 }; await engine._refresh_account_locked();
  assert.equal(engine.capital, 100000); assert.equal(engine.snapshot().equity, 99500); assert.equal(engine._daily_pnl(), -500);
});

test('verified deposits cannot enlarge an already-breached daily loss limit or rearm the resulting halt', async t => {
  const broker = new RecoveryBroker(), engine = new TradingEngine(settings(temp(t), 'live'), new MemoryStore(), options({ brokerFactory: () => broker }));
  t.after(() => engine.shutdown()); await engine.connect('session', 'AB1234'); await engine.start();
  engine.realised = -901; broker.current.margins.equity.available = { cash: 200000, live_balance: 200000 };
  await engine._refresh_account_locked();
  assert.equal(engine.running, false); assert.equal(engine.status, 'error'); assert.match(engine.error, /Daily loss limit/);
  assert.equal(engine.capital, 90000); assert.equal(engine._daily_pnl(), -901); assert.equal(engine._capital_accounted_pnl, 0);
  await engine._refresh_account_locked(); assert.equal(engine.running, false); assert.equal(engine.capital, 90000);
  assert.equal(await engine._enter_locked(22, signal()), 'entries_paused');
});
test('strategy percentages derive actual money and legacy amounts migrate to proportions', t => {
  const [engine, store] = ready(t); store.set('strategy_settings', { intraday_enabled: true, swing_enabled: true, intraday_allocation_pct: .6, swing_allocation_pct: .3 });
  assert.equal(engine.strategy_settings().intraday_capital, 60000); assert.equal(engine.strategy_settings().swing_capital, 30000); engine.capital = 200000; assert.equal(engine.strategy_settings().swing_capital, 60000);
  store.set('strategy_settings', { intraday_enabled: true, swing_enabled: true, intraday_capital: 20000, swing_capital: 30000 }); assert.equal(engine.strategy_settings().intraday_allocation_pct, .4); assert.equal(store.get('strategy_settings').intraday_capital, undefined);
});
test('engine passes derived swing allocation into real delivery lifecycle through confirmed fill and GTT', async t => {
  const [engine, store] = ready(t, 'live'); store.set('strategy_settings', { intraday_enabled: false, swing_enabled: true, intraday_allocation_pct: 0, swing_allocation_pct: 1 });
  engine.daily[1]=entryDailyBars();
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
  const engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker })); await engine.connect('session', 'AB1234'); await engine.start();
  assert.equal(engine.running, true); assert.equal(engine.snapshot().waiting_for_funds, true); assert.deepEqual(engine._authorized_holdings(), []); assert.deepEqual(engine._managed_recovery_symbols(), {});
  assert.equal(await engine._enter_locked(22, signal()), 'invalid_capital_allocation'); await engine.shutdown();
});
test('zero-cash legacy paper exposure resumes exit management without replenishing funds', async t => {
  const broker = new RecoveryBroker(), store = new MemoryStore(); broker.current.margins.equity.available = { cash: 0, live_balance: 0 };
  store.set('bot_state_paper', { day: dateIST(NOW), capital: 0, positions: { TEST: { symbol: 'TEST', token: 22, strategy: 'intraday', quantity: 4, entry: 100, last: 100, stop: 98, target: 104, opened_at: isoIST(NOW) } } });
  const engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker })); await engine.connect('session', 'AB1234'); await engine.start(); assert.equal(engine.running, true); assert.equal(engine.capital, 0);
  engine._on_ticks([{ instrument_token: 22, exchange_timestamp: NOW, last_price: 95, volume_traded: 1000, depth: { buy: [{ price: 94.95, quantity: 100 }], sell: [{ price: 95.05, quantity: 100 }] } }]); await engine._run_once(); assert.deepEqual(engine.positions, {}); assert.ok(engine.realised < 0); await engine.shutdown();
});
