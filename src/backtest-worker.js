import { parentPort, workerData } from 'node:worker_threads';
import { compareStrategiesParallel } from './backtest-parallel.js';

let lastProgress=0,lastStage='',lastActive=false,latestProgress={},pendingProgress=null,progressTimer=null;
function flushProgress(){
  if(progressTimer){clearTimeout(progressTimer);progressTimer=null;}
  if(!pendingProgress)return;
  const progress=pendingProgress;pendingProgress=null;lastProgress=performance.now();lastStage=progress.phase;
  lastActive=(progress.parallelism?.active_workers??0)>0;
  parentPort.postMessage({type:'progress',...progress});
}
try {
  const optimize=workerData.type==='optimization';
  const cancellation=workerData.cancellation?new Int32Array(workerData.cancellation):null;
  const run=optimize?(await import('./optimizer.js')).optimizeStrategiesParallel:compareStrategiesParallel;
  const result = await run(optimize?workerData.datasets:workerData.dataset, workerData.options, {
    cancelled:()=>cancellation?Atomics.load(cancellation,0)!==0:false,
    onWorkerEvent:event=>{
      if(optimize&&['created','stopped'].includes(event.type)&&Number.isSafeInteger(event.process_id))parentPort.postMessage({type:'candidate_process',event:event.type,process_id:event.process_id});
    },
    onProgress: progress => {
      latestProgress={...latestProgress,...progress};
      pendingProgress=progress;
      // The optimizer pool coalesces fractional updates to 5 Hz and publishes
      // task/phase transitions immediately. Preserve both forms for the UI.
      const active=(progress.parallelism?.active_workers??0)>0,remaining=100-(performance.now()-lastProgress);
      if(optimize||progress.phase!==lastStage||active!==lastActive||remaining<=0||progress.progress===1||progress.phase_progress===1)flushProgress();
      else if(!progressTimer){
        // Always flush the newest state even if a long CPU batch produces no
        // further callbacks. Leading-only throttling can leave the UI stale.
        progressTimer=setTimeout(flushProgress,remaining);progressTimer.unref?.();
      }
    },
  });
  flushProgress();parentPort.postMessage({ type: 'complete', result });
} catch (error) {
  flushProgress();
  const timeout=error.code==='worker_timeout'||error.message==='Backtest runtime limit exceeded; use a smaller dataset';
  parentPort.postMessage({ type: 'failed', error: String(error.message || 'Research failed').slice(0, 1000),...(error.code==='cpu_affinity'?{error_code:'cpu_affinity'}:{}),...(timeout?{
    error_code:'worker_timeout',error_details:{phase:error.phase??latestProgress.phase,budget_ms:error.runtime_budget_ms,
      elapsed_ms:error.elapsed_ms,processed_bars:error.processed_bars??latestProgress.processed_bars,total_bars:error.total_bars??latestProgress.total_bars},
  }:{}) });
}
if(progressTimer)clearTimeout(progressTimer);
parentPort.close();
