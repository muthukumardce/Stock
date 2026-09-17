import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setImmediate as turn} from 'node:timers/promises';
import {OptimizerPool} from '../src/optimizer-pool.js';
import {ComparisonAnalyticsPool} from '../src/comparison-analytics-pool.js';
import {ResearchService} from '../src/research.js';
import {affinityRecord,workerAffinityRecords} from '../src/research-affinity-state.js';
import {planResearchAffinity} from '../src/cpu-affinity.js';
import {optimizeStrategies,optimizeStrategiesParallel} from '../src/optimizer.js';
import {ENHANCED_DEFAULTS} from '../src/strategy.js';
import {compareStrategies} from '../src/backtest.js';
import {compareStrategiesParallel} from '../src/backtest-parallel.js';
import {candidateProcessCapacity} from '../src/research-process-capacity.js';

const assignments=[{group:0,cpu:2,core:1},{group:1,cpu:63,core:257}];
const plan={mode:'pinned',status:'planned',available_cpus:128,assignments};
const pinned=assignment=>({...assignment,status:'pinned',verified:true});
const task=id=>({trial:{id:'candidate_'+id,parameter_set_id:'P'+id,parameters:{}},phase:'tuning_train',remaining_ms:60000});
function fakeWorkers(){
  const workers=[];
  return {workers,factory:(url,options)=>{
    const worker=new EventEmitter();worker.threadId=workers.length+1;worker.options=options;worker.sent=[];worker.terminations=0;
    worker.postMessage=message=>worker.sent.push(message);worker.terminate=async()=>{worker.terminations++;worker.emit('exit',0);return 0;};workers.push(worker);return worker;
  }};
}
test('each candidate receives a verified unique CPU before dispatch and retains its worker identity',async t=>{
  const f=fakeWorkers(),updates=[],pool=new OptimizerPool({}, {workerLimit:2,affinityPlan:plan,workerFactory:f.factory});t.after(()=>pool.close());
  const result=pool.runBatch([task(1),task(2),task(3)],{onProgress:value=>updates.push(value)});
  assert.ok(f.workers.every(worker=>worker.sent.length===0));
  f.workers.forEach((worker,i)=>{assert.deepEqual(worker.options.workerData.affinity,{mode:'pinned',assignment:assignments[i]});worker.emit('message',{type:'ready',affinity:pinned(assignments[i])});});
  assert.deepEqual(updates.at(-1).active_sets.map(set=>[set.parameter_set_id,set.worker_id,set.affinity.cpu]),[['P1',1,2],['P2',2,63]]);
  const complete=worker=>worker.emit('message',{type:'complete',task_id:worker.sent.at(-1).task_id,stage:{}});
  complete(f.workers[0]);assert.equal(f.workers[0].sent.at(-1).task.trial.parameter_set_id,'P3');
  assert.equal(updates.at(-1).active_sets.find(set=>set.parameter_set_id==='P3').affinity.cpu,2);
  complete(f.workers[1]);complete(f.workers[0]);await result;
  assert.equal(updates.at(-1).workers.filter(item=>item.affinity.verified).length,2);
});
test('a worker reporting the wrong CPU cannot run and its assignment is reused only after retirement',async t=>{
  const f=fakeWorkers(),updates=[],pool=new OptimizerPool({}, {workerLimit:2,affinityPlan:plan,workerFactory:f.factory});t.after(()=>pool.close());
  let retire;f.workers[0].terminate=()=>new Promise(resolve=>{retire=()=>{f.workers[0].emit('exit',0);resolve(0);};});
  const result=pool.runBatch([task(1),task(2)],{onProgress:value=>updates.push(value)});
  f.workers[0].emit('message',{type:'ready',affinity:pinned(assignments[1])});
  await turn();assert.equal(f.workers.length,2);assert.equal(f.workers[0].sent.length,0);
  assert.equal(updates.at(-1).workers[0].affinity.status,'failed');
  retire();await turn();assert.equal(f.workers.length,3);assert.deepEqual(f.workers[2].options.workerData.affinity.assignment,assignments[0]);
  f.workers[1].emit('message',{type:'ready',affinity:pinned(assignments[1])});f.workers[2].emit('message',{type:'ready',affinity:pinned(assignments[0])});
  for(const worker of f.workers.slice(1))worker.emit('message',{type:'complete',task_id:worker.sent.at(-1).task_id,stage:{}});
  await result;
});
test('all failed pins leave candidate errors instead of silently calculating on automatic CPUs',async t=>{
  const f=fakeWorkers(),errors=[],pool=new OptimizerPool({}, {workerLimit:1,affinityPlan:{...plan,assignments:[assignments[0]]},workerFactory:f.factory,maxWorkerRestarts:0});t.after(()=>pool.close());
  const done=pool.runBatch([task(1),task(2)],{onFailure:(task,error)=>errors.push(error)});
  f.workers[0].emit('message',{type:'affinity_error',affinity:{status:'failed',verified:false,reason:'Assigned CPU is unavailable.'}});
  await done;assert.equal(errors.length,2);assert.ok(errors.every(error=>error.code==='cpu_affinity'));assert.equal(f.workers[0].sent.length,0);
});
test('macOS unsupported status remains explicit while normal worker scheduling continues',async t=>{
  const f=fakeWorkers(),updates=[],pool=new OptimizerPool({}, {workerLimit:1,affinityPlan:{mode:'pinned',status:'unsupported',reason:'macOS uses automatic scheduling.',assignments:[]},workerFactory:f.factory});t.after(()=>pool.close());
  const done=pool.runBatch([task(1)],{onProgress:value=>updates.push(value)});
  assert.equal(f.workers[0].options.workerData.affinity.mode,'automatic');
  f.workers[0].emit('message',{type:'ready',affinity:{status:'automatic',verified:false}});
  assert.equal(updates.at(-1).active_sets[0].affinity.status,'unsupported');
  f.workers[0].emit('message',{type:'complete',task_id:f.workers[0].sent.at(-1).task_id,stage:{}});await done;
});
test('comparison rejects unverified placement before sending any symbol analytics',async t=>{
  const f=fakeWorkers(),pool=new ComparisonAnalyticsPool({workerLimit:1,affinityPlan:{...plan,assignments:[assignments[0]]},workerFactory:f.factory});t.after(()=>pool.close());
  const pending=pool.evaluate([{symbol:'A',strategy:'intraday',history:[],context:{},signal:true}]);
  f.workers[0].emit('message',{type:'ready',affinity:{...pinned(assignments[0]),verified:false}});
  await assert.rejects(pending,error=>error.code==='cpu_affinity');assert.equal(f.workers[0].sent.length,0);assert.equal(f.workers[0].terminations,1);
});
const data=()=>({interval:'5minute',symbols:{TEST:[{time:'2026-09-14T09:15:00+05:30',open:100,high:101,low:99,close:100,volume:1000}]}});
test('service budgets native eligible CPUs, forwards assignments and sanitizes worker verification',async t=>{
  const f=fakeWorkers();let requested;
  const service=new ResearchService({workerFactory:f.factory,capacityDetector:()=>({available_cpus:96}),freeMemory:()=>128*2**30,cancelGraceMs:0,
    affinityPlanner:options=>{requested=options;return {...plan,available_cpus:8,assignments:Array.from({length:8},(_,cpu)=>({group:1,cpu,core:cpu}))};}});t.after(()=>service.close());
  const job=service.startOptimization([data()],{cpu_affinity:'pinned',tuning:{max_candidates:100}});
  assert.equal(requested.workerLimit,96);assert.equal(job.capacity.process_limit,8,'Use one candidate process per eligible core; analytics threads share each core');
  assert.equal(f.workers[0].options.workerData.options.affinity_plan.assignments.length,32);
  f.workers[0].emit('message',{type:'progress',phase:'tuning_train',parallelism:{active_sets:[{parameter_set_id:'P1',phase:'tuning_train',worker_id:7,affinity:pinned(assignments[0])}],workers:[{worker_id:7,affinity:pinned(assignments[0]),secret:'drop'}]}});
  const current=service.status();assert.equal(current.parallelism.workers[0].affinity.verified,true);assert.equal(current.parallelism.active_sets[0].worker_id,7);assert.ok(!('secret'in current.parallelism.workers[0]));
});
test('unknown scheduling modes are rejected before creating a coordinator',async t=>{
  const f=fakeWorkers(),service=new ResearchService({workerFactory:f.factory,capacityDetector:()=>({available_cpus:8}),cancelGraceMs:0});t.after(()=>service.close());
  for(const cpu_affinity of [null,'cpu0',true,4])assert.throws(()=>service.start(data(),{cpu_affinity}),/pinned or automatic/);
  assert.equal(f.workers.length,0);
});
test('affinity records do not turn planned or malformed assignments into verified claims',()=>{
  assert.equal(affinityRecord({status:'planned',verified:true}),null);
  assert.equal(affinityRecord({status:'pinned',verified:true,cpu:1}).status,'failed');
  assert.equal(affinityRecord({status:'pinned',verified:true,cpu:1,group:0,core:65536}).core,65536);
  assert.deepEqual(workerAffinityRecords([{worker_id:1,affinity:pinned(assignments[0])},{worker_id:1,affinity:pinned(assignments[1])}]).length,1);
});
test('real pinned research workers retain the serial optimizer result',{timeout:30000},async t=>{
  const affinity=planResearchAffinity({mode:'pinned',workerLimit:2});
  if(affinity.status!=='planned'||affinity.assignments.length<2){t.skip('Two native affinity assignments are unavailable on this host');return;}
  const rows=[],start=Date.parse('2025-12-01T09:15:00+05:30');
  for(let day=0;day<25;day++)for(let bar=0;bar<30;bar++)rows.push({time:new Date(start+day*86400000+bar*300000).toISOString(),open:100,high:100.05,low:99.95,close:100,volume:1000});
  const dataset={interval:'5minute',symbols:{TEST:rows}},options={initial_capital:100000,strategy_options:{...ENHANCED_DEFAULTS},tuning:{max_candidates:3,max_runtime_ms:60000}},updates=[];
  const expected=optimizeStrategies([dataset],options);
  const actual=await optimizeStrategiesParallel([dataset],{...options,parallelism:2,affinity_plan:affinity},{onProgress:value=>updates.push(value)});
  assert.deepEqual({...actual,elapsed_ms:0},{...expected,elapsed_ms:0});
  const verified=new Map(updates.flatMap(update=>update.parallelism.workers||[]).filter(item=>item.affinity.verified).map(item=>[`${item.process_id}:${item.worker_id}`,item.affinity]));
  assert.ok(verified.size>=2);assert.equal(new Set([...verified.values()].map(value=>`${value.group}:${value.cpu}`)).size,2);
});

test('one pinned comparison worker is separate from its coordinator and preserves portfolio results',{timeout:30000},async t=>{
  const affinity=planResearchAffinity({mode:'pinned',workerLimit:1});
  if(affinity.status!=='planned'){t.skip('Native affinity assignment is unavailable on this host');return;}
  const start=Date.parse('2026-09-14T09:15:00+05:30'),rows=Array.from({length:75},(_,i)=>({time:new Date(start+i*300000).toISOString(),open:100,high:100.1,low:99.9,close:100,volume:1000}));
  const dataset={interval:'5minute',symbols:{TEST:rows}},updates=[],events=[];
  const expected=compareStrategies(dataset);
  const actual=await compareStrategiesParallel(dataset,{parallelism:1,affinity_plan:affinity},{onProgress:value=>updates.push(value),onWorkerEvent:value=>events.push(value)});
  assert.deepEqual(actual,expected);assert.equal(events.filter(event=>event.type==='created').length,1);assert.equal(events.filter(event=>event.type==='stopped').length,1);
  assert.ok(updates.some(update=>update.parallelism.workers?.some(worker=>worker.affinity.verified&&worker.state==='busy')));
});

test('four stock threads inside each real candidate process verify their shared physical-core assignment',{timeout:30000},async t=>{
  const topology=planResearchAffinity({mode:'pinned',workerLimit:400});
  if(topology.status!=='planned'||topology.physical_cores<2){t.skip('Two native physical-core assignments are unavailable');return;}
  const {plan}=candidateProcessCapacity({usable:topology.available_cpus,physical:topology.physical_cores,free:16*2**30,heapMiB:512,candidates:3,requested:2,live:0,affinityPlan:topology});
  const rows=[],start=Date.parse('2025-12-01T09:15:00+05:30');
  for(let day=0;day<25;day++)for(let bar=0;bar<30;bar++)rows.push({time:new Date(start+day*86400000+bar*300000).toISOString(),open:100,high:100.05,low:99.95,close:100,volume:1000});
  const dataset={interval:'5minute',symbols:{A:rows,B:rows,C:rows,D:rows}},options={initial_capital:100000,strategy_options:{...ENHANCED_DEFAULTS},tuning:{max_candidates:3,max_runtime_ms:60000}};
  const expected=optimizeStrategies([dataset],options),records=new Map();
  const actual=await optimizeStrategiesParallel([dataset],{...options,parallelism:2,threads_per_process:4,affinity_plan:plan},{onProgress:value=>{
    for(const row of value.parallelism.workers??[])if(row.affinity.verified)records.set(`${row.process_id}:${row.worker_id}`,row);
  }});
  assert.deepEqual({...actual,elapsed_ms:0},{...expected,elapsed_ms:0});
  const pids=new Set([...records.values()].map(row=>row.process_id));assert.ok(pids.size>=2);
  const cores=new Set();
  for(const pid of pids){
    const workers=[...records.values()].filter(row=>row.process_id===pid);assert.equal(workers.length,4);
    assert.equal(new Set(workers.map(row=>row.affinity.core)).size,1);cores.add(workers[0].affinity.core);
  }
  assert.equal(cores.size,2);
});
