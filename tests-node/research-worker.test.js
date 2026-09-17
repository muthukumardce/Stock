import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {COMPARISON_RUNTIME_POLICY,ResearchService} from '../src/research.js';
import {MAX_COMPARISON_RUNTIME_MS,MAX_RESEARCH_RUNTIME_MS,MAX_RESEARCH_BARS,runBacktest} from '../src/backtest.js';

function dataset(interval='5minute'){
  const start=Date.parse('2026-09-14T09:15:00+05:30');
  return {interval,symbols:{TEST:Array.from({length:75},(_,index)=>({time:new Date(start+index*300000).toISOString(),open:100,high:101,low:99,close:100,volume:1000}))}};
}
function fixture(t,overrides={}){
  const workers=[],timers=[];let terminated=0;
  const service=new ResearchService({workerFactory:(url,options)=>{
    const worker=new EventEmitter();worker.url=url;worker.options=structuredClone(options);
    worker.terminate=async()=>{terminated++;worker.emit('exit',0);return 0;};workers.push(worker);return worker;
  },setTimer:(callback,delay)=>{const timer={callback,delay,cleared:false,unref(){}};timers.push(timer);return timer;},clearTimer:timer=>{if(timer)timer.cleared=true;},capacityDetector:()=>({available_cpus:32,source:'test'}),freeMemory:()=>16*2**30,cancelGraceMs:0,...overrides});
  t.after(()=>service.close());
  return {service,workers,timers,get terminated(){return terminated;}};
}

test('optimization worker receives bounded datasets and incumbent options without applying parameters',async t=>{
  const f=fixture(t),incumbent={min_signal_score:60},options={strategy_options:incumbent,tuning:{max_candidates:5,max_runtime_ms:120000,min_trades:10,max_drawdown_pct:5}};
  const job=f.service.startOptimization([dataset()],options),worker=f.workers[0];
  assert.equal(job.type,'optimization');assert.equal(job.status,'running');assert.equal(job.trial_count,5);assert.equal(job.runtime_budget_ms,120000);
  assert.equal(f.timers[0].delay,130000);assert.equal(worker.options.workerData.type,'optimization');assert.equal(worker.options.workerData.datasets.length,1);
  assert.deepEqual(worker.options.workerData.options,{...options,max_bars:1000000,parallelism:5,threads_per_process:4,analytics_worker_heap_mib:128,worker_heap_mib:512,
    memory_reserve_mib:job.capacity.memory_reserve_mib,startup_memory_mib:job.capacity.startup_memory_mib,max_initializing_processes:4});assert.equal(worker.options.resourceLimits.maxOldGenerationSizeMb,512);
  const result={status:'accepted',reason:'Validation improved.',parameters:{min_signal_score:65},trials:[]};
  worker.emit('message',{type:'complete',result});assert.equal(f.service.status().status,'running','Result must wait for worker retirement');
  assert.throws(()=>f.service.start(dataset()),/already running/);
  worker.emit('exit',0);const complete=await f.service.wait();
  assert.equal(complete.status,'complete');assert.deepEqual(complete.result,result);assert.deepEqual(incumbent,{min_signal_score:60});assert.equal(f.service.worker,null);
  complete.result.parameters.min_signal_score=90;assert.equal(f.service.status().result.parameters.min_signal_score,65);
});

test('training-only final-test restriction reaches the optimizer worker and rejects ambiguous permissions',t=>{
  const f=fixture(t);
  for(const value of [null,0,1,'false',{}])assert.throws(()=>f.service.startOptimization([dataset()],{final_test_allowed:value}),/must be boolean/);
  assert.equal(f.workers.length,0);
  f.service.startOptimization([dataset()],{final_test_allowed:false});assert.equal(f.workers[0].options.workerData.options.final_test_allowed,false);
});

test('comparison pass progress and explicit batch resets survive the service boundary',t=>{
  const f=fixture(t);f.service.start(dataset());const worker=f.workers[0];
  worker.emit('message',{type:'progress',phase:'baseline',progress:.5,phase_progress:1,parallelism:{batch_timestamp:'2026-09-14T04:00:00.000Z',batch_completed_symbols:1,batch_total_symbols:1}});
  assert.equal(f.service.status().phase_progress,1);
  worker.emit('message',{type:'progress',phase:'enhanced',progress:.5,phase_progress:0,processed_bars:0,parallelism:{batch_timestamp:null,batch_completed_symbols:0,batch_total_symbols:0}});
  const start=f.service.status();assert.equal(start.progress,.5);assert.equal(start.phase_progress,0);assert.equal(start.parallelism.batch_timestamp,null);assert.equal(start.parallelism.batch_total_symbols,0);
  worker.emit('message',{type:'progress',phase_progress:NaN});assert.equal(f.service.status().phase_progress,0);
  worker.emit('message',{type:'progress',phase_progress:.2,progress:.6,processed_bars:15,total_bars:75});
  assert.equal(f.service.status().phase_progress,.2);assert.equal(f.service.status().processed_bars,15);
});

test('optimization progress exposes trial details while rejecting unrelated job state overrides',t=>{
  const f=fixture(t),job=f.service.startOptimization([dataset()]);
  f.workers[0].emit('message',{type:'progress',phase:'validation',message:'Evaluating candidate 2.',progress:.35,trial:2,trial_count:9,id:'wrong',status:'complete',result:{parameters:{bad:true}}});
  const state=f.service.status();assert.equal(state.id,job.id);assert.equal(state.status,'running');assert.equal(state.result,null);
  assert.equal(state.phase,'validation');assert.equal(state.message,'Evaluating candidate 2.');assert.equal(state.progress,.35);assert.equal(state.trial,2);assert.equal(state.trial_count,9);
  f.workers[0].emit('message',{type:'progress',progress:5,trial_count:9999,trial:-1});
  assert.equal(f.service.status().progress,1);assert.equal(f.service.status().trial_count,9);assert.equal(f.service.status().trial,2);
});

test('candidate errors stay scoped to their trial while the research worker completes other results',async t=>{
  const f=fixture(t);f.service.startOptimization([dataset()],{parallelism:3});
  const diagnostic={code:'candidate_timeout',message:'Candidate exceeded its calculation time limit.',phase:'validation',interval:'5minute'};
  const trials=[{id:'candidate_1',parameter_set_id:'P2',status:'error',error:{...diagnostic,stack:'private_stack',private_token:'hidden'}},{id:'candidate_2',parameter_set_id:'P3',status:'trained',train:{'5minute':{metrics:{net_pnl:100,net_return_pct:1,trade_count:15},data_quality:{eligible:true}}}}];
  f.workers[0].emit('message',{type:'progress',trials,parallelism:{completed_tasks:2,failed_tasks:1,total_tasks:3,active_workers:1}});
  const running=f.service.status();assert.equal(running.status,'running');assert.equal(running.parallelism.failed_tasks,1);assert.equal(running.parallelism.active_workers,1);assert.deepEqual(running.trials[0].error,diagnostic);assert.equal(running.trials[1].train['5minute'].metrics.net_pnl,100);
  const result={status:'completed_with_errors',parameters:null,failed_trials:1,trials:running.trials};
  f.workers[0].emit('message',{type:'complete',result});f.workers[0].emit('exit',0);
  const completed=await f.service.wait();assert.equal(completed.status,'complete');assert.equal(completed.error,null);assert.equal(completed.result.failed_trials,1);assert.deepEqual(completed.result.trials[0].error,diagnostic);
});

test('optimization watchdog bounds the whole tuning run and never publishes a partial candidate',async t=>{
  const f=fixture(t);f.service.startOptimization([dataset()],{tuning:{max_runtime_ms:60000}});
  const waiting=f.service.wait();assert.equal(f.timers[0].delay,70000);
  f.timers[0].callback();const failed=await waiting;
  assert.equal(failed.status,'failed');assert.equal(failed.error_code,'worker_timeout');assert.equal(failed.result,null);assert.equal(f.terminated,1);assert.equal(f.service.worker,null);
  f.workers[0].emit('message',{type:'complete',result:{status:'accepted',parameters:{min_signal_score:70}}});
  assert.equal(f.service.status().result,null);assert.equal(f.service.status().status,'failed');
});

test('cancellation retires optimization before another run and ignores stale worker output',async t=>{
  const f=fixture(t);f.service.startOptimization([dataset()]);const first=f.workers[0];
  let release;first.terminate=()=>new Promise(resolve=>{release=()=>{first.emit('exit',0);resolve(0);};});
  let finished=false;const waiting=f.service.wait().then(value=>{finished=true;return value;}),cancel=f.service.cancel();await Promise.resolve();assert.equal(finished,false);
  assert.throws(()=>f.service.startOptimization([dataset()]),/already running/);assert.throws(()=>f.service.start(dataset()),/already running/);
  release();await cancel;assert.equal((await waiting).status,'cancelled');assert.equal(f.service.worker,null);
  const next=f.service.start(dataset());first.emit('message',{type:'complete',result:{parameters:{min_signal_score:70}}});
  assert.equal(f.service.status().id,next.id);assert.equal(f.service.status().result,null);assert.equal(f.service.status().type,'comparison');
});

test('optimization validates all tuning limits before creating a worker',t=>{
  const f=fixture(t);
  for(const tuning of [null,[],{unknown:1},{max_candidates:2},{max_candidates:101},{max_candidates:3.5},
    {max_runtime_ms:59999},{max_runtime_ms:1800001},{max_runtime_ms:Infinity},{max_runtime_ms:60000.5},
    {min_trades:0},{min_trades:10001},{min_trades:1.5},{max_drawdown_pct:0},{max_drawdown_pct:101},{max_drawdown_pct:NaN}]){
    assert.throws(()=>f.service.startOptimization([dataset()],{tuning}));
  }
  for(const datasets of [null,[],[dataset(),dataset(),dataset()],[{}],[{symbols:{TEST:'bad'}}],
    [{symbols:{TEST:Array(1000001)}}],[{symbols:{TEST:[]},sector_bars:Object.fromEntries(Array.from({length:101},(_,index)=>[index,[]]))}]]){
    assert.throws(()=>f.service.startOptimization(datasets));
  }
  assert.equal(f.workers.length,0);assert.equal(f.service.status().status,'idle');
});

test('two-interval optimization validates context bars and shares the bounded worker and watchdog',async t=>{
  const f=fixture(t),one={interval:'5minute',symbols:{TEST:Array(999999)},benchmark_bars:Array(1)},two={interval:'day',symbols:{TEST:Array(1000000)}};
  const job=f.service.startOptimization([one,two],{tuning:{max_candidates:100,max_runtime_ms:1800000}});
  assert.equal(job.total_bars,1999999);assert.equal(f.timers[0].delay,1810000);assert.equal(f.workers[0].options.workerData.datasets.length,2);
  assert.equal(job.capacity.worker_heap_mib,4096);assert.equal(f.workers[0].options.resourceLimits.maxOldGenerationSizeMb,4096);
  assert.equal(f.workers[0].options.workerData.options.worker_heap_mib,4096);
  await f.service.cancel();one.benchmark_bars.push({});assert.throws(()=>f.service.startOptimization([one,two]),/1000000 total/);
});

test('comparison worker compatibility retains its scaled per-variant budget and isolated completion',async t=>{
  const f=fixture(t);const job=f.service.start(dataset(),{max_runtime_ms:50000});
  assert.equal(job.type,'comparison');assert.equal(f.timers[0].delay,110000);assert.equal(f.workers[0].options.workerData.options.max_runtime_ms,50000);
  f.workers[0].emit('message',{type:'complete',result:{baseline:{},enhanced:{}}});f.workers[0].emit('exit',0);
  assert.equal((await f.service.wait()).status,'complete');
  f.service.startOptimization([dataset()]);assert.equal(f.workers.length,2);
});

test('comparison capacity uses bounded streaming workers while reserving CPUs for its coordinator and live work',async t=>{
  for(const entry of [
    {cpus:96,freeGiB:256,options:{},expected:76},
    {cpus:96,freeGiB:256,options:{live_workers:30},expected:61},
    {cpus:12,freeGiB:64,options:{reserve_cpus:5,live_workers:3},expected:3},
    {cpus:8,freeGiB:64,options:{},expected:3},
    {cpus:192,freeGiB:64,options:{},expected:100},
    {cpus:96,freeGiB:256,options:{parallelism:7},expected:7},
    {cpus:96,freeGiB:256,symbols:2,options:{parallelism:100},expected:2},
    {cpus:96,freeGiB:2,options:{},expected:4},
    {cpus:2,freeGiB:.125,options:{reserve_cpus:0,live_workers:2},expected:1},
  ]){
    const f=fixture(t,{capacityDetector:()=>({available_cpus:entry.cpus,source:'test'}),freeMemory:()=>entry.freeGiB*2**30});
    const symbols=Object.fromEntries(Array.from({length:entry.symbols??150},(_,index)=>['TEST'+index,dataset().symbols.TEST.slice(0,1)]));
    const job=f.service.start({interval:'5minute',symbols},entry.options),worker=f.workers[0];
    assert.equal(job.capacity.kind,'comparison');assert.equal(job.capacity.worker_limit,entry.expected);assert.equal(job.parallelism.worker_limit,entry.expected);
    assert.equal(job.capacity.cpu_target_percent,80);assert.equal(job.capacity.coordinator_cpus,1);assert.ok(job.capacity.reserved_cpus>=4);
    assert.equal(job.capacity.cpu_worker_limit,Math.max(1,Math.min(Math.floor(entry.cpus*.8),entry.cpus-Math.max(4,entry.options.reserve_cpus??4)-(entry.options.live_workers??0)-1)));
    assert.equal(job.capacity.worker_heap_mib,128);assert.equal(job.capacity.worker_memory_mib,192);assert.equal(job.capacity.coordinator_heap_mib,512);assert.equal(job.capacity.coordinator_memory_mib,768);
    assert.equal(worker.options.workerData.options.parallelism,entry.expected);assert.equal(worker.options.workerData.options.analytics_worker_heap_mib,128);
    assert.equal(worker.options.resourceLimits.maxOldGenerationSizeMb,512);assert.ok(worker.options.workerData.cancellation instanceof SharedArrayBuffer);
    assert.deepEqual(job.parallelism,{worker_limit:entry.expected,active_workers:0,batch_completed_symbols:0,batch_total_symbols:0,batch_timestamp:null});
    await f.service.cancel();
  }
});

test('comparison capacity scales coordinator memory separately and validates overrides before launching',async t=>{
  const f=fixture(t,{freeMemory:()=>8*2**30});
  const job=f.service.start({interval:'5minute',symbols:{TEST:Array(300000)}},{max_bars:1000000,analytics_worker_heap_mib:4096});
  assert.equal(job.capacity.coordinator_heap_mib,1024);assert.equal(job.capacity.coordinator_memory_mib,1280);assert.equal(job.capacity.worker_heap_mib,128);assert.equal(job.capacity.worker_memory_mib,192);
  assert.equal(f.workers[0].options.resourceLimits.maxOldGenerationSizeMb,1024);assert.equal(f.workers[0].options.workerData.options.analytics_worker_heap_mib,128);
  await f.service.cancel();
  for(const options of [{parallelism:-1},{parallelism:101},{parallelism:1.5},{parallelism:'2'},{reserve_cpus:-1},{reserve_cpus:65537},{live_workers:Infinity},{live_workers:.5}])assert.throws(()=>f.service.start(dataset(),options));
  assert.equal(f.workers.length,1);
});

test('comparison progress exposes bounded per-timestamp worker counts without parameter-set or arbitrary fields',async t=>{
  const f=fixture(t),input=dataset();input.symbols.SECOND=input.symbols.TEST;input.symbols.THIRD=input.symbols.TEST;
  const job=f.service.start(input,{parallelism:3}),worker=f.workers[0],at=Date.parse('2026-09-14T09:15:00+05:30');
  worker.emit('message',{type:'progress',phase:'enhanced',parallelism:{worker_limit:999,active_workers:2,batch_completed_symbols:1,batch_total_symbols:3,batch_timestamp:at,active_sets:[{parameter_set_id:'P1'}],completed_tasks:1,private_key:'hidden'},trials:[{id:'should_not_exist'}]});
  assert.deepEqual(f.service.status().parallelism,{worker_limit:3,active_workers:2,batch_completed_symbols:1,batch_total_symbols:3,batch_timestamp:at});
  assert.deepEqual(f.service.status().trials,[]);assert.doesNotMatch(JSON.stringify(f.service.status()),/hidden|should_not_exist|active_sets/);
  for(const patch of [{active_workers:4},{active_workers:-1},{batch_completed_symbols:4,batch_total_symbols:3},{batch_total_symbols:4},{batch_total_symbols:5001},{batch_completed_symbols:1.5},{batch_timestamp:'private-token'},{batch_timestamp:Infinity}])worker.emit('message',{type:'progress',parallelism:patch});
  assert.deepEqual(f.service.status().parallelism,{worker_limit:3,active_workers:2,batch_completed_symbols:1,batch_total_symbols:3,batch_timestamp:at});
  const next='2026-09-14T09:20:00+05:30';worker.emit('message',{type:'progress',parallelism:{active_workers:0,batch_completed_symbols:3,batch_total_symbols:3,batch_timestamp:next}});
  worker.emit('message',{type:'complete',result:{comparison:{}}});worker.emit('exit',0);const done=await f.service.wait();
  assert.equal(done.id,job.id);assert.equal(done.parallelism.active_workers,0);assert.equal(done.parallelism.batch_completed_symbols,3);assert.equal(done.parallelism.batch_timestamp,next);assert.equal(Object.hasOwn(done.parallelism,'active_sets'),false);
});

test('comparison cancellation signals every child and waits for coordinator retirement before another job can start',async t=>{
  const f=fixture(t,{cancelGraceMs:1000}),input=dataset();input.symbols.SECOND=input.symbols.TEST;
  f.service.start(input,{parallelism:2});const worker=f.workers[0],signal=new Int32Array(worker.options.workerData.cancellation);
  worker.emit('message',{type:'progress',parallelism:{active_workers:2,batch_completed_symbols:1,batch_total_symbols:2,batch_timestamp:1}});
  const waiting=f.service.wait(),stopping=f.service.cancel();assert.equal(Atomics.load(signal,0),1);assert.equal(f.terminated,0);
  assert.throws(()=>f.service.start(dataset()),/already running/);assert.throws(()=>f.service.startOptimization([dataset()]),/already running/);
  worker.emit('message',{type:'complete',result:{comparison:{partial:true}}});worker.emit('exit',0);
  const done=await stopping;assert.equal((await waiting).status,'cancelled');assert.equal(done.result,null);assert.equal(done.parallelism.active_workers,0);assert.equal(done.parallelism.batch_completed_symbols,1);assert.equal(Object.hasOwn(done.parallelism,'active_sets'),false);
  assert.equal(f.service.worker,null);assert.equal(f.terminated,0);
});

test('comparison budgets count symbol and context candles, scale to the supported large sample, and stay finite',async t=>{
  const f=fixture(t);
  assert.equal(COMPARISON_RUNTIME_POLICY,'bars-v3-multicore');assert.equal(MAX_COMPARISON_RUNTIME_MS,1800000);
  assert.equal(MAX_RESEARCH_RUNTIME_MS,600000,'Optimizer candidate cap stays independent');
  const cases=[
    {symbols:75,benchmark:0,sector:0,budget:60000},
    {symbols:20000,benchmark:2000,sector:3000,budget:150000},
    {symbols:250000,benchmark:2000,sector:3000,budget:1530000},
    {symbols:600000,benchmark:2000,sector:3000,budget:1800000},
    {symbols:990000,benchmark:5000,sector:5000,budget:1800000},
  ];
  for(const item of cases){
    const input={interval:'5minute',symbols:{TEST:Array(item.symbols)},benchmark_bars:Array(item.benchmark),sector_bars:{technology:Array(item.sector)}};
    const job=f.service.start(input,{max_bars:1000000}),worker=f.workers.at(-1);
    assert.equal(job.runtime_budget_ms,item.budget);assert.equal(job.total_bars,item.symbols);
    assert.equal(worker.options.workerData.options.max_runtime_ms,item.budget);assert.equal(f.timers.at(-1).delay,item.budget*2+10000);
    await f.service.cancel();
  }
  for(const budget of [100,600001,1800000]){
    assert.equal(f.service.start(dataset(),{max_runtime_ms:budget}).runtime_budget_ms,budget);await f.service.cancel();
  }
  for(const budget of [0,99,100.5,1800001,Infinity,'1800000'])assert.throws(()=>f.service.start(dataset(),{max_runtime_ms:budget}),/Maximum runtime/);
});

test('typed variant timeouts retain actual phase, configured limit and validated candle counts only',async t=>{
  const f=fixture(t);f.service.start(dataset(),{max_runtime_ms:123456});const worker=f.workers[0];
  worker.emit('message',{type:'progress',phase:'baseline',progress:.5,processed_bars:75,total_bars:75});
  worker.emit('message',{type:'failed',error:'Simulation stopped at its finite limit.',error_code:'worker_timeout',error_details:{phase:'enhanced',budget_ms:99999999,elapsed_ms:123457,processed_bars:21,total_bars:75,kind:'watchdog',stack:'hidden',token:'hidden'}});
  worker.emit('exit',0);const failed=await f.service.wait();
  assert.equal(failed.status,'failed');assert.equal(failed.result,null);assert.equal(failed.error_code,'worker_timeout');assert.equal(failed.phase,'enhanced');
  assert.deepEqual(failed.error_details,{phase:'enhanced',budget_ms:123456,elapsed_ms:123457,processed_bars:21,total_bars:75,kind:'variant'});
  assert.doesNotMatch(JSON.stringify(failed.error_details),/hidden|token|stack/);
});

test('a real worker transports typed simulation timeout details without waiting for a long historical run',{timeout:5000},async t=>{
  const service=new ResearchService({workerFactory:(url,options)=>new Worker(
    `let ticks=0;Object.defineProperty(performance,'now',{value:()=>ticks++*101});import(${JSON.stringify(url.href)});`,
    {...options,eval:true},
  )});t.after(()=>service.close());
  service.start(dataset(),{max_runtime_ms:100});const failed=await service.wait();
  assert.equal(failed.status,'failed');assert.equal(failed.phase,'baseline');assert.equal(failed.error_code,'worker_timeout');
  assert.deepEqual(failed.error_details,{phase:'baseline',budget_ms:100,elapsed_ms:101,processed_bars:0,total_bars:75,kind:'variant'});
  assert.equal(failed.result,null);assert.equal(service.worker,null);
});

test('timeout diagnostics reject inconsistent or unbounded metadata and preserve legacy worker recognition',async t=>{
  const f=fixture(t);
  for(const patch of [{processed_bars:76},{processed_bars:-1},{processed_bars:.5},{total_bars:2000001},{total_bars:'75'}]){
    f.service.start(dataset());const worker=f.workers.at(-1);
    worker.emit('message',{type:'progress',phase:'enhanced',processed_bars:25,total_bars:75});
    worker.emit('message',{type:'failed',error:'Backtest runtime limit exceeded; use a smaller dataset',error_details:{phase:'arbitrary',processed_bars:50,total_bars:75,...patch,elapsed_ms:Infinity}});
    worker.emit('exit',0);const failed=await f.service.wait();
    assert.equal(failed.error_code,'worker_timeout');assert.deepEqual(failed.error_details,{phase:'enhanced',budget_ms:60000,processed_bars:25,total_bars:75,kind:'variant'});
  }
  f.service.start(dataset());const worker=f.workers.at(-1);
  worker.emit('message',{type:'failed',error:'Malformed candle',error_code:'unexpected_code',error_details:{phase:'enhanced',budget_ms:1}});worker.emit('exit',0);
  const failed=await f.service.wait();assert.equal(failed.error_code,'worker');assert.equal(failed.error_details,null);
});

test('comparison watchdog retains the interrupted phase and counts after terminating and never exposes a partial result',async t=>{
  const f=fixture(t);f.service.start(dataset(),{max_runtime_ms:120000});const worker=f.workers[0];
  worker.emit('message',{type:'progress',phase:'enhanced',progress:.75,processed_bars:35,total_bars:75});
  const waiting=f.service.wait();f.timers[0].callback();const failed=await waiting;
  assert.equal(failed.status,'failed');assert.equal(failed.phase,'enhanced');assert.equal(failed.error_code,'worker_timeout');
  assert.equal(failed.result,null);assert.equal(f.service.worker,null);assert.equal(f.terminated,1);
  assert.deepEqual({...failed.error_details,elapsed_ms:0},{phase:'enhanced',budget_ms:250000,processed_bars:35,total_bars:75,kind:'watchdog',elapsed_ms:0});
  assert.ok(Number.isSafeInteger(failed.error_details.elapsed_ms));assert.ok(failed.error_details.elapsed_ms>=0);
  worker.emit('message',{type:'complete',result:{baseline:{},enhanced:{}}});assert.equal(f.service.status().result,null);
});

test('worker crashes cannot turn a received optimization candidate into an accepted result',async t=>{
  const f=fixture(t);f.service.startOptimization([dataset()]);
  f.workers[0].emit('message',{type:'complete',result:{status:'accepted',parameters:{min_signal_score:70}}});
  f.workers[0].emit('exit',1);const failed=await f.service.wait();
  assert.equal(failed.status,'failed');assert.equal(failed.result,null);assert.equal(failed.error_code,'worker');
});

test('real optimization worker returns research findings without modifying the supplied incumbent',async t=>{
  const service=new ResearchService();t.after(()=>service.close());
  const parameters={min_signal_score:60};service.startOptimization([dataset()],{strategy_options:parameters,tuning:{max_candidates:3,max_runtime_ms:60000,min_trades:10,max_drawdown_pct:5}});
  const result=await service.wait();assert.equal(result.status,'complete',result.error);
  assert.ok(['accepted','no_improvement','insufficient_data','budget_exhausted'].includes(result.result.status));
  assert.equal(result.result.parameters,null);assert.deepEqual(parameters,{min_signal_score:60});assert.equal(service.worker,null);
});

test('automatic tuning capacity uses physical cores at full CPU eligibility with runtime RAM admission',async t=>{
  for(const entry of [
    {cpus:192,freeGiB:64,options:{},expected:9},
    {cpus:12,physical:6,freeGiB:64,options:{reserve_cpus:5,live_workers:3},expected:6},
    {cpus:32,physical:16,freeGiB:2,options:{},expected:9},
    {cpus:2,physical:1,freeGiB:.5,options:{reserve_cpus:0,live_workers:2},expected:1},
    {cpus:192,freeGiB:64,options:{parallelism:3},expected:3},
    {cpus:192,physical:96,freeGiB:100,options:{tuning:{max_candidates:100}},expected:96},
    {cpus:96,physical:48,freeGiB:256,options:{parallelism:100,tuning:{max_candidates:100}},expected:48},
    {cpus:96,physical:48,freeGiB:256,options:{live_workers:30,tuning:{max_candidates:100}},expected:48},
  ]){
    const f=fixture(t,{capacityDetector:()=>({available_cpus:entry.cpus,physical_cpus:entry.physical,source:'test'}),freeMemory:()=>entry.freeGiB*2**30});
    const input=dataset();input.symbols=Object.fromEntries(Array.from({length:8},(_,i)=>['TEST'+i,input.symbols.TEST]));
    const job=f.service.startOptimization([input],entry.options);
    assert.equal(job.capacity.worker_limit,entry.expected);assert.equal(job.parallelism.worker_limit,entry.expected);
    assert.equal(job.capacity.usable_cpus,entry.cpus);assert.equal(job.capacity.reserved_cpus,0);
    assert.equal(job.capacity.cpu_target_percent,100);assert.equal(job.capacity.cpu_budget,entry.cpus);assert.equal(job.capacity.memory_policy,'pause_starts');
    assert.equal(job.capacity.analytics_thread_limit,entry.expected*job.capacity.threads_per_process);
    assert.equal(job.capacity.allocated_cpu_threads,entry.expected*(job.capacity.threads_per_process+1)+1);
    assert.equal(f.workers[0].options.workerData.options.parallelism,entry.expected);await f.service.cancel();
  }
  const f=fixture(t);for(const options of [{parallelism:-1},{parallelism:101},{parallelism:1.5},{reserve_cpus:-1},{live_workers:Infinity},{max_bars:1000001},{max_bars:0}])assert.throws(()=>f.service.startOptimization([dataset()],options));
  assert.equal(f.workers.length,0);
});

test('live tuning progress retains bounded parameter-set results and worker activity without arbitrary worker fields',t=>{
  const f=fixture(t);f.service.startOptimization([dataset()],{parallelism:3});
  const trial={id:'candidate_1',parameter_set_id:'P2',parameters:{min_adx:23,api_key:'hidden'},effective_parameters:{min_adx:23,min_signal_score:60,risk_per_trade_pct:1},status:'trained',reason:'Training passed.',train:{'5minute':{metrics:{net_pnl:123,trade_count:12,untrusted:'hidden'},data_quality:{eligible:true,reason:null},trades:Array(1000).fill({private:'hidden'})}}};
  f.workers[0].emit('message',{type:'progress',trial:100,trial_count:100,total_bars:2000000,trials:Array(110).fill(trial),parallelism:{worker_limit:999,active_workers:3,completed_tasks:100,total_tasks:100,active_sets:[{parameter_set_id:'P100',phase:'tuning_train',interval:'5minute',api_key:'hidden'},...Array(9).fill({parameter_set_id:'P2',phase:'tuning_train',interval:'5minute',api_key:'hidden'})]}});
  const state=f.service.status();assert.equal(state.trials.length,100);assert.equal(state.trials[0].parameter_set_id,'P2');assert.equal(state.trials[0].train['5minute'].metrics.net_pnl,123);
  assert.equal(state.trial,100);assert.equal(state.trial_count,100);assert.equal(state.total_bars,2000000);assert.equal(state.parallelism.active_sets[0].parameter_set_id,'P100');assert.equal(state.parallelism.completed_tasks,100);
  assert.deepEqual(state.trials[0].parameters,{min_adx:23});assert.equal(state.parallelism.worker_limit,3);assert.equal(state.parallelism.active_workers,3);assert.equal(state.parallelism.active_sets.length,3);
  assert.doesNotMatch(JSON.stringify(state),/hidden|untrusted/);
  f.workers[0].emit('message',{type:'progress',trial:101,trial_count:101,total_bars:2000001,parallelism:{active_sets:[{parameter_set_id:'P101'}]}});
  assert.equal(f.service.status().trial,100);assert.equal(f.service.status().trial_count,100);assert.equal(f.service.status().total_bars,2000000);assert.equal(f.service.status().parallelism.active_sets[0].parameter_set_id,null);
});

test('active parameter progress preserves real fractions and candle counts through the service boundary',t=>{
  const f=fixture(t);f.service.startOptimization([dataset()],{parallelism:3});
  const worker=f.workers[0],send=item=>worker.emit('message',{type:'progress',parallelism:{active_workers:1,active_sets:[item]}});
  const active={parameter_set_id:'P2',phase:'tuning_validation',interval:'day',progress:.75,processed_bars:25,total_bars:50,completed_intervals:1,total_intervals:2};
  send({...active,api_secret:'not-forwarded',stack:'not-forwarded'});
  assert.deepEqual(f.service.status().parallelism.active_sets,[active]);
  const finished={...active,progress:1,processed_bars:50,completed_intervals:2};send(finished);
  assert.deepEqual(f.service.status().parallelism.active_sets,[finished]);
  const assigned={...active,progress:0,processed_bars:0,total_bars:0,completed_intervals:0};send(assigned);
  assert.deepEqual(f.service.status().parallelism.active_sets,[assigned]);
});

test('invalid active progress and inconsistent candle or interval counts are omitted instead of reaching the dashboard',t=>{
  const f=fixture(t);f.service.startOptimization([dataset()],{parallelism:3});const worker=f.workers[0];
  const valid={parameter_set_id:'P2',phase:'tuning_train',interval:'5minute',progress:.5,processed_bars:25,total_bars:50,completed_intervals:0,total_intervals:1};
  const send=patch=>{worker.emit('message',{type:'progress',parallelism:{active_sets:[{...valid,...patch,private_field:'not-forwarded'}]}});return f.service.status().parallelism.active_sets[0];};
  for(const progress of [-.1,1.1,NaN,Infinity,'0.5'])assert.equal(Object.hasOwn(send({progress}),'progress'),false);
  for(const patch of [{processed_bars:-1},{processed_bars:25.5},{total_bars:1000001},{processed_bars:51},{total_bars:'50'}]){
    const value=send(patch);assert.equal(Object.hasOwn(value,'processed_bars'),false);assert.equal(Object.hasOwn(value,'total_bars'),false);
  }
  for(const patch of [{completed_intervals:2},{total_intervals:0},{total_intervals:3},{completed_intervals:.5}]){
    const value=send(patch);assert.equal(Object.hasOwn(value,'completed_intervals'),false);assert.equal(Object.hasOwn(value,'total_intervals'),false);
  }
  assert.equal(Object.hasOwn(send({progress:1}),'progress'),false,'Unfinished candles/scopes cannot claim completion');
  assert.equal(send({phase:'arbitrary_worker_method'}).phase,null);
  assert.doesNotMatch(JSON.stringify(send({})),/private_field|not-forwarded/);
});

test('candidate PID and nested thread progress remain bounded through the research service',t=>{
  const f=fixture(t),input=dataset();input.symbols={A:input.symbols.TEST,B:input.symbols.TEST,C:input.symbols.TEST,D:input.symbols.TEST};
  f.service.startOptimization([input],{parallelism:3});const worker=f.workers[0];
  const affinity={status:'automatic',verified:false};
  worker.emit('message',{type:'progress',parallelism:{process_limit:999,active_processes:2,thread_limit:999,active_threads:6,
    memory_waiting:true,memory_wait_reason:'initializing',available_memory_mib:100000,memory_reserve_mib:9984,startup_memory_mib:4224,initializing_processes:2,max_initializing:3,
    active_sets:[{parameter_set_id:'P1',phase:'tuning_train',process_id:400,thread_limit:4,active_threads:3,workers:[{process_id:400,worker_id:1,affinity}],api_secret:'drop'}],
    workers:[{process_id:400,worker_id:1,affinity},{process_id:500,worker_id:1,affinity}]}});
  const state=f.service.status();assert.equal(state.parallelism.process_limit,3);assert.equal(state.parallelism.thread_limit,12);
  assert.equal(state.parallelism.active_processes,2);assert.equal(state.parallelism.active_threads,6);assert.equal(state.parallelism.workers.length,2);
  assert.equal(state.parallelism.active_sets[0].process_id,400);assert.equal(state.parallelism.active_sets[0].active_threads,3);
  assert.equal(state.parallelism.active_sets[0].workers[0].process_id,400);assert.doesNotMatch(JSON.stringify(state),/api_secret|drop/);
  assert.equal(state.parallelism.memory_waiting,true);assert.equal(state.parallelism.memory_wait_reason,'initializing');assert.equal(state.parallelism.startup_memory_mib,4224);assert.equal(state.parallelism.initializing_processes,2);assert.equal(state.parallelism.max_initializing,3);
  worker.emit('message',{type:'progress',parallelism:{active_processes:4,active_threads:13,active_sets:[{parameter_set_id:'P1',process_id:-1,thread_limit:100,active_threads:100}]}});
  const next=f.service.status();assert.equal(next.parallelism.active_processes,2);assert.equal(next.parallelism.active_threads,6);
  assert.equal(next.parallelism.active_sets[0].process_id,undefined);assert.equal(next.parallelism.active_sets[0].thread_limit,undefined);assert.equal(next.parallelism.active_sets[0].active_threads,undefined);
  worker.emit('message',{type:'complete',result:{status:'no_improvement'}});worker.emit('exit',0);
  assert.equal(f.service.status().parallelism.active_processes,0);assert.equal(f.service.status().parallelism.active_threads,0);
  assert.equal(f.service.status().parallelism.memory_waiting,false);assert.equal(f.service.status().parallelism.memory_wait_reason,null);assert.equal(f.service.status().parallelism.initializing_processes,0);
});

test('150-stock research shares CPU and scaled memory between candidate processes and their analytics threads',async t=>{
  const f=fixture(t,{capacityDetector:()=>({available_cpus:96,source:'test'}),freeMemory:()=>256*2**30});
  const symbols=Object.fromEntries(Array.from({length:150},(_,index)=>['TEST'+index,Array(4000)]));
  const job=f.service.startOptimization([{interval:'5minute',symbols}],{tuning:{max_candidates:50},max_bars:1000000});
  assert.equal(job.total_bars,600000);assert.equal(job.trial_count,50);assert.equal(job.capacity.process_limit,50);
  assert.equal(job.capacity.cpu_worker_limit,96);assert.equal(job.capacity.worker_heap_mib,1536);assert.equal(job.capacity.worker_memory_mib,4224);
  assert.equal(job.capacity.threads_per_process,4);assert.equal(job.capacity.analytics_thread_limit,200);assert.equal(job.capacity.allocated_cpu_threads,251);
  assert.equal(f.workers[0].options.workerData.options.parallelism,50);assert.equal(f.workers[0].options.resourceLimits.maxOldGenerationSizeMb,1536);
  await f.service.cancel();
  assert.throws(()=>f.service.start({interval:'5minute',symbols}),/250000 total/,'Comparison defaults retain their existing dataset bound');
  const comparison=f.service.start({interval:'5minute',symbols},{max_bars:1000000});assert.equal(comparison.total_bars,600000);assert.equal(f.workers[1].options.resourceLimits.maxOldGenerationSizeMb,1536);
});

test('backtest supports an explicit one-million-bar bound without running a huge simulation',()=>{
  assert.equal(MAX_RESEARCH_BARS,1000000);
  assert.doesNotThrow(()=>runBacktest(dataset(),{max_bars:1000000}));
  assert.throws(()=>runBacktest(dataset(),{max_bars:1000001}),/Maximum bars/);
});

test('cooperative cancellation signals the coordinator and waits for nested retirement before unblocking',async t=>{
  const f=fixture(t,{cancelGraceMs:1000});f.service.startOptimization([dataset()],{parallelism:3});
  const worker=f.workers[0],signal=new Int32Array(worker.options.workerData.cancellation);
  worker.emit('message',{type:'progress',parallelism:{active_workers:3,active_sets:[{parameter_set_id:'P2',phase:'tuning_train',interval:'5minute'}]}});
  let finished=false;const waiting=f.service.wait().then(value=>{finished=true;return value;}),stopping=f.service.cancel();
  assert.equal(Atomics.load(signal,0),1);assert.equal(f.terminated,0);assert.equal(f.service.status().phase,'cancelling');
  await Promise.resolve();assert.equal(finished,false);assert.throws(()=>f.service.start(dataset()),/already running/);
  worker.emit('message',{type:'complete',result:{status:'accepted',parameters:{min_adx:23}}});
  worker.emit('exit',0);const stopped=await stopping;assert.equal((await waiting).status,'cancelled');assert.equal(stopped.result,null);
  assert.equal(stopped.parallelism.active_workers,0);assert.deepEqual(stopped.parallelism.active_sets,[]);assert.equal(f.terminated,0);
});

test('watchdog escalates an unresponsive coordinator after its cancellation grace and joins it',async t=>{
  const f=fixture(t,{cancelGraceMs:1000});f.service.startOptimization([dataset()],{parallelism:3,tuning:{max_runtime_ms:60000}});
  const waiting=f.service.wait();f.timers[0].callback();
  assert.equal(Atomics.load(new Int32Array(f.workers[0].options.workerData.cancellation),0),1);assert.equal(f.terminated,0);
  assert.equal(f.timers[1].delay,1000);f.timers[1].callback();
  const failed=await waiting;assert.equal(failed.status,'failed');assert.equal(failed.error_code,'worker_timeout');assert.equal(f.terminated,1);assert.equal(f.service.worker,null);
});

test('forced coordinator termination retires nested Node workers instead of leaving background CPU activity',{timeout:5000},async()=>{
  const shared=new SharedArrayBuffer(8),state=new Int32Array(shared);
  const nested=`const {parentPort,workerData}=require('node:worker_threads');const state=new Int32Array(workerData);setInterval(()=>{if(Atomics.load(state,1))process.exit(0);Atomics.add(state,0,1);},5);parentPort.postMessage('ready');`;
  const source=`const {Worker,parentPort,workerData}=require('node:worker_threads');const child=new Worker(${JSON.stringify(nested)},{eval:true,execArgv:[],workerData});child.on('message',message=>parentPort.postMessage(message));`;
  const coordinator=new Worker(source,{eval:true,execArgv:[],workerData:shared});
  try{
    await once(coordinator,'message',{signal:AbortSignal.timeout(3000)});
    await delay(25);assert.ok(Atomics.load(state,0)>0);
    await coordinator.terminate();const atExit=Atomics.load(state,0);await delay(75);
    assert.equal(Atomics.load(state,0),atExit,'Nested worker activity must stop before coordinator retirement resolves');
  }finally{Atomics.store(state,1,1);await coordinator.terminate();}
});

test('real parallel optimization cancellation joins the coordinator and all active trial workers',{timeout:10000},async t=>{
  const service=new ResearchService({capacityDetector:()=>({available_cpus:16,source:'test'}),freeMemory:()=>16*2**30});t.after(()=>service.close());
  const base=dataset().symbols.TEST,series=[];let day=0;
  while(series.length<75*30){const at=new Date(Date.parse(base[0].time)+day++*86400000);if([0,6].includes(at.getUTCDay()))continue;for(const row of base)series.push({...row,time:new Date(Date.parse(row.time)+(day-1)*86400000).toISOString()});}
  const symbols=Object.fromEntries(Array.from({length:4},(_,index)=>['TEST'+index,series]));
  service.startOptimization([{interval:'5minute',symbols}],{parallelism:3,strategy_options:{enhanced_signals:true},tuning:{max_candidates:9,max_runtime_ms:60000}});
  for(let attempt=0;attempt<300&&service.status().parallelism.active_workers<2&&service.status().status==='running';attempt++)await delay(10);
  assert.ok(service.status().parallelism.active_workers>=2,'Independent trial workers should be active concurrently');
  const stopped=await service.cancel();assert.equal(stopped.status,'cancelled');assert.equal(stopped.result,null);assert.equal(stopped.parallelism.active_workers,0);assert.equal(service.worker,null);
});

test('real comparison uses concurrent analytics workers and cancellation retires their shared-portfolio coordinator',{timeout:10000},async t=>{
  const service=new ResearchService({capacityDetector:()=>({available_cpus:8,source:'test'}),freeMemory:()=>16*2**30});t.after(()=>service.close());
  const base=dataset().symbols.TEST,rows=[...base,...base.slice(0,25).map(row=>({...row,time:new Date(Date.parse(row.time)+86400000).toISOString()}))];
  const symbols=Object.fromEntries(Array.from({length:150},(_,index)=>['TEST'+index,rows]));
  const start=service.start({interval:'5minute',symbols},{parallelism:0,max_runtime_ms:60000});assert.equal(start.capacity.worker_limit,3);assert.equal(start.capacity.kind,'comparison');
  for(let attempt=0;attempt<500&&service.status().parallelism.active_workers<2&&service.status().status==='running';attempt++)await delay(10);
  const active=service.status();assert.equal(active.status,'running',active.error);assert.ok(active.parallelism.active_workers>=2,'Comparison candle analytics should use multiple real worker threads');
  assert.ok(active.parallelism.batch_total_symbols>0&&active.parallelism.batch_total_symbols<=150);
  const stopped=await service.cancel();assert.equal(stopped.status,'cancelled');assert.equal(stopped.result,null);assert.equal(stopped.parallelism.active_workers,0);assert.equal(service.worker,null);
  assert.equal(Object.hasOwn(stopped.parallelism,'active_sets'),false);
});
