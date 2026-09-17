/** Bounded portfolio isolate; its stock workers retain their smaller heap limits. */
import {parentPort,workerData,threadId} from 'node:worker_threads';
import {getHeapStatistics} from 'node:v8';
import {evaluateOptimizationTaskParallel} from './optimizer.js';

const cancellation=new Int32Array(workerData.cancellation),taskId=workerData.task_id;
let pendingProgress=null,progressTimer=null,lastProgress=-Infinity,lastInterval=null,lastCompleted=0,reportedBusy=false;
const send=value=>parentPort.postMessage({task_id:taskId,...value});
function flushProgress(){
  if(progressTimer){clearTimeout(progressTimer);progressTimer=null;}
  if(!pendingProgress)return;
  const value=pendingProgress;pendingProgress=null;lastProgress=performance.now();lastInterval=value.interval;lastCompleted=value.completed_intervals;
  if(value.parallelism?.active_workers>0)reportedBusy=true;
  send({type:'progress',...value});
}
function reportProgress(value){
  pendingProgress=value;const remaining=200-(performance.now()-lastProgress);
  if(value.interval!==lastInterval||value.completed_intervals!==lastCompleted||value.progress===1||!reportedBusy&&value.parallelism?.active_workers>0||remaining<=0)flushProgress();
  else if(!progressTimer)progressTimer=setTimeout(flushProgress,remaining);
}
send({type:'coordinator_ready',thread_id:threadId,heap_limit_bytes:getHeapStatistics().heap_size_limit});
try{
  const stage=await evaluateOptimizationTaskParallel(workerData.context,workerData.task,{
    cancelled:()=>Atomics.load(cancellation,0)!==0,
    onInterval:interval=>send({type:'interval',interval}),onProgress:reportProgress,
    onWorkerEvent:event=>{if(event.type==='ready')send({type:'analytics_ready',thread_id:event.thread_id,heap_limit_bytes:event.heap_limit_bytes});},
  });
  if(Atomics.load(cancellation,0))throw Object.assign(new Error('Optimization cancelled'),{name:'AbortError'});
  flushProgress();send({type:'complete',stage});
}catch(error){
  flushProgress();send({type:'failed',error:String(error?.message||'Candidate calculation failed.').slice(0,1000),
    code:error?.code,name:error?.name,interval:error?.interval,optimizationBudget:error?.optimizationBudget===true});
}finally{if(progressTimer)clearTimeout(progressTimer);parentPort.close();}
