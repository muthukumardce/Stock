import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchProcessReaper} from '../src/research-process-reaper.js';

function fixture(platform='linux',{responses=[123],errors=[],isMain=()=>true}={}){
  const calls=[],loads=[];let index=0;
  const reap=createResearchProcessReaper({platform,isMain,loadNative:os=>{
    loads.push(os);return {interrupted:4,noChild:10,errno:()=>errors[index-1],waitpid:(pid,status,options)=>{calls.push({pid,status,options});return responses[index++];}};
  }});
  return {reap,calls,loads};
}

for(const platform of ['linux','darwin'])test(`${platform} reaps only the requested owned PID using nonblocking waitpid after coordinator exit`,()=>{
  const f=fixture(platform);assert.deepEqual(f.reap(123,{coordinatorExited:true}),{status:'reaped',pid:123});
  assert.deepEqual(f.loads,[platform]);assert.equal(f.calls.length,1);assert.equal(f.calls[0].pid,123);assert.equal(f.calls[0].options,1);
  assert.ok(Buffer.isBuffer(f.calls[0].status));assert.equal(f.calls[0].status.length,4);
});

test('main-thread and explicit coordinator-exit guards prevent competing with a live libuv reaper',()=>{
  const f=fixture();for(const options of [undefined,{}, {coordinatorExited:false},{coordinatorExited:1}])assert.equal(f.reap(123,options).code,'coordinator_active');
  assert.equal(f.loads.length,0);assert.equal(f.calls.length,0);
  const worker=fixture('linux',{isMain:()=>false});assert.equal(worker.reap(123,{coordinatorExited:true}).code,'main_thread_required');assert.equal(worker.loads.length,0);
});

test('zero, negative, group, malformed and oversized PID selectors never reach native waitpid',()=>{
  const f=fixture();for(const pid of [0,-1,-123,1.5,NaN,Infinity,'123',null,0x80000000])assert.deepEqual(f.reap(pid,{coordinatorExited:true}),{status:'error',pid:null,code:'invalid_pid'});
  assert.equal(f.loads.length,0);assert.equal(f.calls.length,0);
});

test('a still-running child returns0 without blocking or consuming another child status',()=>{
  const f=fixture('linux',{responses:[0,123]});assert.deepEqual(f.reap(123,{coordinatorExited:true}),{status:'running',pid:0});
  assert.deepEqual(f.reap(123,{coordinatorExited:true}),{status:'reaped',pid:123});assert.equal(f.loads.length,1);assert.deepEqual(f.calls.map(call=>call.pid),[123,123]);
});

test('ECHILD does not assert that a PID is dead and requests the caller liveness fallback',()=>{
  const f=fixture('darwin',{responses:[-1],errors:[10]});assert.deepEqual(f.reap(123,{coordinatorExited:true}),{status:'unavailable',pid:null,code:'not_child'});
});

test('interrupted waits retry only a bounded number of times and never become a blocking wait',()=>{
  const f=fixture('linux',{responses:[-1,-1,123],errors:[4,4]});assert.equal(f.reap(123,{coordinatorExited:true}).status,'reaped');assert.equal(f.calls.length,3);
  const repeated=fixture('linux',{responses:[-1,-1,-1,-1,-1],errors:[4,4,4,4,4]});assert.equal(repeated.reap(123,{coordinatorExited:true}).code,'interrupted');assert.equal(repeated.calls.length,4);assert.ok(repeated.calls.every(call=>call.options===1));
});

test('native failures and unexpected PIDs remain errors without raw exception details',()=>{
  const error=fixture('linux',{responses:[-1],errors:[22]});assert.equal(error.reap(123,{coordinatorExited:true}).code,'wait_failed');
  const other=fixture('linux',{responses:[999]});assert.equal(other.reap(123,{coordinatorExited:true}).code,'unexpected_pid');
  let attempts=0;const missing=createResearchProcessReaper({platform:'linux',isMain:()=>true,loadNative:()=>{attempts++;throw new Error('secret native path');}});
  assert.deepEqual(missing(123,{coordinatorExited:true}),{status:'unavailable',pid:null,code:'native_unavailable'});missing(123,{coordinatorExited:true});assert.equal(attempts,1);
});

test('Windows and unsupported systems remain native-free no-ops',()=>{
  for(const platform of ['win32','freebsd']){
    const f=fixture(platform);assert.equal(f.reap(123,{coordinatorExited:true}).status,'unavailable');assert.equal(f.loads.length,0);assert.equal(f.calls.length,0);
  }
});
