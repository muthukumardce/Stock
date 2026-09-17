import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingEngine } from '../src/trading.js';
import { Store } from '../src/storage.js';
import { BrokerError, KiteBroker } from '../src/broker.js';
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
const entryDailyBars = () => Array.from({length:21},(_,i)=>new Candle(new Date(NOW-(21-i)*86400000),100,101,99,100,1000));

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
  store.set('intraday_seed:1',{date:dateIST(NOW),bars:invalid()});const ranges=[];
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
    store.set('intraday_seed:1',{date:dateIST(NOW),bars:memory?[{close:0}]:priorSessionRows()});
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

test('contradictory broker rejection retains ownership and cash until the accepted cover order is reconciled',async t=>{
  const [engine]=ready(t,'live');let calls=0;
  engine.broker=new KiteBroker('test-key','test-token',{sleep:async()=>{},fetch:async()=>{calls++;return new Response(JSON.stringify({status:'error',error_type:'InputException',message:'Contradictory acknowledgement',data:{order_id:'parent'}}),{status:500});}});
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
  const [engine,store]=ready(t);requireHistoryForHolding(engine);store.set('daily:1',{date:dateIST(NOW),rows:invalid()});let calls=0;
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
  const engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker })); await engine.connect('session', 'AB1234'); await assert.rejects(engine.start(), /no verified available cash/); assert.equal(engine.running, false); await engine.shutdown();
});
test('zero-cash legacy paper exposure resumes exit management without replenishing funds', async t => {
  const broker = new RecoveryBroker(), store = new MemoryStore(); broker.current.margins.equity.available = { cash: 0, live_balance: 0 };
  store.set('bot_state_paper', { day: dateIST(NOW), capital: 0, positions: { TEST: { symbol: 'TEST', token: 22, strategy: 'intraday', quantity: 4, entry: 100, last: 100, stop: 98, target: 104, opened_at: isoIST(NOW) } } });
  const engine = new TradingEngine(settings(temp(t)), store, options({ brokerFactory: () => broker })); await engine.connect('session', 'AB1234'); await engine.start(); assert.equal(engine.running, true); assert.equal(engine.capital, 0);
  engine._on_ticks([{ instrument_token: 22, exchange_timestamp: NOW, last_price: 95, volume_traded: 1000, depth: { buy: [{ price: 94.95, quantity: 100 }], sell: [{ price: 95.05, quantity: 100 }] } }]); await engine._run_once(); assert.deepEqual(engine.positions, {}); assert.ok(engine.realised < 0); await engine.shutdown();
});
