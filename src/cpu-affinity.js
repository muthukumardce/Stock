/** Platform dispatcher. Planning is read-only; only research Workers may pin. */
import {isMainThread} from 'node:worker_threads';
import {planWindowsAffinity,applyWindowsAffinity} from './cpu-affinity-windows.js';
import {planLinuxAffinity,applyLinuxAffinity} from './cpu-affinity-linux.js';

export function createAffinityController({platform=process.platform,isWorker=()=>!isMainThread,windows={plan:planWindowsAffinity,apply:applyWindowsAffinity},linux={plan:planLinuxAffinity,apply:applyLinuxAffinity}}={}){
  const modeOf=mode=>{if(!['pinned','automatic'].includes(mode))throw new TypeError('CPU affinity mode must be pinned or automatic');return mode;};
  const supported=()=>platform==='win32'?windows:platform==='linux'?linux:null;
  return {
    planResearchAffinity({mode='pinned',workerLimit=1}={}){
      modeOf(mode);if(!Number.isInteger(workerLimit)||workerLimit<1||workerLimit>400)throw new RangeError('Affinity worker limit must be between 1 and 400');
      if(mode==='automatic')return {mode,status:'automatic',reason:'CPU placement is managed by the operating system.',assignments:[]};
      const adapter=supported();if(!adapter)return {mode,status:'unsupported',reason:'Hard CPU pinning is not supported on this platform; the operating system schedules research workers automatically.',assignments:[]};
      try{return adapter.plan({workerLimit});}catch{return {mode,status:'unavailable',reason:'Native CPU affinity is unavailable; the operating system schedules research workers automatically.',assignments:[]};}
    },
    applyWorkerAffinity(assignment,{mode='pinned'}={}){
      modeOf(mode);const base={group:null,cpu:null,core:null,verified:false};
      if(mode==='automatic')return {...base,status:'automatic',reason:'CPU placement is managed by the operating system.'};
      const adapter=supported();if(!adapter)return {...base,status:'unsupported',reason:'Hard CPU pinning is not supported on this platform; automatic scheduling remains active.'};
      if(!isWorker())return {...base,status:'failed',reason:'CPU affinity can only be applied inside a research Worker thread.'};
      try{return adapter.apply(assignment);}catch{return {...base,status:'failed',reason:'The worker CPU assignment could not be verified. This worker must be retired.'};}
    },
  };
}

const controller=createAffinityController();
export const planResearchAffinity=options=>controller.planResearchAffinity(options);
export const applyWorkerAffinity=(assignment,options)=>controller.applyWorkerAffinity(assignment,options);
