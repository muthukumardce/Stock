import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {OptimizerProcessPool,optimizerProcessEnvironment} from '../src/optimizer-process-pool.js';
import {reapResearchProcess} from '../src/research-process-reaper.js';
import {ResearchProcessLifecycle,defunctResearchProcess} from '../src/research-process-lifecycle.js';

const task=id=>({trial:{id:'candidate_'+id,parameter_set_id:'P'+id,parameters:{}},phase:'tuning_train',remaining_ms:60000});
const stage=value=>({'5minute':{metrics:{net_pnl:value},data_quality:{eligible:false}}});
const progress=(value,bars,total=100,completed=0,count=1,interval='5minute')=>({progress:value,processed_bars:bars,total_bars:total,completed_intervals:completed,total_intervals:count,interval});
function fixture(t,options={}){
  const children=[],scheduled=[],completed=[],failed=[],updates=[],forkOptions=[];
  const pool=new OptimizerProcessPool({datasets:[{interval:'5minute'}]}, {workerLimit:2,cancelGraceMs:0,
    scheduleStartup:callback=>{const entry={callback,called:false,cancelled:false};scheduled.push(entry);return entry;},cancelStartup:entry=>{entry.cancelled=true;},
    forkFactory:(path,args,opts)=>{
      forkOptions.push(opts);const child=new EventEmitter();child.pid=1000+children.length;child.connected=true;child.sent=[];child.kills=[];
      child.send=(value,callback)=>{child.sent.push(value);callback?.(null);};
      child.kill=signal=>{child.kills.push(signal);child.emit('exit',null,signal);return true;};children.push(child);return child;
    },...options});t.after(()=>pool.close());
  return {pool,children,scheduled,completed,failed,updates,forkOptions,
    tick:()=>{const entry=scheduled.find(value=>!value.called&&!value.cancelled);if(!entry)return false;entry.called=true;entry.callback();return true;},
    run:tasks=>pool.runBatch(tasks,{onComplete:(task,result)=>completed.push({task,result}),onFailure:(task,error)=>failed.push({task,error}),onProgress:value=>updates.push(value)}),
    ready:index=>children[index].emit('message',{type:'ready',protocol:1,process_id:children[index].pid}),
    send:(index,type,fields={},id=children[index].sent.find(value=>value.type==='run')?.task_id)=>children[index].emit('message',{type,task_id:id,...fields}),
    exit:index=>children[index].emit('exit',0),
  };
}

test('candidate forks hide windows and inherit only explicitly allowed OS environment values',()=>{
  const env=optimizerProcessEnvironment({SystemRoot:'C:/Windows',TEMP:'C:/Temp',HOME:'/home/test',KITE_API_SECRET:'secret',SESSION_SECRET:'secret',NODE_OPTIONS:'--require bad',PATH:'secret-path',LD_PRELOAD:'bad'});
  assert.deepEqual(env,{SystemRoot:'C:/Windows',TEMP:'C:/Temp',HOME:'/home/test'});
});

test('each active candidate has a process and a disjoint analytics CPU slice until that process exits',async t=>{
  const assignments=Array.from({length:4},(_,cpu)=>({group:0,cpu,core:cpu})),f=fixture(t,{threadsPerProcess:2,affinityPlan:{status:'planned',assignments}}),done=f.run([task(1),task(2),task(3)]);
  f.tick();f.ready(0);assert.equal(f.children.length,1);assert.equal(f.children[0].sent[0].type,'run');f.tick();f.ready(1);
  assert.deepEqual(f.children.map(child=>child.sent[0].task.affinity_plan.assignments),[assignments.slice(0,2),assignments.slice(2)]);
  assert.equal(f.forkOptions[0].windowsHide,true);assert.equal(f.forkOptions[0].serialization,'advanced');assert.deepEqual(f.forkOptions[0].stdio,['ignore','ignore','ignore','ipc']);assert.ok(!f.forkOptions[0].env.KITE_API_SECRET);
  assert.deepEqual(f.forkOptions[0].execArgv,[],'Process-level V8 flags must not override smaller nested Worker limits');assert.equal(f.children[0].sent[0].coordinator_heap_mib,512);
  f.send(0,'complete',{stage:stage(1)});assert.equal(f.completed.length,0);assert.equal(f.tick(),false,'Receiving a result cannot reuse CPUs before OS exit');
  f.exit(0);assert.equal(f.completed.length,1);f.tick();f.ready(2);assert.deepEqual(f.children[2].sent[0].task.affinity_plan.assignments,assignments.slice(0,2));
  f.send(1,'complete',{stage:stage(2)});f.exit(1);f.send(2,'complete',{stage:stage(3)});f.exit(2);await done;
  assert.deepEqual(f.completed.map(value=>value.task.trial.parameter_set_id),['P1','P2','P3']);assert.equal(f.updates.at(-1).active_processes,0);
});

test('a process crash affects one candidate while siblings and queued sets continue',async t=>{
  const f=fixture(t),done=f.run([task(1),task(2),task(3)]);f.tick();f.ready(0);f.tick();f.ready(1);
  f.children[0].emit('exit',7);assert.equal(f.failed.length,1);assert.equal(f.failed[0].error.code,'worker_crash');f.tick();f.ready(2);
  f.send(1,'complete',{stage:stage(2)});f.exit(1);f.send(2,'complete',{stage:stage(3)});f.exit(2);await done;
  assert.equal(f.completed.length,2);assert.equal(f.updates.at(-1).failed_tasks,1);assert.equal(f.children.length,3);
});

test('bad PID handshakes and stale progress cannot dispatch or change a candidate',async t=>{
  const f=fixture(t,{workerLimit:1}),done=f.run([task(1),task(2)]);f.tick();
  f.children[0].emit('message',{type:'ready',protocol:1,process_id:999});assert.equal(f.children[0].sent.length,0);assert.equal(f.failed[0].error.code,'worker_protocol');
  f.tick();f.ready(1);f.send(1,'progress',progress(.3,30));const before=f.updates.length;
  f.send(1,'progress',progress(.8,80),999);f.send(1,'progress',progress(.2,20));f.send(1,'progress',progress(.4,40,101));
  assert.equal(f.updates.length,before);assert.equal(f.updates.at(-1).active_sets[0].processed_bars,30);
  f.send(1,'complete',{stage:stage(2)});f.exit(1);await done;
});

test('nested analytics counts and worker identities are bounded and scoped to their process',async t=>{
  const f=fixture(t,{threadsPerProcess:2}),done=f.run([task(1)]);f.tick();f.ready(0);
  const nested={active_workers:2,workers:[{worker_id:1,state:'busy',affinity:{status:'pinned',verified:true,group:0,cpu:2,core:1},secret:'drop'}]};
  f.send(0,'progress',{...progress(.2,20),parallelism:nested});
  const current=f.updates.at(-1);assert.equal(current.active_threads,2);assert.equal(current.thread_limit,4);assert.equal(current.active_processes,1);assert.equal(current.active_sets[0].process_id,1000);
  assert.equal(current.workers[0].process_id,1000);assert.equal(current.workers[0].worker_id,1);assert.ok(!('secret'in current.workers[0]));
  assert.equal(current.active_sets[0].workers[0].process_id,1000);assert.equal(current.active_sets[0].workers[0].worker_id,1);
  f.send(0,'progress',{...progress(1,100,100,1),parallelism:{active_workers:999}});assert.equal(f.updates.at(-1).active_threads,2);
  f.send(0,'complete',{stage:stage(1)});f.exit(0);await done;assert.equal(f.updates.at(-1).active_threads,0);
});

test('interval counters reset once but completed scope and task progress cannot regress',async t=>{
  const f=fixture(t);f.pool.context.datasets=[{interval:'5minute'},{interval:'day'}];const done=f.run([task(1)]);f.tick();f.ready(0);
  f.send(0,'progress',progress(.5,100,100,1,2));f.send(0,'progress',progress(.5,0,50,1,2,'day'));
  assert.equal(f.updates.at(-1).active_sets[0].interval,'day');assert.equal(f.updates.at(-1).active_sets[0].processed_bars,0);
  f.send(0,'progress',{...progress(.75,25,50,1,2,'day'),parallelism:{active_workers:1}});assert.equal(f.updates.at(-1).active_sets[0].processed_bars,25);
  f.send(0,'progress',progress(.9,90,100,1,2));assert.equal(f.updates.at(-1).active_sets[0].interval,'day');
  f.send(0,'progress',progress(1,50,50,2,2,'day'));assert.equal(f.updates.at(-1).active_sets[0].completed_intervals,2);
  f.send(0,'complete',{stage:{...stage(1),day:stage(1)['5minute']}});f.exit(0);await done;assert.equal(f.completed.length,1);assert.equal(f.failed.length,0);
});

test('a process cannot return a partial multi-interval stage as a completed candidate',async t=>{
  const f=fixture(t);f.pool.context.datasets=[{interval:'5minute'},{interval:'day'}];const done=f.run([task(1)]);f.tick();f.ready(0);
  f.send(0,'complete',{stage:stage(1)});await done;assert.equal(f.completed.length,0);assert.equal(f.failed.length,1);assert.equal(f.failed[0].error.code,'worker_protocol');
});

test('current process worker records stay first after many completed sets and old phase handles are released',async t=>{
  const f=fixture(t,{workerLimit:1}),done=f.run([task(1),task(2),task(3)]);
  for(let index=0;index<3;index++){
    f.tick();f.ready(index);f.send(index,'progress',{...progress(.2,20),parallelism:{active_workers:1,workers:[{worker_id:1,state:'busy',affinity:{status:'automatic',verified:false}}]}});
    const current=f.updates.at(-1);assert.equal(current.workers[0].process_id,1000+index);assert.ok(current.workers.length<=2);
    f.send(index,'complete',{stage:stage(index)});f.exit(index);
  }
  await done;const next=f.run([task(4)]);assert.equal(f.pool.slots.length,0);f.tick();f.ready(3);f.send(3,'complete',{stage:stage(4)});f.exit(3);await next;
});

for(const kind of ['cancel','deadline'])test(`${kind} cancels pending forks and joins every existing OS process`,async t=>{
  let stop=false;const f=fixture(t,{guard:()=>{if(stop)throw Object.assign(new Error('Stop.'),kind==='cancel'?{name:'AbortError'}:{optimizationBudget:true});}}),done=f.run([task(1),task(2),task(3)]);
  f.tick();f.ready(0);const rejected=assert.rejects(done,error=>kind==='cancel'?error.name==='AbortError':error.optimizationBudget);
  stop=true;f.tick();await rejected;await f.pool.close();assert.equal(f.children.length,1);assert.equal(f.children[0].kills.length,1);assert.equal(f.tick(),false);assert.equal(f.failed.length,0);
});

test('closing before startup and invoking a late callback cannot fork an orphan process',async t=>{
  const f=fixture(t),done=f.run([task(1)]),scheduled=f.scheduled[0],rejected=assert.rejects(done,error=>error.name==='AbortError');
  await f.pool.close();await rejected;scheduled.callback();assert.equal(f.children.length,0);assert.equal(scheduled.cancelled,true);
});

test('low RAM leaves candidates queued without failure and periodic checks resume them after memory recovers',async t=>{
  let free=150;const f=fixture(t,{memoryReserveMiB:100,startupMemoryMiB:100,freeMemory:()=>free*2**20}),done=f.run([task(1)]);
  assert.equal(f.children.length,0);assert.equal(f.tick(),false);assert.equal(f.updates.at(-1).memory_waiting,true);assert.equal(f.updates.at(-1).memory_wait_reason,'free_memory');assert.equal(f.failed.length,0);
  assert.equal(f.pool.timer.hasRef(),true,'A RAM wait with no child must keep its bounded guard poll alive');
  free=300;const deadline=Date.now()+1000;while(!f.scheduled.length&&Date.now()<deadline)await delay(10);
  assert.equal(f.tick(),true);f.ready(0);assert.equal(f.children[0].sent[0].task.trial.parameter_set_id,'P1');
  f.send(0,'complete',{stage:stage(1)});f.exit(0);await done;assert.equal(f.completed.length,1);assert.equal(f.failed.length,0);assert.equal(f.updates.at(-1).memory_waiting,false);
});

test('admission reserves unaccounted initializing copies and releases their allowance only after work or exit',async t=>{
  const f=fixture(t,{workerLimit:4,memoryReserveMiB:100,startupMemoryMiB:100,freeMemory:()=>350*2**20,maxInitializing:4}),done=f.run([task(1),task(2),task(3),task(4)]);
  f.tick();f.ready(0);f.tick();f.ready(1);
  assert.equal(f.tick(),false);assert.equal(f.children.length,2);assert.equal(f.pool.batch.next,2);assert.equal(f.updates.at(-1).initializing_processes,2);assert.equal(f.updates.at(-1).memory_wait_reason,'free_memory');
  f.send(0,'progress',{...progress(0,0),parallelism:{active_workers:1}});assert.equal(f.tick(),true);f.ready(2);
  assert.equal(f.children.length,3);assert.equal(f.tick(),false,'The remaining two initializing copies still reserve their allowance');
  f.children[1].emit('exit',7);assert.equal(f.failed.length,1);assert.equal(f.tick(),true);f.ready(3);
  for(const index of [0,2,3]){f.send(index,'complete',{stage:stage(index)});f.exit(index);}await done;
  assert.equal(f.completed.length,3);assert.equal(f.failed[0].error.code,'worker_crash');
});

test('the initializing-process ceiling limits cold starts even with abundant RAM',async t=>{
  const f=fixture(t,{workerLimit:4,memoryReserveMiB:100,startupMemoryMiB:100,freeMemory:()=>10000*2**20,maxInitializing:2}),done=f.run([task(1),task(2),task(3),task(4)]);
  f.tick();f.ready(0);f.tick();f.ready(1);assert.equal(f.tick(),false);
  assert.equal(f.updates.at(-1).memory_wait_reason,'initializing');assert.equal(f.updates.at(-1).available_memory_mib,10000);
  f.send(0,'progress',progress(.5,1000001,1000001));assert.equal(f.tick(),false,'Malformed progress cannot free startup reservations');
  f.send(0,'progress',progress(0,0));assert.equal(f.tick(),false,'Initial zero progress does not prove the large context has normalized');
  f.send(0,'progress',progress(.1,10));assert.equal(f.tick(),true);assert.equal(f.children.length,3);assert.equal(f.pool._snapshot().initializing_processes,2);
  const rejected=assert.rejects(done,error=>error.name==='AbortError');await f.pool.close();await rejected;assert.equal(f.tick(),false);
});

test('RAM is checked again before a scheduled fork and falling memory never consumes its queued candidate',async t=>{
  let free=300;const f=fixture(t,{memoryReserveMiB:100,startupMemoryMiB:100,freeMemory:()=>free*2**20}),done=f.run([task(1)]);
  assert.equal(f.scheduled.length,1);free=100;f.tick();assert.equal(f.children.length,0);assert.equal(f.pool.batch.next,0);assert.equal(f.updates.at(-1).memory_waiting,true);
  const rejected=assert.rejects(done,error=>error.name==='AbortError');await f.pool.close();await rejected;assert.equal(f.failed.length,0);assert.equal(f.tick(),false);
});

for(const kind of ['cancel','deadline'])test(`a global ${kind} stops a zero-process RAM wait without recording candidate errors`,async t=>{
  let stop=false;const f=fixture(t,{memoryReserveMiB:100,startupMemoryMiB:100,freeMemory:()=>0,
    guard:()=>{if(stop)throw Object.assign(new Error('Stop RAM wait.'),kind==='cancel'?{name:'AbortError'}:{optimizationBudget:true});}}),done=f.run([task(1)]);
  const rejected=assert.rejects(done,error=>kind==='cancel'?error.name==='AbortError':error.optimizationBudget);stop=true;await rejected;await f.pool.close();
  assert.equal(f.children.length,0);assert.equal(f.failed.length,0);assert.equal(f.completed.length,0);assert.equal(f.tick(),false);
});

test('memory admission options are validated before any scheduler or process exists',()=>{
  for(const options of [{memoryReserveMiB:-1},{memoryReserveMiB:1,startupMemoryMiB:0},{memoryReserveMiB:1,maxInitializing:0},{memoryReserveMiB:1,freeMemory:null}])assert.throws(()=>new OptimizerProcessPool({datasets:[]},options),/memory admission/);
});

function realContext({days=1,symbols=2}={}){
  const start=Date.parse('2026-06-01T09:15:00+05:30'),bars=[];
  for(let day=0;day<days;day++)for(let i=0;i<75;i++)bars.push({time:new Date(start+day*86400000+i*300000).toISOString(),open:100,high:101,low:99,close:100,volume:1000});
  return {datasets:[{interval:'5minute',symbols:Object.fromEntries(Array.from({length:symbols},(_,i)=>['SYM'+i,bars]))}],common:{},incumbent:{enhanced_signals:true},
    limits:{min_trades:1,max_drawdown_pct:5},ranges:{'5minute':{train:{from:'2026-06-01',to:new Date(start+(days-1)*86400000).toISOString().slice(0,10)}}}};
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('real candidate processes calculate concurrently and exit before their results are settled',{timeout:15000},async t=>{
  const events=[],updates=[],results=[],pool=new OptimizerProcessPool(realContext(),{workerLimit:2,threadsPerProcess:2,onWorkerEvent:value=>events.push(value)});t.after(()=>pool.close());
  await pool.runBatch([task(1),task(2)],{onComplete:(task,result)=>results.push({task,result}),onFailure:(_task,error)=>assert.fail(error.message),onProgress:value=>updates.push(value)});
  assert.equal(results.length,2);const pids=events.filter(value=>value.type==='created').map(value=>value.process_id);assert.equal(new Set(pids).size,2);assert.ok(updates.some(value=>value.active_processes===2));
  assert.ok(updates.some(value=>value.active_threads>=2));assert.ok(pids.every(pid=>!alive(pid)));await pool.close();
});

test('actual nested analytics heap limits stay small beside a much larger portfolio heap',{timeout:15000},async t=>{
  const events=[],pool=new OptimizerProcessPool(realContext(),{workerLimit:1,threadsPerProcess:2,workerHeapMiB:4096,analyticsWorkerHeapMiB:128,onWorkerEvent:value=>events.push(value)});t.after(()=>pool.close());
  await pool.runBatch([task(1)],{onFailure:(_task,error)=>assert.fail(error.message)});
  const coordinator=events.find(value=>value.type==='coordinator_ready'),analytics=events.filter(value=>value.type==='analytics_ready');
  assert.ok(coordinator);assert.equal(analytics.length,2);assert.equal(new Set(analytics.map(value=>value.thread_id)).size,2);
  assert.ok(analytics.every(value=>value.process_id===coordinator.process_id&&value.thread_id!==coordinator.thread_id));
  assert.ok(coordinator.heap_limit_bytes>4096*2**20);assert.ok(coordinator.heap_limit_bytes<4300*2**20);
  assert.ok(analytics.every(value=>value.heap_limit_bytes>=128*2**20&&value.heap_limit_bytes<=192*2**20),'Real stock isolate heaps must obey128MiB old-space rather than inherit4096MiB');
  t.diagnostic(JSON.stringify({coordinator_heap_mib:coordinator.heap_limit_bytes/2**20,analytics_heap_mib:analytics.map(value=>value.heap_limit_bytes/2**20)}));
});

test('terminating the research coordinator Worker also exits its candidate process and nested analytics threads',{timeout:20000},async t=>{
  const moduleUrl=new URL('../src/optimizer-process-pool.js',import.meta.url).href;
  const source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {OptimizerProcessPool}=await import(workerData.moduleUrl);const pool=new OptimizerProcessPool(workerData.context,{workerLimit:1,threadsPerProcess:2,onWorkerEvent:value=>parentPort.postMessage({type:'event',value})});await pool.runBatch([workerData.task],{onProgress:value=>{if(value.active_threads>0)parentPort.postMessage({type:'active',value});}});await pool.close();})().catch(error=>parentPort.postMessage({type:'error',message:error.message}));`;
  const worker=new Worker(source,{eval:true,execArgv:[],workerData:{moduleUrl,context:realContext({days:30,symbols:8}),task:task(1)}}),pids=new Set();
  t.after(async()=>{await worker.terminate();const lifecycle=new ResearchProcessLifecycle();for(const pid of pids)lifecycle.observe({event:'created',process_id:pid});await lifecycle.retire();});
  const active=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Candidate analytics did not become active')),15000);
    worker.on('error',reject);worker.on('message',message=>{if(message.type==='event'&&message.value.process_id)pids.add(message.value.process_id);if(message.type==='error'){clearTimeout(timer);reject(new Error(message.message));}if(message.type==='active'){clearTimeout(timer);resolve(message.value);}});
  });
  assert.ok(active.active_threads>0);assert.equal(pids.size,1);assert.ok([...pids].every(alive));await worker.terminate();
  // Keep this proof independent of fallback SIGKILL: IPC loss itself must stop
  // the candidate. Reap dead Unix children so zombies are not mistaken for CPU
  // activity when Worker destruction has removed libuv's original wait handle.
  const deadline=Date.now()+5000;
  while(pids.size&&Date.now()<deadline){
    for(const pid of pids){const result=reapResearchProcess(pid,{coordinatorExited:true});if(result.status==='reaped'||!alive(pid)||result.status==='unavailable'&&defunctResearchProcess(pid))pids.delete(pid);}
    if(pids.size)await delay(25);
  }
  assert.equal(pids.size,0,'No candidate execution survives destruction of its owning research Worker');
});
