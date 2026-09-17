import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateProcessCapacity} from '../src/research-process-capacity.js';
import {workerAffinityRecords} from '../src/research-affinity-state.js';

const defaults={usable:192,physical:96,reserved:4,live:0,free:100*2**30,heapMiB:1536,candidates:100,symbols:150};
test('full CPU policy assigns one process per physical core and four sharing analytics threads',()=>{
  for(const [usable,physical,processes,threads,allocated] of [[96,48,48,192,241],[192,96,96,384,481]]){
    const {capacity:c}=candidateProcessCapacity({...defaults,usable,physical});
    assert.equal(c.process_limit,processes);assert.equal(c.threads_per_process,4);
    assert.equal(c.analytics_thread_limit,threads);assert.equal(c.allocated_cpu_threads,allocated);
    assert.equal(c.cpu_target_percent,100);assert.equal(c.cpu_budget,usable);assert.equal(c.reserved_cpus,0);
  }
});
test('RAM admission is dynamic while manual process ceilings and physical-core counts constrain capacity',()=>{
  const memory=candidateProcessCapacity({...defaults,free:8*2**30}).capacity;
  assert.equal(memory.worker_memory_mib,1792+1664+4*192);assert.equal(memory.process_limit,96);
  assert.equal(memory.memory_policy,'pause_starts');assert.equal(memory.startup_memory_mib,memory.worker_memory_mib);assert.ok(memory.memory_reserve_mib>0);
  const manual=candidateProcessCapacity({...defaults,requested:3}).capacity;assert.equal(manual.process_limit,3);
  const live=candidateProcessCapacity({...defaults,live:30}).capacity;assert.equal(live.process_limit,96);
  const tiny=candidateProcessCapacity({...defaults,usable:2,physical:1,free:.5*2**30}).capacity;assert.equal(tiny.process_limit,1);assert.equal(tiny.threads_per_process,4);
  const narrow=candidateProcessCapacity({...defaults,symbols:1}).capacity;assert.equal(narrow.threads_per_process,4);
  const fallback=candidateProcessCapacity({...defaults,usable:8,physical:null}).capacity;assert.equal(fallback.process_limit,8);assert.equal(fallback.physical_core_count_source,'logical_fallback');
});
test('pinned candidates share SMT siblings within their own physical core without overlapping another candidate',()=>{
  const assignments=Array.from({length:16},(_,cpu)=>({group:0,cpu,core:cpu%8}));
  const affinityPlan={status:'planned',available_cpus:16,physical_cores:8,assignments};
  const {capacity:c,plan}=candidateProcessCapacity({...defaults,affinityPlan});
  assert.equal(c.usable_cpus,16);assert.equal(c.process_limit,8);assert.equal(c.threads_per_process,4);assert.equal(plan.assignments.length,32);
  for(let core=0;core<8;core++)assert.deepEqual(plan.assignments.slice(core*4,core*4+4).map(row=>row.cpu),[core,core+8,core,core+8]);
  assert.equal(affinityPlan.assignments.length,16);assert.equal(plan.assignment_policy,'one_candidate_per_physical_core');
  const extreme=candidateProcessCapacity({...defaults,usable:65536,physical:32768,free:1024*2**30}).capacity;
  assert.equal(extreme.process_limit,100);assert.equal(extreme.analytics_thread_limit,400);
});
test('thread identity includes its owning process because thread IDs repeat in different Node processes',()=>{
  const affinity={status:'automatic',verified:false};
  const records=workerAffinityRecords([{process_id:500,worker_id:1,affinity},{process_id:600,worker_id:1,affinity},{process_id:500,worker_id:1,affinity},{process_id:600,worker_id:2,affinity,private:'drop'}]);
  assert.deepEqual(records.map(row=>[row.process_id,row.worker_id]),[[500,1],[600,1],[600,2]]);
  assert.ok(records.every(row=>!Object.hasOwn(row,'private')));
});
