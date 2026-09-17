/** Parallel closed-candle analytics with a single chronological portfolio. */
import {backtestSteps,comparisonReport} from './backtest.js';
import {evaluateComparisonTask} from './backtest-analytics.js';
import {ComparisonAnalyticsPool} from './comparison-analytics-pool.js';

function parallelExecutor({parallelism=1,analytics_worker_heap_mib=128,affinity_plan=null},hooks){
  if(!Number.isInteger(parallelism)||parallelism<1||parallelism>100)throw new RangeError('Comparison parallelism must be between 1 and 100');
  const cancellationGuard=()=>{if(hooks.cancelled?.())throw new Error('Research cancelled');};
  let activeGuard=cancellationGuard,work=null,latest={},pool=null;
  const idle={worker_limit:parallelism,active_workers:0,batch_completed_symbols:0,batch_total_symbols:0,batch_timestamp:null};
  let parallel={...idle};
  const publish=()=>hooks.onProgress?.({...latest,parallelism:{...parallel,batch_timestamp:work?.batch_timestamp??null,...(affinity_plan&&pool?{workers:pool.snapshot().workers}:{})}});
  return {
    async run(dataset,options,{phase='backtest',offset=0,weight=1}={}){
      activeGuard();
      if(!pool&&(parallelism>1||affinity_plan))pool=(hooks.poolFactory||((config)=>new ComparisonAnalyticsPool(config)))({
        workerLimit:parallelism,workerHeapMiB:analytics_worker_heap_mib,affinityPlan:affinity_plan,guard:()=>activeGuard(),
        onProgress:status=>{parallel=status;publish();},onWorkerEvent:hooks.onWorkerEvent,
      });
      work=null;parallel={...idle};latest={phase,progress:offset,phase_progress:0,processed_bars:0};publish();
      const iterator=backtestSteps(dataset,options,{
        cancelled:hooks.cancelled,onProgress:value=>{latest={...value,phase,phase_progress:value.progress,progress:offset+value.progress*weight};publish();},
      });
      try{
        let step=iterator.next();
        while(!step.done){
          work=step.value;activeGuard=work.guard;activeGuard();
          const phaseProgress=work.processed_bars/work.total_bars;
          latest={phase,phase_progress:phaseProgress,progress:offset+phaseProgress*weight,processed_bars:work.processed_bars,total_bars:work.total_bars};
          let values;
          if(pool)values=await pool.evaluate(work.tasks,{strategy_options:work.strategy_options,phase});
          else{
            parallel={...idle,active_workers:1,batch_total_symbols:work.tasks.length};publish();
            values=work.tasks.map(task=>evaluateComparisonTask(task,work.strategy_options));
            parallel={...parallel,active_workers:0,batch_completed_symbols:work.tasks.length};
          }
          // Reject expired/cancelled work before it can update the portfolio.
          activeGuard();
          // The next generator step may process many candles requiring no
          // analytics. Its cumulative progress must not retain this old batch.
          work=null;parallel={...idle};step=iterator.next(values);
        }
        activeGuard();return step.value;
      }catch(error){if(error&&typeof error==='object')error.phase=phase;throw error;}
      finally{iterator.return();activeGuard=cancellationGuard;}
    },
    async close(reportRetirement=false){
      await pool?.close();
      if(reportRetirement){work=null;parallel={...idle};publish();cancellationGuard();}
    },
  };
}

/** One exact chronological backtest; only closed-candle analytics use threads. */
export async function runBacktestParallel(dataset,options={},hooks={}){
  const {parallelism=1,analytics_worker_heap_mib=128,affinity_plan=null,cpu_affinity,...common}=options;
  const executor=parallelExecutor({parallelism,analytics_worker_heap_mib,affinity_plan},hooks);let complete=false;
  try{
    const report=await executor.run(dataset,common,{phase:hooks.phase??'backtest'});complete=true;return report;
  }finally{await executor.close(complete);}
}

/** Both variants share the pool, but retain their independent portfolio reports. */
export async function compareStrategiesParallel(dataset,options={},hooks={}){
  const {parallelism=1,analytics_worker_heap_mib=128,affinity_plan=null,cpu_affinity,baseline_options={},enhanced_options={enhanced_signals:true},...common}=options;
  const executor=parallelExecutor({parallelism,analytics_worker_heap_mib,affinity_plan},hooks);
  try{
    const baseline=await executor.run(dataset,{...common,strategy_options:{...baseline_options,enhanced_signals:false}},{phase:'baseline',offset:0,weight:.5});
    const enhanced=await executor.run(dataset,{...common,strategy_options:{...enhanced_options,enhanced_signals:true}},{phase:'enhanced',offset:.5,weight:.5});
    return comparisonReport(baseline,enhanced);
  }finally{await executor.close();}
}
