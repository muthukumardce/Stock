/** Bounded offline parameter comparison. No account, config, or order access. */
import {performance} from 'node:perf_hooks';
import {runBacktest,MAX_RESEARCH_RUNTIME_MS,MAX_RESEARCH_BARS} from './backtest.js';
import {runBacktestParallel} from './backtest-parallel.js';
import {ENHANCED_DEFAULTS} from './strategy.js';
import {dateIST,parseTime} from './util.js';

const KEYS=['min_signal_score','min_adx','min_setup_volume','max_atr_extension'];
const PARAMETER_GRID=[['min_signal_score',5,0,100],['min_adx',3,.1,60],['min_setup_volume',.2,.1,10],['max_atr_extension',.4,.1,10]];
export const MAX_OPTIMIZATION_CANDIDATES=100;
const DEFAULTS={max_candidates:9,max_runtime_ms:600000,min_trades:10,max_drawdown_pct:5};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const ACTIVE_PROGRESS_MAX=0.999999;
const dayOf=row=>{const time=parseTime(row?.time??row?.date);return time?dateIST(time):null;};
const invalid=reason=>({eligible:false,reason,ranges:{}});

export function optimizationPlan(datasets){
  if(!Array.isArray(datasets)||datasets.length<1||datasets.length>2)return invalid('Optimization requires one or two historical datasets.');
  const ranges={},seen=new Set();
  for(const dataset of datasets){
    if(!dataset||!['5minute','day'].includes(dataset.interval)||seen.has(dataset.interval)||!dataset.symbols||typeof dataset.symbols!=='object'||Array.isArray(dataset.symbols))return invalid('Use one dataset for each enabled intraday or swing interval.');
    seen.add(dataset.interval);
    const rows=Object.values(dataset.symbols);
    if(!rows.length||rows.some(series=>!Array.isArray(series)||!series.length)||rows.reduce((total,series)=>total+series.length,0)>MAX_RESEARCH_BARS)return invalid('Each interval needs a nonempty bounded symbol dataset.');
    const observed=new Set();
    for(const series of rows)for(const row of series){const date=dayOf(row);if(date===null)return invalid('Historical timestamps must be valid before optimization.');observed.add(date);}
    const dates=[...observed].sort(),minimum=dataset.interval==='day'?100:25;
    if(dates.length<minimum)return invalid(`${dataset.interval==='day'?'Swing':'Intraday'} optimization needs at least ${minimum} observed sessions; only ${dates.length} are available.`);
    const first=Math.floor(dates.length*.6),second=Math.floor(dates.length*.8);
    ranges[dataset.interval]={train:{from:dates[0],to:dates[first-1]},validation:{from:dates[first],to:dates[second-1]},test:{from:dates[second],to:dates.at(-1)}};
  }
  return {eligible:true,reason:'Separate chronological training, validation and final-test windows are available.',ranges};
}

function limitsFor(tuning={}){
  const limits={...DEFAULTS,...tuning};
  if(!Number.isInteger(limits.max_candidates)||limits.max_candidates<3||limits.max_candidates>MAX_OPTIMIZATION_CANDIDATES)throw new RangeError('Optimization permits 3 to 100 candidates, including the incumbent.');
  if(!Number.isInteger(limits.max_runtime_ms)||limits.max_runtime_ms<1||limits.max_runtime_ms>1800000)throw new RangeError('Optimization runtime must be positive and at most 30 minutes.');
  if(!Number.isInteger(limits.min_trades)||limits.min_trades<1||limits.min_trades>10000)throw new RangeError('Optimization needs a positive bounded minimum trade count.');
  if(!finite(limits.max_drawdown_pct)||limits.max_drawdown_pct<=0||limits.max_drawdown_pct>100)throw new RangeError('Optimization drawdown limit must be greater than zero and at most 100 percent.');
  return Object.fromEntries(Object.keys(DEFAULTS).map(key=>[key,limits[key]]));
}

function catalogue(incumbent,limit){
  const trials=[{id:'incumbent',parameters:{},status:'incumbent',reason:'Current strategy parameters.'}],seen=new Set([JSON.stringify(KEYS.map(key=>incumbent[key]))]);
  const finish=()=>trials.map((trial,index)=>({...trial,parameter_set_id:`P${index+1}`,effective_parameters:Object.fromEntries(KEYS.map(key=>[key,trial.parameters[key]??incumbent[key]]))}));
  const add=offsets=>{
    const parameters={};
    for(let index=0;index<KEYS.length;index++)if(offsets[index]){
      const [key,step,min,max]=PARAMETER_GRID[index],value=Math.round(Math.max(min,Math.min(max,incumbent[key]+offsets[index]*step))*1000000)/1000000;
      if(value!==incumbent[key])parameters[key]=value;
    }
    const identity=JSON.stringify(KEYS.map(name=>parameters[name]??incumbent[name]));
    if(seen.has(identity))return;seen.add(identity);
    trials.push({id:`candidate_${trials.length}`,parameters,status:'pending',reason:'Not evaluated.'});
  };
  // Preserve the original incumbent + 16 single-threshold candidates first.
  // Every subsequent combination and its order is fixed before reading returns.
  for(const multiplier of [1,2])for(let index=0;index<KEYS.length;index++)for(const sign of [1,-1]){
    if(trials.length>=limit)return finish();
    const offsets=[0,0,0,0];offsets[index]=sign*multiplier;add(offsets);
  }
  for(const radius of [1,2,3,4])for(let a=-radius;a<=radius;a++)for(let b=-radius;b<=radius;b++)for(let c=-radius;c<=radius;c++)for(let d=-radius;d<=radius;d++){
    if(trials.length>=limit)return finish();
    const offsets=[a,b,c,d];if(offsets.filter(Boolean).length>=2)add(offsets);
  }
  return finish();
}

function windowDataset(dataset,to){
  const rows=series=>(series||[]).filter(row=>dayOf(row)<=to);
  const symbols=Object.fromEntries(Object.entries(dataset.symbols).map(([symbol,series])=>[symbol,rows(series)]).filter(([,series])=>series.length));
  const sector_bars=Object.fromEntries(Object.entries(dataset.sector_bars||{}).map(([name,series])=>[name,rows(series)]));
  const symbol_sectors=Object.fromEntries(Object.entries(dataset.symbol_sectors||{}).filter(([symbol,name])=>Object.hasOwn(symbols,symbol)&&Object.hasOwn(sector_bars,name)));
  return {...dataset,symbols,benchmark_bars:rows(dataset.benchmark_bars),sector_bars,symbol_sectors};
}

function stageResult(report,limits){
  const metrics={...report.metrics},quality=report.data_quality||{},gapTrades=(report.trades||[]).filter(trade=>trade.data_gap).length;
  let reason=null;
  if(!['net_pnl','net_return_pct','max_drawdown_pct','trade_count','open_positions'].every(key=>finite(metrics[key])))reason='The simulation did not produce finite performance metrics.';
  else if(quality.completed_result!==true||(quality.unresolved_intraday_positions||[]).length)reason='The scoring period contains unresolved intraday exposure.';
  else if(metrics.open_positions!==0)reason='The scoring window ends with open positions; unrealised marks cannot qualify for promotion.';
  else if(gapTrades)reason='A scored trade crossed missing market data; this candidate is not eligible for promotion.';
  else if(metrics.trade_count<limits.min_trades)reason=`At least ${limits.min_trades} closed trades are required in each scoring period.`;
  else if(metrics.net_pnl<=0)reason='Net performance after the unchanged costs was not positive.';
  else if(!finite(metrics.profit_factor)||metrics.profit_factor<=1)reason='A finite profit factor above one is required.';
  else if(metrics.max_drawdown_pct>limits.max_drawdown_pct)reason='Drawdown exceeded the fixed optimization ceiling.';
  return {metrics,data_quality:{gap_count:Number(quality.gap_count)||0,affected_symbol_sessions:Number(quality.affected_symbol_sessions)||0,
    unresolved_intraday_positions:[...(quality.unresolved_intraday_positions||[])],completed_result:quality.completed_result===true,gap_affected_trades:gapTrades,eligible:reason===null,reason}};
}
const qualityFailure=stage=>Object.entries(stage).find(([,result])=>!result.data_quality.eligible);
function beats(stage,incumbent){
  const failure=qualityFailure(stage);if(failure)return `${failure[0]}: ${failure[1].data_quality.reason}`;
  for(const [interval,result] of Object.entries(stage)){
    const before=incumbent[interval]?.metrics,after=result.metrics;
    if(!before||!finite(before.net_pnl)||!finite(before.max_drawdown_pct)||!finite(before.open_positions))return `${interval}: incumbent comparison metrics are unavailable.`;
    const quality=incumbent[interval].data_quality;
    if(quality.completed_result!==true||quality.unresolved_intraday_positions.length||quality.gap_affected_trades||before.open_positions!==0)return `${interval}: the incumbent comparison contains unresolved exposure, open positions or gap-affected trades.`;
    if(after.net_pnl<=before.net_pnl)return `${interval}: net performance did not improve on the incumbent.`;
    if(after.max_drawdown_pct>before.max_drawdown_pct+1e-10)return `${interval}: drawdown worsened relative to the incumbent.`;
  }
  return null;
}
const rank=stage=>Object.values(stage).reduce((score,result)=>score+result.metrics.net_return_pct,0);

function stateFor(datasets,options,hooks){
  if(options.final_test_allowed!==undefined&&typeof options.final_test_allowed!=='boolean')throw new TypeError('Final-test permission must be a boolean.');
  const finalTestAllowed=options.final_test_allowed??true;
  const clock=hooks.now||(()=>performance.now()),started=clock(),limits=limitsFor(options.tuning),plan=optimizationPlan(datasets);
  const incumbent={...ENHANCED_DEFAULTS,...options.strategy_options};
  const result={status:'insufficient_data',reason:plan.reason,parameters:null,incumbent_parameters:{...incumbent},trials:[],selected_id:null,ranges:plan.ranges,limits,elapsed_ms:0,holdout_consumed:false,final_test_allowed:finalTestAllowed};
  const finish=(status,reason)=>{
    const failed_trials=result.trials.filter(trial=>trial.error).length;
    return {...result,status:status==='no_improvement'&&failed_trials?'completed_with_errors':status,
      reason:reason+(failed_trials?` ${failed_trials} parameter set${failed_trials===1?' had a calculation error':'s had calculation errors'}; other completed results were retained.`:''),
      failed_trials,elapsed_ms:Math.max(0,Math.round(clock()-started))};
  };
  if(!plan.eligible)return {early:finish('insufficient_data',plan.reason)};
  if(incumbent.enhanced_signals!==true||KEYS.some(key=>!finite(incumbent[key])))return {early:finish('insufficient_data','Numeric parameter tuning requires valid enabled enhanced-strategy settings.')};
  const {tuning,strategy_options,score_from,score_to,baseline_options,enhanced_options,parallelism,worker_heap_mib,threads_per_process,analytics_worker_heap_mib,memory_reserve_mib,startup_memory_mib,max_initializing_processes,final_test_allowed,affinity_plan,cpu_affinity,...common}=options;
  common.max_bars??=MAX_RESEARCH_BARS;
  const trials=catalogue(incumbent,limits.max_candidates);result.trials=trials;
  function guard(){
    if(hooks.cancelled?.())throw Object.assign(new Error('Optimization cancelled'),{name:'AbortError'});
    if(clock()-started>=limits.max_runtime_ms)throw Object.assign(new Error('Optimization budget exhausted'),{optimizationBudget:true});
  }
  return {clock,started,limits,result,finish,guard,trials,context:{datasets,common,incumbent,limits,ranges:plan.ranges},remaining:()=>Math.floor(limits.max_runtime_ms-(clock()-started))};
}

/** Both executors use the same phase barriers and deterministic selection. */
function* selection(state){
    const {trials,result,finish}=state;
    yield {phase:'tuning_train',trials};
    const incumbentTrial=trials[0];
    if(incumbentTrial.error)return finish('completed_with_errors','The starting set could not finish training. Other training results are available, but automatic comparison requires the starting set.');
    const shortlisted=trials.slice(1).filter(trial=>trial.status==='trained').sort((a,b)=>rank(b.train)-rank(a.train)||a.id.localeCompare(b.id)).slice(0,3);
    if(!shortlisted.length)return finish('no_improvement','No challenger passed the fixed training profit, activity, drawdown and data checks.');
    const validation=[incumbentTrial,...shortlisted];
    yield {phase:'tuning_validation',trials:validation};
    if(incumbentTrial.error){
      for(const trial of shortlisted)if(!trial.error){trial.status='comparison_unavailable';trial.reason='Validation completed, but the starting-set comparison had a calculation error.';}
      return finish('completed_with_errors','Validation results were retained. The starting-set validation failed, so no candidate can qualify automatically.');
    }
    for(const trial of validation){
      if(trial!==incumbentTrial&&!trial.error){const reason=beats(trial.validation,incumbentTrial.validation);trial.status=reason?'validation_failed':'shortlisted';trial.reason=reason||'Validation improved net performance without worsening drawdown in every interval.';}
    }
    const finalist=shortlisted.filter(trial=>trial.status==='shortlisted').sort((a,b)=>rank(b.validation)-rank(a.validation)||a.id.localeCompare(b.id))[0];
    if(!finalist)return finish('no_improvement','No trained challenger improved on the incumbent and passed every validation requirement.');
    result.selected_id=finalist.id;
    if(!result.final_test_allowed){
      finalist.status='final_test_pending';finalist.reason='Training and validation passed, but fresh final-test dates are required before automatic qualification.';
      return finish('waiting_for_fresh_data','Training and validation selected a challenger. Fresh final-test dates are required; no final test ran and no automatic parameter change is eligible.');
    }
    finalist.status='finalist';result.holdout_consumed=true;
    yield {phase:'tuning_test',trials:[incumbentTrial,finalist]};
    if(incumbentTrial.error||finalist.error){
      if(!finalist.error){finalist.status='comparison_unavailable';finalist.reason='Final test completed, but the starting-set comparison had a calculation error.';}
      return finish('completed_with_errors','The final-test comparison could not finish. No settings are promoted and no alternative is tried against the reserved final test.');
    }
    const rejected=beats(finalist.test,incumbentTrial.test);
    if(rejected){finalist.status='test_failed';finalist.reason=rejected;return finish('no_improvement','The single selected challenger failed the final test. No alternative was tried against that holdout.');}
    finalist.status='accepted';finalist.reason='The selected challenger passed final-test requirements in every interval.';result.parameters={...finalist.parameters};
    return finish('accepted','A bounded challenger passed training, validation and one final test. This does not establish future profitability.');
}

function recordStage(trial,phase,stage){
  const name=phase.replace('tuning_','');trial[name]=stage;
  if(name==='train'){
    const failure=qualityFailure(stage);
    trial.status=trial.id==='incumbent'?'incumbent':failure?'rejected':'trained';
    trial.reason=failure?`${failure[0]}: ${failure[1].data_quality.reason}`:'Training checks passed.';
  }
}

function recordFailure(trial,phase,error){
  if(error?.optimizationBudget||error?.name==='AbortError')throw error;
  const name=phase.replace('tuning_',''),code=typeof error?.code==='string'&&/^[a-z_]{1,64}$/.test(error.code)?error.code:'candidate_error';
  const message=String(error?.message||'Candidate calculation failed.').replace(/\s+/g,' ').slice(0,1000);
  trial.status='error';trial.error={phase:name,code,message,...(['5minute','day'].includes(error?.interval)?{interval:error.interval}:{})};
  trial.reason=`${name} calculation failed${trial.error.interval?` (${trial.error.interval})`:''}: ${message}`;
}

function progressFor(state,batch,completed,parallelism){
  const name=batch.phase.replace('tuning_',''),base=name==='train'?0:name==='validation'?.6:.85,weight=name==='train'?.6:name==='validation'?.25:.15;
  // Each parameter set has equal phase weight. Unsettled tasks cannot count as
  // a full result even when the last candle has already been processed.
  const active=(parallelism.active_sets||[]).filter(set=>set.phase===batch.phase).reduce((total,set)=>total+(finite(set.progress)?Math.max(0,Math.min(ACTIVE_PROGRESS_MAX,set.progress)):0),0);
  const fraction=Math.min(batch.trials.length,completed+active)/batch.trials.length;
  return {phase:batch.phase,progress:base+weight*fraction,trial:Math.max(1,Math.min(batch.trials.length,completed+1)),trial_count:batch.trials.length,
    message:`${name}: ${completed} of ${batch.trials.length} parameter sets finished.${parallelism.failed_tasks?` ${parallelism.failed_tasks} had calculation errors; ${completed<batch.trials.length?'other sets continue':'other completed results were retained'}.`:''}`,parallelism,trials:structuredClone(state.trials)};
}

/** Shared scoring and guard coroutine for serial and internally parallel tasks. */
function* optimizationTaskSteps(context,task,hooks={}){
  const clock=hooks.now||(()=>performance.now()),started=clock(),stage={},name=task.phase.replace('tuning_','');
  const remaining=()=>task.remaining_ms-(clock()-started);
  const guard=()=>{if(hooks.cancelled?.())throw Object.assign(new Error('Optimization cancelled'),{name:'AbortError'});if(remaining()<100)throw Object.assign(new Error('Optimization budget exhausted'),{optimizationBudget:true});};
  const totalIntervals=context.datasets.length;let lastProgress=0,nestedParallelism;
  // Scopes have equal task weight. Bar counters cover the current interval,
  // including real indicator warmup work, and reset when the interval changes.
  const emit=(interval,index,processed,total,complete=false)=>{
    const fraction=total?processed/total:0,value=complete?(index+1)/totalIntervals:(index+fraction)/totalIntervals;
    lastProgress=Math.max(lastProgress,complete?value:Math.min(ACTIVE_PROGRESS_MAX,value));
    hooks.onProgress?.({progress:lastProgress,interval,processed_bars:processed,total_bars:total,completed_intervals:index+(complete?1:0),total_intervals:totalIntervals,
      ...(nestedParallelism?{parallelism:nestedParallelism}:{})});
  };
  for(const [index,dataset] of context.datasets.entries()){
    guard();hooks.onInterval?.(dataset.interval);
    try{
      const range=context.ranges[dataset.interval][name],window=windowDataset(dataset,range.to);guard();
      const totalBars=Object.values(window.symbols).reduce((total,rows)=>total+rows.length,0);let processedBars=0;
      nestedParallelism=undefined;emit(dataset.interval,index,0,totalBars);
      const report=yield {dataset:window,options:{...context.common,strategy_options:{...context.incumbent,...task.trial.parameters},score_from:range.from,score_to:range.to,max_runtime_ms:Math.min(MAX_RESEARCH_RUNTIME_MS,Math.floor(remaining()))},
        hooks:{cancelled:()=>Boolean(hooks.cancelled?.())||remaining()<=0,onProgress:update=>{
          if(update?.parallelism&&typeof update.parallelism==='object')nestedParallelism=update.parallelism;
          // Pool startup/retirement can advance thread state without bar counts.
          if(update?.parallelism&&update.total_bars===undefined){emit(dataset.interval,index,processedBars,totalBars);return;}
          if(!Number.isInteger(update?.processed_bars)||!Number.isInteger(update?.total_bars)||update.total_bars!==totalBars||update.processed_bars<0||update.processed_bars>totalBars)return;
          processedBars=Math.max(processedBars,update.processed_bars);emit(dataset.interval,index,processedBars,totalBars);
        }}};
      stage[dataset.interval]=stageResult(report,context.limits);guard();
      emit(dataset.interval,index,totalBars,totalBars,true);
    }catch(error){
      guard(); // Cancellation and the overall deadline still stop the run.
      if(error?.optimizationBudget||error?.name==='AbortError')throw error;
      throw Object.assign(new Error(error?.message||'Candidate calculation failed.'),{code:error?.message==='Backtest runtime limit exceeded; use a smaller dataset'?'candidate_timeout':error?.code,interval:dataset.interval});
    }
  }
  return stage;
}

/** A serial worker receives immutable context once, then only bounded tasks. */
export function evaluateOptimizationTask(context,task,hooks={}){
  const steps=optimizationTaskSteps(context,task,hooks);let step=steps.next();
  try{
    while(!step.done){
      const request=step.value;let report;
      try{report=(hooks.runBacktest||runBacktest)(request.dataset,request.options,request.hooks);}
      catch(error){step=steps.throw(error);continue;}
      step=steps.next(report);
    }
    return step.value;
  }finally{steps.return();}
}

/** One candidate process delegates stock analytics to its own bounded pool. */
export async function evaluateOptimizationTaskParallel(context,task,hooks={}){
  const resources={parallelism:hooks.parallelism??task.parallelism??1,
    affinity_plan:hooks.affinity_plan??task.affinity_plan??{mode:'automatic',status:'automatic',reason:'The operating system schedules candidate analytics workers.',assignments:[]},
    analytics_worker_heap_mib:hooks.analytics_worker_heap_mib??task.analytics_worker_heap_mib??128};
  const steps=optimizationTaskSteps(context,task,hooks);let step=steps.next();
  try{
    while(!step.done){
      const request=step.value;let report;
      try{report=await (hooks.runBacktestParallel||runBacktestParallel)(request.dataset,{...request.options,...resources},{...request.hooks,phase:task.phase,
        poolFactory:hooks.poolFactory,onWorkerEvent:hooks.onWorkerEvent});}
      catch(error){step=steps.throw(error);continue;}
      step=steps.next(report);
    }
    return step.value;
  }finally{steps.return();}
}

const exhausted=state=>state.finish('budget_exhausted','The bounded research budget ended; no parameter change is eligible.');

/** Synchronous compatibility API, using exactly the same selection rules. */
export function optimizeStrategies(datasets,options={},hooks={}){
  const state=stateFor(datasets,options,hooks);if(state.early)return state.early;
  const plan=selection(state);let step=plan.next();
  try{
    while(!step.done){
      const batch=step.value;let completed=0,failed=0;
      for(const trial of batch.trials){
        const active={parameter_set_id:trial.parameter_set_id,phase:batch.phase,progress:0,processed_bars:0,total_bars:0,completed_intervals:0,total_intervals:state.context.datasets.length};
        const publish=()=>hooks.onProgress?.(progressFor(state,batch,completed,{worker_limit:1,active_workers:1,completed_tasks:completed,failed_tasks:failed,total_tasks:batch.trials.length,active_sets:[{...active}]}));
        state.guard();publish();
        try{
          const stage=evaluateOptimizationTask(state.context,{trial,phase:batch.phase,remaining_ms:state.remaining()},{...hooks,onProgress:update=>{Object.assign(active,update);publish();}});
          state.guard();recordStage(trial,batch.phase,stage);
        }catch(error){state.guard();recordFailure(trial,batch.phase,error);failed++;}
        completed++;
        hooks.onProgress?.(progressFor(state,batch,completed,{worker_limit:1,active_workers:0,completed_tasks:completed,failed_tasks:failed,total_tasks:batch.trials.length,active_sets:[]}));
      }
      step=plan.next();
    }
    return step.value;
  }catch(error){if(error.optimizationBudget)return exhausted(state);throw error;}
}

/** Real CPU parallelism; phase barriers prevent completion order influencing selection. */
export async function optimizeStrategiesParallel(datasets,options={},hooks={}){
  const state=stateFor(datasets,options,hooks);if(state.early)return state.early;
  const requested=typeof options.parallelism==='object'?options.parallelism?.worker_limit:options.parallelism;
  const workerLimit=Math.min(MAX_OPTIMIZATION_CANDIDATES,state.trials.length,Math.max(1,Number.isInteger(requested)?requested:1));
  const {OptimizerProcessPool}=await import('./optimizer-process-pool.js');
  let pool;
  try{
    const symbols=Math.max(...datasets.map(dataset=>Object.keys(dataset.symbols??{}).length));
    const availableAssignments=options.affinity_plan?.status==='planned'?Math.floor(options.affinity_plan.assignments.length/workerLimit):4;
    const threadsPerProcess=options.threads_per_process??Math.max(1,Math.min(4,symbols,availableAssignments));
    state.guard();pool=(hooks.poolFactory||((context,settings)=>new OptimizerProcessPool(context,settings)))(state.context,{workerLimit,threadsPerProcess,workerHeapMiB:options.worker_heap_mib,analyticsWorkerHeapMiB:options.analytics_worker_heap_mib,
      memoryReserveMiB:options.memory_reserve_mib,startupMemoryMiB:options.startup_memory_mib,maxInitializing:options.max_initializing_processes,
      affinityPlan:options.affinity_plan,guard:state.guard,onWorkerEvent:hooks.onWorkerEvent});
    const plan=selection(state);let step=plan.next();
    while(!step.done){
      const batch=step.value;
      await pool.runBatch(batch.trials.map(trial=>({trial,phase:batch.phase})),{
        prepare:task=>({...task,remaining_ms:state.remaining()}),
        onComplete:(task,stage)=>{state.guard();recordStage(task.trial,batch.phase,stage);},
        onFailure:(task,error)=>{state.guard();recordFailure(task.trial,batch.phase,error);},
        onProgress:parallelism=>hooks.onProgress?.(progressFor(state,batch,parallelism.completed_tasks,parallelism)),
      });
      state.guard();step=plan.next();
    }
    return step.value;
  }catch(error){if(error.optimizationBudget)return exhausted(state);throw error;}
  finally{await pool?.close();}
}
