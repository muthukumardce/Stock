/** Persistent offline workers. No broker, database or application handles enter this pool. */
import {Worker} from 'node:worker_threads';
import {MAX_RESEARCH_BARS} from './backtest.js';
import {workerAffinityRequest,pendingAffinity,confirmedAffinity} from './research-affinity-state.js';

const cancelled=()=>Object.assign(new Error('Optimization cancelled'),{name:'AbortError'});
const failure=(message,code='candidate_error')=>Object.assign(new Error(String(message||'Optimizer calculation failed').slice(0,1000)),{code});
const validCode=value=>typeof value==='string'&&/^[a-z][a-z_]{0,63}$/.test(value);

export class OptimizerPool{
  constructor(context,{workerLimit=1,workerHeapMiB=512,affinityPlan=null,guard=()=>{},onWorkerEvent=()=>{},workerFactory=(url,options)=>new Worker(url,options),maxWorkerRestarts,now=()=>performance.now(),setProgressTimer=setTimeout,clearProgressTimer=clearTimeout,staggerStartup=false,scheduleStartup=setImmediate,cancelStartup=clearImmediate}={}){
    this.workerLimit=Math.max(1,Math.min(100,Math.trunc(workerLimit)||1));
    this.workerHeapMiB=Math.max(512,Math.min(12288,Number.isInteger(workerHeapMiB)?workerHeapMiB:512));
    this.restartsRemaining=Math.max(0,Math.min(this.workerLimit,Number.isInteger(maxWorkerRestarts)?maxWorkerRestarts:this.workerLimit));
    this.context=context;this.workerFactory=workerFactory;this.guard=guard;this.onWorkerEvent=onWorkerEvent;this.affinityPlan=affinityPlan;
    this.slots=[];this.batch=null;this.failure=null;this.closing=false;this.closePromise=null;this.nextTaskId=0;this.retirements=new Set();
    this.now=now;this.setProgressTimer=setProgressTimer;this.clearProgressTimer=clearProgressTimer;this.progressTimer=null;this.lastProgressAt=-Infinity;
    this.staggerStartup=staggerStartup;this.scheduleStartup=scheduleStartup;this.cancelStartup=cancelStartup;
    this.pendingStarts=staggerStartup?this.workerLimit:0;this.startup=null;
    this.cancellation=new Int32Array(new SharedArrayBuffer(4));
    try{if(staggerStartup)this._scheduleStartup();else for(let index=0;index<this.workerLimit;index++)this._spawn();}catch(error){this._abort(error);}
    if(!this.closing){this.timer=setInterval(()=>{try{this.guard();}catch(error){this._abort(error);}},25);this.timer.unref?.();}
  }

  _scheduleStartup(){
    if(this.closing||this.startup||!this.pendingStarts)return;
    // Each Worker constructor copies the immutable dataset synchronously. Yield
    // between copies so ready workers can receive tasks and cancellation can be
    // observed while the rest of the bounded pool is still starting.
    const scheduled={handle:null};this.startup=scheduled;
    scheduled.handle=this.scheduleStartup(()=>{
      if(this.closing||this.startup!==scheduled)return;
      this.startup=null;
      try{
        this.pendingStarts--;this._spawn();this._pump();this._scheduleStartup();
      }catch(error){this._abort(error);}
    });
  }

  _spawn(){
    this.guard(); // Check the global deadline/cancellation before every dataset copy.
    // Reuse an assignment only after its previous native thread has retired.
    const affinityIndex=Array.from({length:this.workerLimit},(_,i)=>i).find(i=>!this.slots.some(slot=>!slot.retired&&slot.affinity_index===i));
    const affinityRequest=workerAffinityRequest(this.affinityPlan,affinityIndex);
    let worker;
    try{
      worker=this.workerFactory(new URL('./optimizer-worker.js',import.meta.url),{workerData:{context:this.context,cancellation:this.cancellation.buffer,...(affinityRequest?{affinity:affinityRequest}:{})},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:this.workerHeapMiB,maxYoungGenerationSizeMb:64}});
    }catch(error){
      // A bounded startup failure does not discard another worker's results.
      this.onWorkerEvent({type:'start_failed',code:'worker_start'});return false;
    }
    const slot={worker,thread_id:worker.threadId,affinity_index:affinityIndex,affinity_request:affinityRequest,affinity:pendingAffinity(affinityRequest),ready:false,task:null,taskId:null,interval:null,taskProgress:null,intervals:new Set(),retiring:false,retired:false,exited:false,termination:null};this.slots.push(slot);
    worker.on('message',message=>{try{this._message(slot,message);}catch(error){this._abort(error);}});
    worker.on('error',error=>{try{this._workerFailed(slot,failure(error?.message,'worker_crash'));}catch(error){this._abort(error);}});
    worker.on('exit',code=>{
      if(slot.exited)return;
      slot.exited=true;
      try{
        this.onWorkerEvent({type:'stopped',thread_id:slot.thread_id});
        if(!this.closing&&!slot.retiring)this._workerFailed(slot,failure(`Optimizer worker exited unexpectedly (${code})`,'worker_crash'));
      }catch(error){this._abort(error);}
    });
    this.onWorkerEvent({type:'created',thread_id:slot.thread_id});return true;
  }

  runBatch(tasks,{prepare=task=>task,onComplete=()=>{},onFailure=()=>{},onProgress=()=>{}}={}){
    if(this.failure)return Promise.reject(this.failure);
    if(this.closing)return Promise.reject(cancelled());
    if(this.batch)return Promise.reject(new Error('Optimizer phase batches cannot overlap'));
    if(!Array.isArray(tasks)||!tasks.length)return Promise.reject(new Error('Optimizer phase requires at least one task'));
    return new Promise((resolve,reject)=>{
      this.batch={tasks:[...tasks],next:0,completed:0,failed:0,prepare,onComplete,onFailure,onProgress,resolve,reject};
      try{this.guard();this._pump();}catch(error){this._abort(error);}
    });
  }

  _snapshot(batch=this.batch){
    const active=this.slots.filter(slot=>slot.task);
    return {worker_limit:this.workerLimit,active_workers:active.length,completed_tasks:batch?.completed??0,failed_tasks:batch?.failed??0,total_tasks:batch?.tasks.length??0,
      active_sets:active.map(slot=>({parameter_set_id:slot.task.trial.parameter_set_id,phase:slot.task.phase,interval:slot.interval,...slot.taskProgress,...(this.affinityPlan?{worker_id:slot.thread_id,affinity:slot.affinity}:{})})),
      ...(this.affinityPlan?{workers:this.slots.map(slot=>({worker_id:slot.thread_id,affinity:slot.affinity,state:slot.exited?'stopped':slot.retiring?'retiring':slot.task?'busy':slot.ready?'ready':'starting'}))}:{})};
  }

  _progress(immediate=true){
    if(this.closing||!this.batch)return;
    const remaining=200-(this.now()-this.lastProgressAt);
    if(!immediate&&remaining>0){
      if(!this.progressTimer){
        const batch=this.batch;
        this.progressTimer=this.setProgressTimer(()=>{
          this.progressTimer=null;
          if(this.batch===batch&&!this.closing)try{this._progress();}catch(error){this._abort(error);}
        },remaining);this.progressTimer.unref?.();
      }
      return;
    }
    if(this.progressTimer){this.clearProgressTimer(this.progressTimer);this.progressTimer=null;}
    this.lastProgressAt=this.now();this.batch.onProgress(this._snapshot());
  }

  _taskProgress(slot,message){
    const previous=slot.taskProgress,interval=message.interval;
    const {progress,processed_bars,total_bars,completed_intervals,total_intervals}=message;
    if(!Number.isFinite(progress)||progress<0||progress>1
      ||![processed_bars,total_bars,completed_intervals,total_intervals].every(Number.isSafeInteger)
      ||processed_bars<0||total_bars<processed_bars||total_bars>MAX_RESEARCH_BARS
      ||completed_intervals<0||total_intervals<1||total_intervals>2||completed_intervals>total_intervals
      ||interval!==null&&!['5minute','day'].includes(interval))return;
    if(interval===null&&(slot.interval!==null||processed_bars!==0||completed_intervals!==0))return;
    if(progress<previous.progress||completed_intervals<previous.completed_intervals
      ||previous.total_intervals&&total_intervals!==previous.total_intervals)return;
    const changed=interval!==slot.interval;
    if(changed&&(slot.intervals.has(interval)||slot.interval!==null&&completed_intervals<1))return;
    if(!changed&&(processed_bars<previous.processed_bars||previous.total_bars&&total_bars!==previous.total_bars))return;
    if(progress===1&&(completed_intervals!==total_intervals||processed_bars!==total_bars))return;
    const initial=previous.total_bars===0&&total_bars>0,finishedInterval=completed_intervals>previous.completed_intervals;
    slot.interval=interval;if(interval)slot.intervals.add(interval);
    slot.taskProgress={progress,processed_bars,total_bars,completed_intervals,total_intervals};
    // Bar updates are coalesced across all trial workers; transitions remain
    // immediate, and the trailing flush always includes the newest counts.
    this._progress(changed||initial||finishedInterval||progress===1);
  }

  _pump(){
    if(this.closing||!this.batch)return;
    const batch=this.batch;
    // Ready workers start independently of slow or failed startup peers.
    for(const slot of this.slots){
      if(!slot.ready||slot.retiring||slot.exited||slot.task||batch.next>=batch.tasks.length)continue;
      this.guard();const task=batch.tasks[batch.next++],prepared=batch.prepare(task);
      slot.task=task;slot.taskId=++this.nextTaskId;slot.interval=null;slot.intervals.clear();
      const totalIntervals=this.context?.datasets?.length;
      slot.taskProgress={progress:0,processed_bars:0,total_bars:0,completed_intervals:0,total_intervals:[1,2].includes(totalIntervals)?totalIntervals:0};
      try{slot.worker.postMessage({type:'task',task_id:slot.taskId,task:prepared});}
      catch(error){this._workerFailed(slot,failure(error?.message,'worker_dispatch'));}
    }
    if(batch.next<batch.tasks.length){
      let available=this.slots.filter(slot=>!slot.retiring&&!slot.exited).length;
      // Never replace a failed worker until termination has joined. Limit
      // replacement attempts across the entire pool, including startup errors.
      const retiring=this.slots.filter(slot=>slot.retiring&&!slot.retired).length;
      while(available+retiring+this.pendingStarts<this.workerLimit&&this.restartsRemaining>0){
        this.guard();this.restartsRemaining--;
        if(this.staggerStartup){this.pendingStarts++;this._scheduleStartup();}
        else if(this._spawn())available++;
      }
      if(!available&&!this.retirements.size&&!this.pendingStarts){
        while(batch.next<batch.tasks.length){
          this.guard();const task=batch.tasks[batch.next++];
          batch.onFailure(task,this._attributed(task,null,failure(this.affinityFailure||'No research worker is available after bounded recovery attempts.',this.affinityFailure?'cpu_affinity':'worker_unavailable')));
          batch.completed++;batch.failed++;
        }
      }
    }
    this._progress();
    if(this.batch===batch&&batch.completed===batch.tasks.length&&!this.retirements.size){this.batch=null;batch.resolve();}
  }

  _attributed(task,interval,error){
    error.phase=String(task.phase||'').slice(0,64);
    error.parameter_set_id=typeof task.trial?.parameter_set_id==='string'?task.trial.parameter_set_id.slice(0,64):null;
    error.interval=['5minute','day'].includes(interval)?interval:null;
    return error;
  }

  _settle(slot,error,stage){
    if(this.closing||!slot.task||!this.batch)return;
    this.guard();const task=slot.task,batch=this.batch,interval=slot.interval;
    slot.task=null;slot.taskId=null;slot.interval=null;slot.taskProgress=null;slot.intervals.clear();
    this.onWorkerEvent({type:error?'task_failed':'task_complete',thread_id:slot.thread_id,parameter_set_id:task.trial.parameter_set_id,phase:task.phase,...(error?{code:error.code}:{}),...(interval?{interval}:{})});
    if(error){batch.onFailure(task,this._attributed(task,interval,error));batch.failed++;}
    else batch.onComplete(task,stage);
    batch.completed++;this._pump();
  }

  _message(slot,message){
    if(this.closing||slot.retiring||slot.exited||!message||typeof message!=='object')return;
    if(message.type==='affinity_error'){
      slot.affinity=confirmedAffinity(slot.affinity_request,message.affinity);
      this.affinityFailure=slot.affinity?.reason||'Research CPU assignment failed.';
      this._workerFailed(slot,failure(slot.affinity?.reason||'Research CPU assignment failed.','cpu_affinity'));return;
    }
    if(message.type==='ready'){
      if(slot.ready)return;
      if(slot.affinity_request){
        slot.affinity=confirmedAffinity(slot.affinity_request,message.affinity);
        if(slot.affinity.status==='failed'){this.affinityFailure=slot.affinity.reason;this._workerFailed(slot,failure(slot.affinity.reason,'cpu_affinity'));return;}
      }
      slot.ready=true;this.onWorkerEvent({type:'ready',thread_id:slot.thread_id});this._pump();return;
    }
    // Echoed assignment IDs make late and duplicate responses harmless even
    // after this worker has already received its next task.
    if(!slot.task||!this.batch||message.task_id!==slot.taskId)return;
    if(message.type==='progress'){this._taskProgress(slot,message);return;}
    if(message.type==='interval'){
      if(!['5minute','day'].includes(message.interval)||slot.intervals.has(message.interval)&&slot.interval!==message.interval)return;
      if(slot.interval!==null&&slot.interval!==message.interval&&slot.taskProgress.completed_intervals<1)return;
      if(slot.interval!==message.interval){slot.taskProgress={...slot.taskProgress,processed_bars:0,total_bars:0};slot.interval=message.interval;slot.intervals.add(message.interval);}
      this.onWorkerEvent({type:'task_started',thread_id:slot.thread_id,parameter_set_id:slot.task.trial.parameter_set_id,phase:slot.task.phase,interval:slot.interval});this._progress();return;
    }
    if(message.type==='failed'){
      const error=failure(message.error,validCode(message.code)?message.code:'candidate_error');
      if(['5minute','day'].includes(message.interval))slot.interval=message.interval;
      if(message.optimizationBudget===true){error.optimizationBudget=true;throw error;}
      if(message.name==='AbortError'){error.name='AbortError';throw error;}
      this._settle(slot,error);return;
    }
    if(message.type==='complete'){this._settle(slot,null,message.stage);return;}
    this._workerFailed(slot,failure('Optimizer worker returned an invalid task message.','worker_protocol'));
  }

  _terminate(slot){
    if(!slot.termination)slot.termination=slot.exited?Promise.resolve():Promise.resolve().then(()=>slot.worker.terminate());
    return slot.termination;
  }

  _workerFailed(slot,error){
    if(this.closing||slot.retiring)return;
    slot.retiring=true;slot.ready=false;
    const retirement=this._terminate(slot).then(()=>{
      slot.exited=true;slot.retired=true;
      if(!this.closing&&slot.task)this._settle(slot,error);
    });
    this.retirements.add(retirement);
    retirement.then(()=>{
      this.retirements.delete(retirement);
      if(!this.closing)try{this._pump();}catch(error){this._abort(error);}
    },error=>{this.retirements.delete(retirement);this._abort(error);});
    this._progress();
  }

  _abort(error){
    if(this.closing)return;
    this.failure=error;const batch=this.batch;this.batch=null;
    // Only global cancellation/deadline or scheduler failure rejects the phase.
    // The optimizer's finally still awaits retirement of every worker.
    batch?.reject(error);void this.close();
  }

  close(){
    if(this.closePromise)return this.closePromise;
    this.closing=true;clearInterval(this.timer);if(this.progressTimer){this.clearProgressTimer(this.progressTimer);this.progressTimer=null;}Atomics.store(this.cancellation,0,1);
    if(this.startup){this.cancelStartup(this.startup.handle);this.startup=null;}this.pendingStarts=0;
    const batch=this.batch;this.batch=null;batch?.reject(this.failure||cancelled());
    this.closePromise=Promise.allSettled([...this.slots.map(slot=>this._terminate(slot)),...this.retirements]).then(()=>{for(const slot of this.slots){slot.task=null;slot.taskId=null;slot.interval=null;slot.taskProgress=null;slot.intervals.clear();}});
    return this.closePromise;
  }
}
