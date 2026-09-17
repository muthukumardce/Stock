import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {createAffinityController,planResearchAffinity} from '../src/cpu-affinity.js';
import {createWindowsAffinityAdapter,decodeWindowsCpuSets} from '../src/cpu-affinity-windows.js';

const bits=(...cpus)=>cpus.reduce((mask,cpu)=>mask|(1n<<BigInt(cpu)),0n);
function topology(){
  const row=(group,cpu,core)=>({id:1000+group*64+cpu,group,cpu,core:group*256+core,parked:false,allocated:false,allocated_to_process:false});
  return {cpus:[row(0,0,0),row(0,1,0),row(0,32,1),row(0,33,1),row(0,63,2),row(1,0,0),row(1,1,0),row(1,32,1),row(1,33,1)],groups:[0,1],
    thread_affinity:{group:0,mask:bits(0,1,32,33,63)},process_mask:bits(0,1,32,33,63),system_mask:bits(0,1,32,33,63),
    process_cpu_sets:[],thread_cpu_sets:[],process_cpu_masks:null,thread_cpu_masks:null,job_masks:null};
}
function fixture({snapshot=topology(),set,verify,processor,isWorker=()=>true}={}){
  const calls=[],original={...snapshot.thread_affinity};let current={...original};
  const backend={snapshot:()=>structuredClone(snapshot),getThreadAffinity:()=>verify?verify(current,calls):({...current}),setThreadAffinity:value=>{calls.push({...value});if(set&&!set(value,calls))return false;current={...value};return true;},
    getCurrentProcessor:()=>processor?processor(current):({group:current.group,cpu:[...Array(64).keys()].find(cpu=>current.mask===bits(cpu))})};
  return {snapshot,calls,original,backend,adapter:createWindowsAffinityAdapter({backend,isWorker})};
}

test('Windows plans unique logical CPUs across groups, using distinct physical cores before SMT siblings',()=>{
  const f=fixture(),plan=f.adapter.planWindowsAffinity({workerLimit:100});
  assert.equal(plan.status,'planned');assert.equal(plan.available_cpus,9);assert.equal(plan.physical_cores,5);
  assert.deepEqual(plan.assignments.slice(0,5),[{group:0,cpu:0,core:0},{group:0,cpu:32,core:1},{group:0,cpu:63,core:2},{group:1,cpu:0,core:256},{group:1,cpu:32,core:257}]);
  assert.equal(new Set(plan.assignments.map(row=>row.group+':'+row.cpu)).size,9);assert.equal(f.calls.length,0,'Planning never changes any affinity');
  assert.equal(f.adapter.planWindowsAffinity({workerLimit:2}).assignments.length,2);
});

test('Windows planning respects primary process and thread masks without widening to another group',()=>{
  for(const restriction of ['process','thread']){
    const snapshot=topology();snapshot.thread_affinity.mask=bits(32,63);if(restriction==='process')snapshot.process_mask=bits(32,63);
    const plan=fixture({snapshot}).adapter.planWindowsAffinity({workerLimit:10});
    assert.deepEqual(plan.assignments,[{group:0,cpu:32,core:1},{group:0,cpu:63,core:2}]);assert.equal(plan.available_cpus,2);
  }
});

test('Windows planning intersects CPU-set IDs, masks, job masks and excludes parked or other-process reservations',()=>{
  const snapshot=topology();snapshot.process_cpu_sets=[1000,1032,1033,1063,1064,1096];snapshot.thread_cpu_sets=[1000,1032,1063,1064,1096];
  snapshot.process_cpu_masks=[{group:0,mask:bits(0,32,63)},{group:1,mask:bits(0,32)}];
  snapshot.thread_cpu_masks=[{group:0,mask:bits(0,32,63)},{group:1,mask:bits(0)}];snapshot.job_masks=[{group:0,mask:bits(0,32)},{group:1,mask:bits(0)}];
  snapshot.cpus.find(row=>row.id===1000).parked=true;snapshot.cpus.find(row=>row.id===1032).allocated=true;
  const owned=snapshot.cpus.find(row=>row.id===1064);owned.allocated=true;owned.allocated_to_process=true;
  const plan=fixture({snapshot}).adapter.planWindowsAffinity({workerLimit:10});assert.deepEqual(plan.assignments,[{group:1,cpu:0,core:256}]);
});

test('documented multi-group zero process masks use only the verified current thread group and restrictions',()=>{
  const snapshot=topology();snapshot.process_mask=0n;snapshot.system_mask=0n;
  snapshot.thread_affinity.mask=bits(0,32,63);snapshot.process_cpu_sets=[1000,1032,1064];snapshot.job_masks=[{group:0,mask:bits(32)},{group:1,mask:bits(0)}];
  const f=fixture({snapshot}),plan=f.adapter.planWindowsAffinity({workerLimit:10});
  assert.equal(plan.status,'planned');assert.deepEqual(plan.assignments,[{group:0,cpu:32,core:1}]);assert.equal(plan.available_cpus,1);
  assert.equal(f.adapter.applyWindowsAffinity({group:0,cpu:32,core:1}).status,'pinned');
  const other=fixture({snapshot});assert.equal(other.adapter.applyWindowsAffinity({group:1,cpu:0,core:256}).status,'failed');assert.equal(other.calls.length,0);
  assert.equal(fixture({snapshot:{...snapshot,groups:[0]}}).adapter.planWindowsAffinity({workerLimit:1}).status,'unavailable','A zero mask without verified multiple groups stays unavailable');
});

test('unknown or inconsistent Windows restrictions fail closed instead of claiming pinning is available',()=>{
  for(const patch of [{process_mask:0n},{system_mask:0n},{groups:[]},{thread_affinity:{group:0,mask:1n<<64n}},{process_cpu_sets:null},{process_mask:2**63},
    {cpus:[...topology().cpus,topology().cpus[0]]},{job_masks:[{group:0,mask:0n}]}]){
    const plan=fixture({snapshot:{...topology(),...patch}}).adapter.planWindowsAffinity({workerLimit:3});assert.equal(plan.status,'unavailable');assert.deepEqual(plan.assignments,[]);
  }
  const missing=createWindowsAffinityAdapter({backendFactory:()=>{throw new Error('Native load failed with private details');}}).planWindowsAffinity({workerLimit:1});
  assert.equal(missing.status,'unavailable');assert.doesNotMatch(missing.reason,/private/);
});

test('Windows pinning uses unsigned BigInt masks above bit31 and at bit63 and verifies the running processor',()=>{
  for(const [cpu,core] of [[32,1],[63,2]]){
    const f=fixture(),result=f.adapter.applyWindowsAffinity({group:0,cpu,core});
    assert.equal(result.status,'pinned');assert.equal(result.verified,true);assert.deepEqual(f.calls,[{group:0,mask:1n<<BigInt(cpu)}]);
  }
  const f=fixture(),result=f.adapter.applyWindowsAffinity({group:1,cpu:32,core:257});assert.equal(result.status,'pinned');assert.deepEqual(f.calls,[{group:1,mask:1n<<32n}]);
});

test('CPU reservations are rechecked inside the worker and invalid or stale assignments never invoke the setter',()=>{
  for(const assignment of [{group:0,cpu:64,core:0},{group:-1,cpu:0,core:0},{group:0,cpu:32,core:99},null]){
    const f=fixture();assert.equal(f.adapter.applyWindowsAffinity(assignment).status,'failed');assert.equal(f.calls.length,0);
  }
  const f=fixture();f.snapshot.cpus.find(row=>row.cpu===32&&row.group===0).allocated=true;
  assert.equal(f.adapter.applyWindowsAffinity({group:0,cpu:32,core:1}).status,'failed');assert.equal(f.calls.length,0);
  const main=fixture({isWorker:()=>false});assert.equal(main.adapter.applyWindowsAffinity({group:0,cpu:32,core:1}).status,'failed');assert.equal(main.calls.length,0);
});

test('failed processor or mask verification restores and verifies the original thread group affinity',()=>{
  for(const kind of ['processor','mask']){
    const f=fixture(kind==='processor'?{processor:()=>({group:1,cpu:7})}:{verify:(current,calls)=>calls.length===1?{...current,mask:bits(0,32)}:{...current}});
    const result=f.adapter.applyWindowsAffinity({group:0,cpu:32,core:1});assert.equal(result.status,'failed');assert.equal(result.verified,false);
    assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.original);assert.match(result.reason,/was restored/);
  }
});

test('a rejected set or failed restoration can never report a verified worker',()=>{
  const rejected=fixture({set:(_value,calls)=>calls.length!==1}),result=rejected.adapter.applyWindowsAffinity({group:0,cpu:32,core:1});
  assert.equal(result.status,'failed');assert.equal(rejected.calls.length,2);assert.match(result.reason,/was restored/);
  const failedRestore=fixture({processor:()=>({group:0,cpu:2}),set:(_value,calls)=>calls.length===1});
  assert.match(failedRestore.adapter.applyWindowsAffinity({group:0,cpu:32,core:1}).reason,/could not be restored/);
});

test('Windows CPU-set decoding follows variable record sizes and keeps group and bit63 identities',()=>{
  const row=(group,cpu,core,flags=0,size=32)=>{const buffer=Buffer.alloc(size);buffer.writeUInt32LE(size);buffer.writeUInt32LE(1000+group*64+cpu,8);buffer.writeUInt16LE(group,12);buffer[14]=cpu;buffer[15]=core;buffer[19]=flags;return buffer;};
  const future=Buffer.alloc(12);future.writeUInt32LE(12);future.writeUInt32LE(99,4);
  const decoded=decodeWindowsCpuSets(Buffer.concat([row(0,63,4,7),future,row(2,32,9,0,40)]));
  assert.deepEqual(decoded,[{id:1063,group:0,cpu:63,core:4,parked:true,allocated:true,allocated_to_process:true},{id:1160,group:2,cpu:32,core:521,parked:false,allocated:false,allocated_to_process:false}]);
  for(const invalid of [Buffer.alloc(1),Buffer.alloc(8),row(0,0,0).subarray(0,31)])assert.throws(()=>decodeWindowsCpuSets(invalid));
});

test('dispatcher keeps automatic and unsupported modes native-free and prevents main-thread pinning',()=>{
  let calls=0;const adapter={plan:()=>{calls++;return {mode:'pinned',status:'planned',assignments:[{group:0,cpu:1,core:0}],available_cpus:2,physical_cores:1};},apply:assignment=>{calls++;return {...assignment,status:'pinned',verified:true};}};
  const win=createAffinityController({platform:'win32',windows:adapter,isWorker:()=>false});
  assert.equal(win.planResearchAffinity({mode:'automatic'}).status,'automatic');assert.equal(win.applyWorkerAffinity(null,{mode:'automatic'}).status,'automatic');assert.equal(calls,0);
  assert.equal(win.applyWorkerAffinity({group:0,cpu:1,core:0}).status,'failed');assert.equal(calls,0);
  const mac=createAffinityController({platform:'darwin',windows:adapter,linux:adapter});assert.equal(mac.planResearchAffinity().status,'unsupported');assert.equal(mac.applyWorkerAffinity(null).status,'unsupported');assert.equal(calls,0);
  const linux=createAffinityController({platform:'linux',linux:adapter,isWorker:()=>true});assert.equal(linux.planResearchAffinity().status,'planned');assert.equal(linux.applyWorkerAffinity({group:0,cpu:1,core:0}).verified,true);assert.equal(calls,2);
  for(const mode of ['bad',null,1])assert.throws(()=>win.planResearchAffinity({mode}),/mode/);
  for(const workerLimit of [0,401,1.5,Infinity])assert.throws(()=>win.planResearchAffinity({workerLimit}),/limit/);
});

test('one disposable Windows worker applies and verifies its own CPU assignment',{skip:process.platform!=='win32',timeout:10000},async t=>{
  const moduleUrl=new URL('../src/cpu-affinity.js',import.meta.url).href;
  const source=`const {parentPort}=require('node:worker_threads');(async()=>{const {planResearchAffinity,applyWorkerAffinity}=await import(${JSON.stringify(moduleUrl)});const plan=planResearchAffinity({workerLimit:100});const assignment=plan.assignments.find(row=>row.group>0&&row.cpu>=32)||plan.assignments.find(row=>row.cpu===63)||plan.assignments[0];parentPort.postMessage({status:plan.status,reason:plan.reason,available_cpus:plan.available_cpus,physical_cores:plan.physical_cores,assignment,result:assignment?applyWorkerAffinity(assignment):null});})().catch(error=>{parentPort.postMessage({error:error.message});});`;
  const worker=new Worker(source,{eval:true,execArgv:[]});t.after(()=>worker.terminate());
  const [message]=await once(worker,'message',{signal:AbortSignal.timeout(8000)});
  assert.equal(message.error,undefined);t.diagnostic(JSON.stringify(message));
  if(message.status==='unavailable'){t.skip('Native topology could not be verified in this test environment');return;}
  assert.equal(message.status,'planned');assert.equal(message.result.status,'pinned');assert.equal(message.result.verified,true);
  assert.deepEqual([message.result.group,message.result.cpu,message.result.core],[message.assignment.group,message.assignment.cpu,message.assignment.core]);
  await worker.terminate();assert.equal(worker.threadId,-1);
});

test('simultaneous disposable Windows workers remain pinnable across processor groups',{skip:process.platform!=='win32',timeout:15000},async t=>{
  const initial=planResearchAffinity({workerLimit:100});
  if(initial.status!=='planned'){t.skip('Native topology could not be verified in this test environment');return;}
  const groups=[...new Set(initial.assignments.map(row=>row.group))];
  if(groups.length<2){t.skip('This fixture needs at least two eligible processor groups');return;}
  const selected=groups.slice(0,2).flatMap(group=>initial.assignments.filter(row=>row.group===group).slice(0,2));
  // Interleave groups and leave every worker alive while the next one queries
  // process masks. This exercises the state after explicit cross-group pinning.
  selected.sort((a,b)=>a.cpu-b.cpu||a.group-b.group);
  const moduleUrl=new URL('../src/cpu-affinity.js',import.meta.url).href,workers=[],results=[];
  t.after(async()=>{await Promise.all(workers.map(worker=>worker.terminate()));assert.ok(workers.every(worker=>worker.threadId===-1));});
  const source=`const {parentPort,workerData}=require('node:worker_threads');parentPort.on('message',()=>{});(async()=>{const {planResearchAffinity,applyWorkerAffinity}=await import(${JSON.stringify(moduleUrl)});const plan=planResearchAffinity({workerLimit:100});parentPort.postMessage({status:plan.status,available_cpus:plan.available_cpus,result:applyWorkerAffinity(workerData)});})().catch(error=>parentPort.postMessage({error:error.message}));`;
  for(const assignment of selected){
    const worker=new Worker(source,{eval:true,execArgv:[],workerData:assignment});workers.push(worker);
    const [message]=await once(worker,'message',{signal:AbortSignal.timeout(8000)});results.push(message);
    assert.equal(message.error,undefined);assert.equal(message.status,'planned');assert.equal(message.result.status,'pinned');assert.equal(message.result.verified,true);
    assert.deepEqual([message.result.group,message.result.cpu],[assignment.group,assignment.cpu]);
    assert.ok(workers.every(active=>active.threadId>0),'Earlier pinned workers remain alive');
  }
  const after=planResearchAffinity({workerLimit:100});assert.equal(after.status,'planned');assert.equal(after.available_cpus,initial.available_cpus);assert.deepEqual(after.assignments,initial.assignments);
  t.diagnostic(JSON.stringify({concurrent_workers:workers.length,groups:[...new Set(results.map(row=>row.result.group))],assignments:results.map(row=>({group:row.result.group,cpu:row.result.cpu,verified:row.result.verified})),available_cpus:after.available_cpus}));
});
