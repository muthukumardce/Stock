/** One immutable research dataset copy per CPU worker; tasks contain only thresholds and phase. */
import {parentPort,workerData} from 'node:worker_threads';
import {evaluateOptimizationTask} from './optimizer.js';
import {initializeWorkerAffinity} from './research-worker-affinity.js';

const cancellation=new Int32Array(workerData.cancellation);
const affinity=initializeWorkerAffinity(workerData.affinity);
if(affinity.status==='failed'){
  parentPort.postMessage({type:'affinity_error',affinity});parentPort.close();
}else{
parentPort.on('message',message=>{
  if(message?.type!=='task')return;
  const task_id=message.task_id;let interval=null,lastProgress=-Infinity,lastInterval,lastCompleted;
  try{
    const stage=evaluateOptimizationTask(workerData.context,message.task,{
      cancelled:()=>Atomics.load(cancellation,0)!==0,
      onInterval:value=>{interval=value;parentPort.postMessage({type:'interval',interval,task_id});},
      onProgress:value=>{
        const now=performance.now();
        if(value.interval!==lastInterval||value.completed_intervals!==lastCompleted||value.progress===1||now-lastProgress>=200){
          lastProgress=now;lastInterval=value.interval;lastCompleted=value.completed_intervals;
          parentPort.postMessage({type:'progress',task_id,progress:value.progress,interval:value.interval,processed_bars:value.processed_bars,total_bars:value.total_bars,completed_intervals:value.completed_intervals,total_intervals:value.total_intervals});
        }
      },
    });
    parentPort.postMessage({type:'complete',stage,task_id});
  }catch(error){
    parentPort.postMessage({type:'failed',error:String(error.message||'Optimizer calculation failed').slice(0,1000),name:error.name,code:error.code,interval:error.interval||interval,optimizationBudget:error.optimizationBudget===true,task_id});
  }
});
parentPort.postMessage({type:'ready',affinity});
}
