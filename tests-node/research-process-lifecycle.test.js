import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ResearchProcessLifecycle,defunctResearchProcess} from '../src/research-process-lifecycle.js';
import {ResearchService} from '../src/research.js';

test('the main-server lifecycle tracks only owned positive PIDs and retains them until OS exit',async()=>{
  const live=new Set([1234]),kills=[],lifecycle=new ResearchProcessLifecycle({isAlive:pid=>live.has(pid),kill:pid=>kills.push(pid),reap:()=>({status:'running'}),pause:async()=>live.clear()});
  for(const process_id of [0,-1,'1234',Infinity,process.pid])lifecycle.observe({event:'created',process_id});
  assert.equal(lifecycle.remaining(),0);lifecycle.observe({event:'created',process_id:1234});
  assert.equal(lifecycle.remaining(),1);await lifecycle.retire();assert.deepEqual(kills,[1234]);assert.equal(lifecycle.remaining(),0);
});
test('Unix child reaping is attempted only in retirement after its coordinator has exited, before any signal',async()=>{
  const calls=[],kills=[],lifecycle=new ResearchProcessLifecycle({isAlive:()=>true,kill:pid=>kills.push(pid),reap:(pid,options)=>{calls.push({pid,options});return {status:'reaped',pid};}});
  lifecycle.observe({event:'created',process_id:1234});assert.equal(lifecycle.remaining(),1);assert.equal(calls.length,0);
  await lifecycle.retire();assert.deepEqual(calls,[{pid:1234,options:{coordinatorExited:true}}]);assert.equal(lifecycle.remaining(),0);assert.deepEqual(kills,[],'An already-reaped child must never be signalled using its old PID');
});
test('a defunct Unix child is not reported as running when the optional reaper is unavailable',async()=>{
  const lifecycle=new ResearchProcessLifecycle({isAlive:()=>true,kill:()=>{},reap:()=>({status:'unavailable'}),isDefunct:()=>true});
  lifecycle.observe({event:'created',process_id:1234});await lifecycle.retire();assert.equal(lifecycle.remaining(),0);
  assert.equal(defunctResearchProcess(1234,{platform:'linux',read:()=> '1234 (node (worker)) Z 123 123 123'}),true);
  assert.equal(defunctResearchProcess(1234,{platform:'linux',read:()=> '1234 (node) R 123 123 123'}),false);
  let args;
  assert.equal(defunctResearchProcess(1234,{platform:'darwin',run:(...values)=>{args=values;return {status:0,stdout:'Z+\n'};}}),true);
  assert.equal(args[0],'/bin/ps');assert.deepEqual(args[1],['-o','stat=','-p','1234']);assert.equal(args[2].shell,false);
  assert.equal(defunctResearchProcess(-1,{platform:'linux',read:()=>assert.fail('Invalid PID must not read the filesystem')}),false);
});
test('a cleanup failure preserves ownership so a surviving child cannot be silently forgotten',async()=>{
  const lifecycle=new ResearchProcessLifecycle({isAlive:()=>true,kill:()=>{throw Object.assign(new Error('no access'),{code:'EPERM'});}});
  lifecycle.observe({event:'created',process_id:1234});await assert.rejects(lifecycle.retire(),/cannot restart/);assert.equal(lifecycle.remaining(),1);
  lifecycle.observe({event:'stopped',process_id:1234});assert.equal(lifecycle.remaining(),0);
});

const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
test('forced service cancellation waits for an OS candidate even when its JavaScript disconnect handler cannot run',{timeout:15000},async t=>{
  const childFile=fileURLToPath(new URL('./fixtures/research-blocked-process.cjs',import.meta.url));
  const source=`const {fork}=require('node:child_process');const {parentPort,workerData}=require('node:worker_threads');const child=fork(workerData.childFile,[],{execArgv:[],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});parentPort.postMessage({type:'candidate_process',event:'created',process_id:child.pid});child.on('message',()=>parentPort.postMessage({type:'progress',parallelism:{active_processes:1,active_sets:[{parameter_set_id:'P1',phase:'tuning_train',process_id:child.pid}]}}));`;
  const service=new ResearchService({workerFactory:()=>new Worker(source,{eval:true,execArgv:[],workerData:{childFile}}),cancelGraceMs:0,
    capacityDetector:()=>({available_cpus:8}),freeMemory:()=>8*2**30});
  let pid;
  t.after(async()=>{await service.close();if(pid&&alive(pid))process.kill(pid,'SIGKILL');});
  service.startOptimization([{interval:'5minute',symbols:{TEST:[]}}]);
  const deadline=Date.now()+5000;while(!service.status().parallelism.active_processes&&Date.now()<deadline)await delay(10);
  pid=service.status().parallelism.active_sets[0]?.process_id;assert.ok(pid&&alive(pid),'The offline child must be alive and blocked before cancellation');
  const stopped=await service.cancel();assert.equal(stopped.status,'cancelled');assert.equal(alive(pid),false,'cancel() must not return while the child still owns CPU/memory');
  assert.equal(service._processLifecycle.remaining(),0);assert.equal(service.worker,null);
});
