import {applyWorkerAffinity} from './cpu-affinity.js';
import {affinityRecord} from './research-affinity-state.js';

/** Invoked only by the offline worker entrypoints before accepting work. */
export function initializeWorkerAffinity(request){
  if(request?.mode!=='pinned')return {status:request?.status||'automatic',verified:false,reason:request?.reason||'The operating system schedules this worker.'};
  try{
    return affinityRecord(applyWorkerAffinity(request.assignment,{mode:'pinned'}))||{status:'failed',verified:false,reason:'Native CPU verification returned no result.'};
  }catch{
    return {status:'failed',verified:false,reason:'Native CPU assignment failed. Choose automatic scheduling to continue without pinning.'};
  }
}
