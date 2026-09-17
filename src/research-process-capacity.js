/** One CPU/RAM budget for candidate processes and their stock-analysis threads. */
export const MAX_CANDIDATE_ANALYTICS_THREADS=400;
export const DEFAULT_CANDIDATE_THREADS=4;

export function candidateProcessCapacity({usable,physical=null,live,free,heapMiB,candidates,requested=0,affinityPlan=null}){
  const mib=2**20,analyticsHeap=128,analyticsMemory=192;
  const eligible=affinityPlan?.status==='planned'?Math.min(usable,affinityPlan.available_cpus):usable;
  // A candidate owns one physical-core slot and has four analytics threads.
  // Those threads share the core's eligible logical CPUs; this intentionally
  // permits more runnable threads than hardware threads under the full-CPU
  // policy. The portfolio coordinator stays scheduled by the operating system.
  const coreGroups=new Map();
  if(affinityPlan?.status==='planned')for(const assignment of affinityPlan.assignments){
    const key=assignment.core===undefined?`cpu:${assignment.group}:${assignment.cpu}`:`core:${assignment.core}`;
    if(!coreGroups.has(key))coreGroups.set(key,[]);coreGroups.get(key).push(assignment);
  }
  const detectedPhysical=affinityPlan?.status==='planned'?affinityPlan.physical_cores??coreGroups.size:physical;
  const physicalCpus=Math.max(1,Math.min(eligible,Number.isSafeInteger(detectedPhysical)&&detectedPhysical>0?detectedPhysical:eligible));
  // The child main thread relays IPC to a bounded portfolio Worker. Include
  // its transient dataset copy separately from that Worker's simulation heap.
  const relayMemory=heapMiB+128,processMemory=heapMiB+256+relayMemory,coordinatorMemory=heapMiB+256;
  const memoryReserve=Math.max(512*mib,Math.min(8192*mib,free*.1))+coordinatorMemory*mib;
  const threads=DEFAULT_CANDIDATE_THREADS;
  const cpuLimit=Math.max(1,Math.min(physicalCpus,affinityPlan?.status==='planned'?coreGroups.size:physicalCpus));
  const processLimit=Math.max(1,Math.min(requested||100,candidates,cpuLimit,Math.floor(MAX_CANDIDATE_ANALYTICS_THREADS/threads)));
  const threadLimit=processLimit*threads;
  const plan=affinityPlan?.status==='planned'?{...affinityPlan,assignment_policy:'one_candidate_per_physical_core',
    assignments:[...coreGroups.values()].slice(0,processLimit).flatMap(cpus=>Array.from({length:threads},(_,index)=>cpus[index%cpus.length]))}:affinityPlan;
  return {plan,capacity:{
    kind:'optimization',worker_limit:processLimit,process_limit:processLimit,threads_per_process:threads,analytics_thread_limit:threadLimit,
    cpu_budget:eligible,cpu_worker_limit:cpuLimit,cpu_target_percent:100,usable_cpus:eligible,physical_cpus:physicalCpus,
    physical_core_count_source:Number.isSafeInteger(detectedPhysical)&&detectedPhysical>0?'detected':'logical_fallback',reserved_cpus:0,live_workers:live,
    coordinator_cpus:1,candidate_coordinator_cpus:processLimit,allocated_cpu_threads:processLimit*(threads+1)+1,
    memory_policy:'pause_starts',max_initializing_processes:4,startup_memory_mib:processMemory+threads*analyticsMemory,
    available_memory_mib:Math.floor(free/mib),worker_heap_mib:heapMiB,process_heap_mib:heapMiB,
    worker_memory_mib:processMemory+threads*analyticsMemory,process_memory_mib:processMemory,process_relay_memory_mib:relayMemory,
    analytics_worker_heap_mib:analyticsHeap,analytics_worker_memory_mib:analyticsMemory,
    coordinator_heap_mib:heapMiB,coordinator_memory_mib:coordinatorMemory,memory_reserve_mib:Math.ceil(memoryReserve/mib),requested_workers:requested,
    ...(plan?{affinity:plan}:{})
  }};
}
