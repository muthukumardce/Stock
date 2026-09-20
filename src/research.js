/** One cancellable CPU worker, separate from the live execution event loop. */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {MAX_COMPARISON_RUNTIME_MS,MAX_RESEARCH_BARS} from './backtest.js';
import {detectCapacity} from './capacity.js';
import {planResearchAffinity} from './cpu-affinity.js';
import {affinityRecord,workerAffinityRecords} from './research-affinity-state.js';
import {candidateProcessCapacity,MAX_CANDIDATE_ANALYTICS_THREADS} from './research-process-capacity.js';
import {ResearchProcessLifecycle} from './research-process-lifecycle.js';

const TUNABLE_KEYS=['min_signal_score','min_adx','min_setup_volume','max_atr_extension'];
const MAX_CANDIDATES=100,MAX_TOTAL_BARS=MAX_RESEARCH_BARS*2;
export const COMPARISON_RUNTIME_POLICY='bars-v4-total-market';
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const numericParameters=value=>plain(value)?Object.fromEntries(TUNABLE_KEYS.filter(key=>Number.isFinite(value[key])).map(key=>[key,value[key]])):{};
const timeoutPhases=['validating','baseline','enhanced','tuning_train','tuning_validation','tuning_test'];
function timeoutDetails(job,value,budget,kind) {
  const detail=plain(value)?value:{},phase=timeoutPhases.includes(detail.phase)?detail.phase:timeoutPhases.includes(job.phase)?job.phase:'validating';
  const validCounts=source=>['processed_bars','total_bars'].every(key=>Number.isSafeInteger(source[key])&&source[key]>=0&&source[key]<=MAX_TOTAL_BARS)&&source.processed_bars<=source.total_bars;
  const counts=validCounts(detail)?detail:validCounts(job)?job:{processed_bars:0,total_bars:0};
  const result={phase,budget_ms:budget,processed_bars:counts.processed_bars,total_bars:counts.total_bars,kind};
  if(Number.isSafeInteger(detail.elapsed_ms)&&detail.elapsed_ms>=0&&detail.elapsed_ms<=MAX_COMPARISON_RUNTIME_MS*2+60000)result.elapsed_ms=detail.elapsed_ms;
  return result;
}
function activeSetProgress(item,capacity){
  const result={
    parameter_set_id:typeof item.parameter_set_id==='string'&&/^P(?:[1-9]|[1-9][0-9]|100)$/.test(item.parameter_set_id)?item.parameter_set_id:null,
    phase:['tuning_train','tuning_validation','tuning_test'].includes(item.phase)?item.phase:null,
    interval:['5minute','day'].includes(item.interval)?item.interval:null,
  };
  const bars=['processed_bars','total_bars'].every(key=>Number.isSafeInteger(item[key])&&item[key]>=0&&item[key]<=MAX_RESEARCH_BARS)&&item.processed_bars<=item.total_bars;
  const intervals=Number.isSafeInteger(item.completed_intervals)&&Number.isSafeInteger(item.total_intervals)&&item.total_intervals>=1&&item.total_intervals<=2&&item.completed_intervals>=0&&item.completed_intervals<=item.total_intervals;
  if(bars){result.processed_bars=item.processed_bars;result.total_bars=item.total_bars;}
  if(intervals){result.completed_intervals=item.completed_intervals;result.total_intervals=item.total_intervals;}
  if(Number.isFinite(item.progress)&&item.progress>=0&&item.progress<=1&&(item.progress!==1||bars&&intervals&&item.processed_bars===item.total_bars&&item.completed_intervals===item.total_intervals))result.progress=item.progress;
  if(Number.isSafeInteger(item.worker_id)&&item.worker_id>0)result.worker_id=item.worker_id;
  const affinity=affinityRecord(item.affinity);if(affinity)result.affinity=affinity;
  if(Number.isSafeInteger(item.process_id)&&item.process_id>0)result.process_id=item.process_id;
  if(Number.isSafeInteger(item.thread_limit)&&item.thread_limit>=1&&item.thread_limit<=capacity.threads_per_process)result.thread_limit=item.thread_limit;
  if(Number.isSafeInteger(item.active_threads)&&item.active_threads>=0&&item.active_threads<=(result.thread_limit??capacity.threads_per_process))result.active_threads=item.active_threads;
  const workers=workerAffinityRecords(item.workers,capacity.threads_per_process);if(workers)result.workers=workers;
  return result;
}
function comparisonProgress(pool,value,capacity){
  if(Number.isSafeInteger(value.active_workers)&&value.active_workers>=0&&value.active_workers<=capacity.worker_limit)pool.active_workers=value.active_workers;
  const completed=value.batch_completed_symbols??pool.batch_completed_symbols,total=value.batch_total_symbols??pool.batch_total_symbols;
  if(Number.isSafeInteger(completed)&&Number.isSafeInteger(total)&&completed>=0&&total>=completed&&total<=capacity.symbol_count){pool.batch_completed_symbols=completed;pool.batch_total_symbols=total;}
  const at=value.batch_timestamp;
  if(at===null||Number.isSafeInteger(at)&&at>=0&&at<=8640000000000000
    ||typeof at==='string'&&at.length<=40&&/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(at)&&Number.isFinite(Date.parse(at)))pool.batch_timestamp=at;
}
function trialProgress(value){
  if(!Array.isArray(value))return null;
  return value.slice(0,MAX_CANDIDATES).filter(plain).map(trial=>{
    const result={parameters:numericParameters(trial.parameters),effective_parameters:numericParameters(trial.effective_parameters)};
    for(const key of ['id','parameter_set_id','status'])if(typeof trial[key]==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(trial[key]))result[key]=trial[key];
    if(typeof trial.reason==='string')result.reason=trial.reason.slice(0,1000);
    if(plain(trial.error)){
      result.error={};
      if(typeof trial.error.message==='string')result.error.message=trial.error.message.slice(0,1000);
      if(typeof trial.error.code==='string'&&/^[a-z_]{1,64}$/.test(trial.error.code))result.error.code=trial.error.code;
      if(['train','validation','test'].includes(trial.error.phase))result.error.phase=trial.error.phase;
      if(['5minute','day'].includes(trial.error.interval))result.error.interval=trial.error.interval;
    }
    for(const phase of ['train','validation','test'])if(plain(trial[phase])){
      result[phase]={};
      for(const interval of ['5minute','day']){
        const stage=trial[phase][interval];if(!plain(stage))continue;
        const metrics={};for(const key of ['net_pnl','net_return_pct','max_drawdown_pct','trade_count','win_rate_pct','expectancy','profit_factor'])if(Number.isFinite(stage.metrics?.[key])||stage.metrics?.[key]===null)metrics[key]=stage.metrics[key];
        const data_quality={};for(const key of ['eligible','completed_result'])if(typeof stage.data_quality?.[key]==='boolean')data_quality[key]=stage.data_quality[key];
        for(const key of ['gap_count','affected_symbol_sessions','gap_affected_trades'])if(Number.isSafeInteger(stage.data_quality?.[key])&&stage.data_quality[key]>=0)data_quality[key]=stage.data_quality[key];
        if(typeof stage.data_quality?.reason==='string')data_quality.reason=stage.data_quality.reason.slice(0,1000);
        result[phase][interval]={metrics,data_quality};
      }
    }
    return result;
  });
}

function datasetSize(dataset,maxBars=MAX_RESEARCH_BARS) {
  const rows=Object.values(dataset?.symbols??{}),contextRows=[dataset?.benchmark_bars??[],...Object.values(dataset?.sector_bars??{})];
  const allRows=[...rows,...contextRows];
  const total=allRows.reduce((count,rows)=>count+(Array.isArray(rows)?rows.length:0),0);
  if(!rows.length||rows.length>5000||contextRows.length>101||allRows.some(rows=>!Array.isArray(rows))||total>maxBars)throw new Error(`Research requires at most ${maxBars} total symbol/context bars, 5000 symbols and 100 sector series`);
  return {bars:rows.reduce((count,rows)=>count+rows.length,0),total,symbols:rows.length};
}
function tuningOptions(value={}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['max_candidates','max_runtime_ms','min_trades','max_drawdown_pct'].includes(key)))throw new TypeError('Invalid tuning limits');
  const result={max_candidates:9,max_runtime_ms:600000,min_trades:10,max_drawdown_pct:5,...value};
  if(!Number.isInteger(result.max_candidates)||result.max_candidates<3||result.max_candidates>MAX_CANDIDATES)throw new RangeError(`Tuning candidate count must be between 3 and ${MAX_CANDIDATES}`);
  if(!Number.isInteger(result.max_runtime_ms)||result.max_runtime_ms<60000||result.max_runtime_ms>1800000)throw new RangeError('Tuning runtime must be between 60000 and 1800000 ms');
  if(!Number.isInteger(result.min_trades)||result.min_trades<1||result.min_trades>10000)throw new RangeError('Tuning minimum trades must be between 1 and 10000');
  if(!Number.isFinite(result.max_drawdown_pct)||result.max_drawdown_pct<=0||result.max_drawdown_pct>100)throw new RangeError('Tuning drawdown limit must be greater than zero and at most 100 percent');
  return result;
}
// Each coordinator/trial retains its input copy plus normalized candles and
// chronological events. Scale the V8 heap allowance by total dataset size;
// reserve another 256 MiB per worker for young generation and native overhead.
const workerHeapMiB=total=>Math.min(12288,Math.max(512,Math.ceil(total/250000)*512));
function barLimit(value=250000){
  if(!Number.isInteger(value)||value<1||value>MAX_RESEARCH_BARS)throw new RangeError(`Maximum bars must be between 1 and ${MAX_RESEARCH_BARS}`);
  return value;
}

export class ResearchService {
  constructor({workerFactory=(url,options)=>new Worker(url,options),setTimer=setTimeout,clearTimer=clearTimeout,capacityDetector=detectCapacity,affinityPlanner=planResearchAffinity,freeMemory=()=>os.freemem(),cancelGraceMs=1000,processLifecycle=new ResearchProcessLifecycle()}={}) {
    this._workerFactory=workerFactory;this._setTimer=setTimer;this._clearTimer=clearTimer;
    this._capacityDetector=capacityDetector;this._affinityPlanner=affinityPlanner;this._freeMemory=freeMemory;this._cancelGraceMs=cancelGraceMs;
    this._processLifecycle=processLifecycle;
    this.worker = null; this.timer = null; this.completion = null; this.resolveCompletion = null; this.job = { id: null, status: 'idle', progress: 0, result: null, error: null };
  }
  _affinity(mode,limit,reserved,live,coordinator=0){
    // Standalone simulator callers remain portable; the application supplies
    // its persisted scheduling choice explicitly for every research run.
    if(mode===undefined)return {limit,plan:null};
    if(!['pinned','automatic'].includes(mode))throw new RangeError('Research CPU scheduling must be pinned or automatic');
    const plan=this._affinityPlanner({mode,workerLimit:limit});
    if(plan.status==='planned'){
      const available=plan.available_cpus;
      if(!Number.isSafeInteger(available)||available<1||!Array.isArray(plan.assignments)||!plan.assignments.length)throw new Error('CPU affinity planning returned no usable processors');
      limit=Math.max(1,Math.min(limit,plan.assignments.length,Math.floor(available*.8)||1,available-reserved-live-coordinator));
      return {limit,plan:{...plan,assignments:plan.assignments.slice(0,limit)}};
    }
    return {limit,plan};
  }
  start(dataset, options = {}) {
    if (this.worker) throw new Error('Research is already running; cancel it before starting another run');
    if(this._processLifecycle.remaining())throw new Error('Previous candidate processes are still exiting; research cannot restart yet.');
    const {bars,total,symbols}=datasetSize(dataset,barLimit(options.max_bars));
    // This is a bounded estimate, not a completion guarantee. Include benchmark
    // and sector candles because their validation and context also require CPU.
    const budget=options.max_runtime_ms??Math.min(MAX_COMPARISON_RUNTIME_MS,Math.max(60000,total*6));
    if(!Number.isInteger(budget)||budget<100||budget>MAX_COMPARISON_RUNTIME_MS)throw new RangeError(`Maximum runtime must be between 100 and ${MAX_COMPARISON_RUNTIME_MS} ms`);
    const requested=options.parallelism??0,reserve=options.reserve_cpus??4,live=options.live_workers??0;
    if(!Number.isInteger(requested)||requested<0||requested>MAX_CANDIDATES)throw new RangeError(`Comparison parallelism must be zero (automatic) or between 1 and ${MAX_CANDIDATES}`);
    if(!Number.isInteger(reserve)||reserve<0||reserve>65536||!Number.isInteger(live)||live<0||live>65536)throw new RangeError('Comparison CPU reservations must be bounded nonnegative integers');
    const detected=this._capacityDetector(),usable=Math.max(1,Math.min(65536,Math.floor(Number(detected.available_cpus)||1))),reserved=Math.max(4,reserve);
    const cpuLimit=Math.max(1,Math.min(Math.floor(usable*.8),usable-reserved-live-1)),heapMiB=workerHeapMiB(total);
    const free=Math.max(0,Number(this._freeMemory())||0),mib=2**20,workerHeap=128,workerMemory=192*mib,coordinatorMemory=(heapMiB+256)*mib;
    const memoryReserve=Math.max(512*mib,Math.min(2048*mib,free*.2))+coordinatorMemory;
    const memoryLimit=Math.max(1,Math.floor((free-memoryReserve)/workerMemory));
    const allocation=this._affinity(options.cpu_affinity,Math.max(1,Math.min(requested||MAX_CANDIDATES,symbols,cpuLimit,memoryLimit)),reserved,live,1),limit=allocation.limit;
    const capacity={kind:'comparison',worker_limit:limit,usable_cpus:usable,cpu_target_percent:80,cpu_worker_limit:cpuLimit,reserved_cpus:reserved,coordinator_cpus:1,live_workers:live,
      memory_worker_limit:memoryLimit,available_memory_mib:Math.floor(free/mib),worker_heap_mib:workerHeap,worker_memory_mib:192,coordinator_heap_mib:heapMiB,coordinator_memory_mib:heapMiB+256,
      memory_reserve_mib:Math.ceil(memoryReserve/mib),requested_workers:requested,symbol_count:symbols,source:detected.source,...(allocation.plan?{affinity:allocation.plan}:{})};
    return this._launch({type:'comparison',dataset,options:{...options,max_runtime_ms:budget,parallelism:limit,analytics_worker_heap_mib:workerHeap,...(allocation.plan?{affinity_plan:allocation.plan}:{})}},{bars,budget,watchdog:budget*2+10000,heapMiB,capacity});
  }
  startOptimization(datasets,options={}) {
    if(this.worker)throw new Error('Research is already running; cancel it before starting another run');
    if(this._processLifecycle.remaining())throw new Error('Previous candidate processes are still exiting; research cannot restart yet.');
    if(options.final_test_allowed!==undefined&&typeof options.final_test_allowed!=='boolean')throw new TypeError('Final-test permission must be boolean');
    if(!Array.isArray(datasets)||datasets.length<1||datasets.length>2)throw new RangeError('Tuning requires one or two datasets');
    const maxBars=barLimit(options.max_bars??MAX_RESEARCH_BARS),sizes=datasets.map(dataset=>datasetSize(dataset,maxBars)),total=sizes.reduce((count,size)=>count+size.total,0);
    if(total>MAX_TOTAL_BARS)throw new RangeError(`Tuning requires at most ${MAX_TOTAL_BARS} total symbol/context bars`);
    const tuning=tuningOptions(options.tuning),bars=sizes.reduce((count,size)=>count+size.bars,0);
    const requested=options.parallelism??0,reserve=options.reserve_cpus??4,live=options.live_workers??0;
    if(!Number.isInteger(requested)||requested<0||requested>MAX_CANDIDATES)throw new RangeError(`Tuning parallelism must be zero (automatic) or between 1 and ${MAX_CANDIDATES}`);
    if(!Number.isInteger(reserve)||reserve<0||reserve>65536||!Number.isInteger(live)||live<0||live>65536)throw new RangeError('Tuning CPU reservations must be bounded nonnegative integers');
    const detected=this._capacityDetector(),usable=Math.max(1,Math.min(65536,Math.floor(Number(detected.available_cpus)||1))),reserved=Math.max(4,reserve);
    const heapMiB=workerHeapMiB(total),free=Math.max(0,Number(this._freeMemory())||0);
    let affinityPlan=null;
    if(options.cpu_affinity!==undefined){
      if(!['pinned','automatic'].includes(options.cpu_affinity))throw new RangeError('Research CPU scheduling must be pinned or automatic');
      affinityPlan=this._affinityPlanner({mode:options.cpu_affinity,workerLimit:Math.max(1,Math.min(MAX_CANDIDATE_ANALYTICS_THREADS,usable))});
      if(affinityPlan.status==='planned'&&(!Number.isSafeInteger(affinityPlan.available_cpus)||affinityPlan.available_cpus<1||!Array.isArray(affinityPlan.assignments)||!affinityPlan.assignments.length))throw new Error('CPU affinity planning returned no usable processors');
    }
    const allocation=candidateProcessCapacity({usable,physical:detected.physical_cpus,live,free,heapMiB,candidates:tuning.max_candidates,requested,affinityPlan});
    const capacity={...allocation.capacity,source:detected.source};
    return this._launch({type:'optimization',datasets,options:{...options,max_bars:maxBars,tuning,parallelism:capacity.process_limit,threads_per_process:capacity.threads_per_process,
      memory_reserve_mib:capacity.memory_reserve_mib,startup_memory_mib:capacity.startup_memory_mib,max_initializing_processes:capacity.max_initializing_processes,
      analytics_worker_heap_mib:capacity.analytics_worker_heap_mib,worker_heap_mib:heapMiB,...(allocation.plan?{affinity_plan:allocation.plan}:{})}},{bars,budget:tuning.max_runtime_ms,watchdog:tuning.max_runtime_ms+10000,trialCount:tuning.max_candidates,capacity,heapMiB});
  }
  _launch(workerData,{bars,budget,watchdog,trialCount=0,capacity=null,heapMiB=512}) {
    const id = randomUUID(),started=performance.now();
    this._stopRequested=null;this._stopTask=null;
    this._cancellation=new Int32Array(new SharedArrayBuffer(4));workerData.cancellation=this._cancellation.buffer;
    this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
    const parallelism=capacity?.kind==='comparison'?{worker_limit:capacity.worker_limit,active_workers:0,batch_completed_symbols:0,batch_total_symbols:0,batch_timestamp:null}
      :capacity?{worker_limit:capacity.worker_limit,active_workers:0,process_limit:capacity.process_limit,active_processes:0,thread_limit:capacity.analytics_thread_limit,active_threads:0,completed_tasks:0,total_tasks:0,active_sets:[]}:null;
    this.job = { id, type:workerData.type, status: 'running', phase: 'validating',message:workerData.type==='optimization'?'Validating datasets and bounded tuning limits.':'Validating research candles.',trial:0,trial_count:trialCount,trials:[],capacity,parallelism, progress: 0, processed_bars: 0, total_bars: bars, runtime_budget_ms:budget, started_at: new Date().toISOString(), finished_at: null, result: null, error: null,error_code:null,error_details:null };
    try {
      this.worker = this._workerFactory(new URL('./backtest-worker.js', import.meta.url), { workerData,execArgv:[], resourceLimits: { maxOldGenerationSizeMb: heapMiB, maxYoungGenerationSizeMb: 64 } });
    } catch (error) { this._finish('failed', { error: String(error.message).slice(0, 1000),error_code:'worker' }); throw error; }
    const worker = this.worker;let terminal=null,resolveExit;
    this._workerExit=new Promise(resolve=>{resolveExit=resolve;});
    worker.on('message', message => {
      // Lifecycle messages remain meaningful during cancellation and after a
      // result, until the coordinator actually exits. Do not drop them with UI
      // progress or the main server loses ownership of late-starting children.
      if(this.job.id===id&&workerData.type==='optimization'&&message?.type==='candidate_process')this._processLifecycle.observe(message);
      if (this.job.id !== id || this.job.status !== 'running'||terminal||this._stopRequested||!message||typeof message!=='object') return;
      if (message.type === 'progress') {
        if(Number.isFinite(message.progress))this.job.progress=Math.max(0,Math.min(1,message.progress));
        if(workerData.type==='comparison'&&Number.isFinite(message.phase_progress)&&message.phase_progress>=0&&message.phase_progress<=1)this.job.phase_progress=message.phase_progress;
        for(const key of ['phase','message'])if(typeof message[key]==='string')this.job[key]=message[key].slice(0,key==='phase'?64:1000);
        for(const key of ['processed_bars','total_bars','trial','trial_count'])if(Number.isInteger(message[key])&&message[key]>=0&&message[key]<=(key.startsWith('trial')?MAX_CANDIDATES:MAX_TOTAL_BARS))this.job[key]=message[key];
        if(workerData.type==='optimization'){const trials=trialProgress(message.trials);if(trials)this.job.trials=trials;}
        if(capacity&&plain(message.parallelism)){
          const pool=this.job.parallelism;
          const workers=workerAffinityRecords(message.parallelism.workers,capacity.analytics_thread_limit??capacity.worker_limit);if(workers)pool.workers=workers;
          if(capacity.kind==='comparison')comparisonProgress(pool,message.parallelism,capacity);
          else{
            for(const key of ['active_workers','completed_tasks','failed_tasks','total_tasks'])if(Number.isSafeInteger(message.parallelism[key])&&message.parallelism[key]>=0&&message.parallelism[key]<=(key==='active_workers'?capacity.worker_limit:MAX_CANDIDATES*6))pool[key]=message.parallelism[key];
            if(Number.isSafeInteger(message.parallelism.active_processes)&&message.parallelism.active_processes>=0&&message.parallelism.active_processes<=capacity.process_limit)pool.active_processes=message.parallelism.active_processes;
            if(Number.isSafeInteger(message.parallelism.active_threads)&&message.parallelism.active_threads>=0&&message.parallelism.active_threads<=capacity.analytics_thread_limit)pool.active_threads=message.parallelism.active_threads;
            if(typeof message.parallelism.memory_waiting==='boolean')pool.memory_waiting=message.parallelism.memory_waiting;
            if(['free_memory','initializing',null].includes(message.parallelism.memory_wait_reason))pool.memory_wait_reason=message.parallelism.memory_wait_reason;
            for(const key of ['available_memory_mib','memory_reserve_mib','startup_memory_mib'])if(Number.isSafeInteger(message.parallelism[key])&&message.parallelism[key]>=0&&message.parallelism[key]<=2**30)pool[key]=message.parallelism[key];
            if(Number.isSafeInteger(message.parallelism.initializing_processes)&&message.parallelism.initializing_processes>=0&&message.parallelism.initializing_processes<=Math.min(capacity.process_limit,capacity.max_initializing_processes))pool.initializing_processes=message.parallelism.initializing_processes;
            if(Number.isSafeInteger(message.parallelism.max_initializing)&&message.parallelism.max_initializing>=1&&message.parallelism.max_initializing<=Math.min(capacity.process_limit,capacity.max_initializing_processes))pool.max_initializing=message.parallelism.max_initializing;
            if(Array.isArray(message.parallelism.active_sets))pool.active_sets=message.parallelism.active_sets.slice(0,capacity.worker_limit).filter(plain).map(item=>activeSetProgress(item,capacity));
          }
        }
      } else if (message.type === 'complete') terminal={status:'complete',details:{progress:1,result:message.result}};
      else if (message.type === 'failed') {
        const timeout=message.error_code==='worker_timeout'||message.error==='Backtest runtime limit exceeded; use a smaller dataset';
        const error_details=timeout?timeoutDetails(this.job,message.error_details,budget,'variant'):null;
        terminal={status:'failed',details:{error:String(message.error||'Research worker failed').slice(0,1000),error_code:timeout?'worker_timeout':message.error_code==='cpu_affinity'?'cpu_affinity':'worker',error_details,...(error_details?{phase:error_details.phase}:{})}};
      }
    });
    worker.on('error', error => { if (this.job.id === id && this.job.status === 'running') terminal={status:'failed',details:{error:String(error.message).slice(0,1000),error_code:'worker'}}; });
    worker.on('exit', code => {
      const finish=cleanupError=>{
        if(this.worker===worker)this.worker=null;
        if(this.job.id===id&&this.job.status==='running'){
          if(cleanupError)this._finish('failed',{error:cleanupError.message,error_code:'worker_cleanup'});
          else if(this._stopRequested?.id===id)this._finish(this._stopRequested.status,this._stopRequested.details);
          else if(terminal&&(code===0||terminal.status==='failed'))this._finish(terminal.status,terminal.details);
          else this._finish('failed',{error:`Research worker exited before producing a report (${code})`,error_code:'worker'});
        }
        resolveExit(this.status());
      };
      // An OS child can outlive the Worker that spawned it. Keep the research
      // gate closed until the main-server registry verifies their retirement.
      if(!this._processLifecycle.remaining())finish();
      else{
        this.job.phase='cancelling';this.job.message='Waiting for candidate processes and their analytics threads to exit.';
        this._processLifecycle.retire().then(()=>finish(),finish);
      }
    });
    this.timer = this._setTimer(() => {
      if (this.worker === worker && this.job.status === 'running') {
        const error_details=timeoutDetails(this.job,{elapsed_ms:Math.round(performance.now()-started)},watchdog,'watchdog');
        this._requestStop('failed',{error:'Research exceeded its time limit; reduce dataset size',error_code:'worker_timeout',error_details,phase:error_details.phase}).catch(()=>{});
      }
    }, watchdog);
    this.timer.unref?.();
    return this.status();
  }
  _finish(status, details = {}) { this._clearTimer(this.timer); this.timer = null; if(this.job.parallelism)Object.assign(this.job.parallelism,{active_workers:0,...(this.job.capacity?.kind==='comparison'?{}:{active_sets:[],active_processes:0,active_threads:0,...(this.job.parallelism.memory_waiting!==undefined?{memory_waiting:false,memory_wait_reason:null}:{}),...(this.job.parallelism.initializing_processes!==undefined?{initializing_processes:0}:{})})});Object.assign(this.job, { status, finished_at: new Date().toISOString(), ...details }); this.resolveCompletion?.(this.status()); this.resolveCompletion = null; }
  _requestStop(status,details={}) {
    if(this._stopTask)return this._stopTask;
    const worker=this.worker,exited=this._workerExit;if(!worker)return Promise.resolve(this.status());
    this._stopRequested={id:this.job.id,status,details};this.job.phase='cancelling';this.job.message='Stopping research workers and waiting for them to exit.';
    this._clearTimer(this.timer);this.timer=null;
    if(this._cancellation)Atomics.store(this._cancellation,0,1);
    this._stopTask=(async()=>{
      let grace;
      try{
        if(this._cancellation&&this._cancelGraceMs>0)await Promise.race([exited,new Promise(resolve=>{grace=this._setTimer(resolve,this._cancelGraceMs);})]);
        if(this.worker===worker)await worker.terminate();
        return await exited;
      }finally{if(grace)this._clearTimer(grace);}
    })();
    return this._stopTask;
  }
  status() { return structuredClone(this.job); }
  async wait() { return this.job.status === 'running' ? this.completion : this.status(); }
  async cancel() {
    if(this.worker)return this._requestStop('cancelled',{error:null});
    return this.status();
  }
  async close() { await this.cancel(); }
}
