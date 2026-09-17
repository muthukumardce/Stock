/** Only bounded, already-closed candle snapshots enter this offline worker. */
import {parentPort,workerData} from 'node:worker_threads';
import {getHeapStatistics} from 'node:v8';
import {evaluateComparisonTask} from './backtest-analytics.js';
import {initializeWorkerAffinity} from './research-worker-affinity.js';

const cancellation=new Int32Array(workerData.cancellation);
const affinity=initializeWorkerAffinity(workerData.affinity);
if(affinity.status==='failed'){
  parentPort.postMessage({type:'affinity_error',affinity});parentPort.close();
}else{
parentPort.on('message',message=>{
  if(message?.type!=='evaluate')return;
  const task_id=message.task_id;
  try{
    const results=message.tasks.map(task=>{
      if(Atomics.load(cancellation,0))throw Object.assign(new Error('Comparison cancelled'),{name:'AbortError'});
      return evaluateComparisonTask(task,message.strategy_options);
    });
    if(Atomics.load(cancellation,0))throw Object.assign(new Error('Comparison cancelled'),{name:'AbortError'});
    parentPort.postMessage({type:'complete',task_id,results});
  }catch(error){
    parentPort.postMessage({type:'failed',task_id,name:error.name,code:error.code,error:String(error.message||'Comparison analytics failed').slice(0,1000)});
  }
});
parentPort.postMessage({type:'ready',affinity,heap_limit_bytes:getHeapStatistics().heap_size_limit});
}
