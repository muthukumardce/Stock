/** One disposable OS process per active parameter set, with bounded stock threads. */
import {fork} from 'node:child_process';
import {freemem} from 'node:os';
import {fileURLToPath} from 'node:url';
import {workerAffinityRecords} from './research-affinity-state.js';
import {MAX_RESEARCH_BARS} from './backtest.js';

const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const cancelled=()=>Object.assign(new Error('Optimization cancelled'),{name:'AbortError'});
const failure=(message,code='candidate_error')=>Object.assign(new Error(String(message||'Candidate process failed.').slice(0,1000)),{code});
const validCode=value=>typeof value==='string'&&/^[a-z][a-z_]{0,63}$/.test(value);
const intervals=new Set(['5minute','day']);
export function optimizerProcessEnvironment(source=process.env){
  const env={};
  for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','HOME','USERPROFILE'])if(typeof source[key]==='string')env[key]=source[key];
  return env;
}

export class OptimizerProcessPool{
  constructor(context,{workerLimit=1,threadsPerProcess=1,workerHeapMiB=512,analyticsWorkerHeapMiB=128,affinityPlan=null,guard=()=>{},onWorkerEvent=()=>{},
    forkFactory=fork,scheduleStartup=setImmediate,cancelStartup=clearImmediate,setTimer=setTimeout,clearTimer=clearTimeout,now=()=>performance.now(),cancelGraceMs=1000,startupTimeoutMs=15000,
    memoryReserveMiB,startupMemoryMiB=workerHeapMiB,freeMemory=freemem,maxInitializing=4}={}){
    if(!integer(workerLimit,1,100)||!integer(threadsPerProcess,1,100)||workerLimit*threadsPerProcess>400)throw new RangeError('Candidate processes and analytics threads exceed their bounded capacity');
    this.context=context;this.workerLimit=workerLimit;this.threadsPerProcess=threadsPerProcess;
    this.workerHeapMiB=Math.max(512,Math.min(4096,Number.isInteger(workerHeapMiB)?workerHeapMiB:512));
    this.analyticsWorkerHeapMiB=Math.max(64,Math.min(512,Number.isInteger(analyticsWorkerHeapMiB)?analyticsWorkerHeapMiB:128));
    this.affinityPlan=affinityPlan;this.guard=guard;this.onWorkerEvent=onWorkerEvent;this.forkFactory=forkFactory;
    this.scheduleStartup=scheduleStartup;this.cancelStartup=cancelStartup;this.setTimer=setTimer;this.clearTimer=clearTimer;this.now=now;
    this.cancelGraceMs=Math.max(0,Math.min(5000,cancelGraceMs));this.startupTimeoutMs=Math.max(100,Math.min(60000,startupTimeoutMs));
    this.memoryEnabled=memoryReserveMiB!==undefined;
    if(this.memoryEnabled&&(!integer(memoryReserveMiB,0,2**30)||!integer(startupMemoryMiB,1,2**30)||!integer(maxInitializing,1,100)||typeof freeMemory!=='function'))throw new RangeError('Invalid candidate process memory admission limits');
    this.memoryReserveMiB=memoryReserveMiB;this.startupMemoryMiB=startupMemoryMiB;this.freeMemory=freeMemory;this.maxInitializing=Math.min(workerLimit,maxInitializing);
    this.memoryWaiting=false;this.memoryWaitReason=null;this.availableMemoryMiB=null;
    this.slots=[];this.batch=null;this.startup=null;this.progressTimer=null;this.lastProgress=-Infinity;this.nextTaskId=0;this.closing=false;this.closePromise=null;this.failure=null;
    this.timer=setInterval(()=>{try{this.guard();if(this.memoryEnabled&&this.batch&&this.batch.next<this.batch.tasks.length)this._pump(false);}catch(error){this._abort(error);}},25);
    // A low-RAM queue can have no child or startup callback to keep the research
    // Worker alive. Its bounded deadline/cancellation poll must remain active.
    if(!this.memoryEnabled)this.timer.unref?.();
  }

  runBatch(tasks,{prepare=task=>task,onComplete=()=>{},onFailure=()=>{},onProgress=()=>{}}={}){
    if(this.failure)return Promise.reject(this.failure);if(this.closing)return Promise.reject(cancelled());
    if(this.batch)return Promise.reject(new Error('Optimizer phase batches cannot overlap'));
    if(!Array.isArray(tasks)||!tasks.length||tasks.length>100)return Promise.reject(new Error('Candidate phase requires 1 to 100 tasks'));
    // A phase only settles after every process exits; old handles and worker
    // records need not accumulate through later validation/test phases.
    this.slots=this.slots.filter(slot=>!slot.exited);
    return new Promise((resolve,reject)=>{
      this.batch={tasks,next:0,completed:0,failed:0,prepare,onComplete,onFailure,onProgress,resolve,reject};
      try{this.guard();this._pump();}catch(error){this._abort(error);}
    });
  }

  _snapshot(){
    const active=this.slots.filter(slot=>!slot.exited),batch=this.batch;
    const records=slot=>slot.workers.map(worker=>({...worker,process_id:slot.process_id,state:slot.exited?'stopped':worker.state}));
    const activeRecords=active.flatMap(records),recordLimit=this.workerLimit*this.threadsPerProcess*2;
    const retiredRecords=this.slots.filter(slot=>slot.exited).reverse().flatMap(records).slice(0,Math.max(0,recordLimit-activeRecords.length));
    return {worker_limit:this.workerLimit,active_workers:active.length,process_limit:this.workerLimit,active_processes:active.length,
      thread_limit:this.workerLimit*this.threadsPerProcess,active_threads:active.reduce((count,slot)=>count+slot.activeThreads,0),
      completed_tasks:batch?.completed??0,failed_tasks:batch?.failed??0,total_tasks:batch?.tasks.length??0,
      active_sets:active.map(slot=>({parameter_set_id:slot.task.trial.parameter_set_id,phase:slot.task.phase,process_id:slot.process_id,
        thread_limit:this.threadsPerProcess,active_threads:slot.activeThreads,interval:slot.interval,...slot.progress,workers:records(slot)})),
      workers:[...activeRecords,...retiredRecords],
      ...(this.memoryEnabled?{memory_waiting:this.memoryWaiting,memory_wait_reason:this.memoryWaitReason,available_memory_mib:this.availableMemoryMiB,
        memory_reserve_mib:this.memoryReserveMiB,startup_memory_mib:this.startupMemoryMiB,initializing_processes:active.filter(slot=>slot.initializing).length,max_initializing:this.maxInitializing}:{}),
    };
  }

  _progress(immediate=true){
    if(this.closing||!this.batch)return;
    const wait=200-(this.now()-this.lastProgress);
    if(!immediate&&wait>0){
      if(!this.progressTimer)this.progressTimer=this.setTimer(()=>{this.progressTimer=null;try{this._progress();}catch(error){this._abort(error);}},wait);
      return;
    }
    if(this.progressTimer){this.clearTimer(this.progressTimer);this.progressTimer=null;}
    this.lastProgress=this.now();this.batch.onProgress(this._snapshot());
  }

  _memoryAdmission(){
    if(!this.memoryEnabled)return true;
    let bytes=0;try{bytes=Number(this.freeMemory());}catch{}
    this.availableMemoryMiB=Number.isFinite(bytes)&&bytes>=0?Math.floor(bytes/2**20):0;
    const initializing=this.slots.filter(slot=>!slot.exited&&slot.initializing).length;
    // Account for copies that have started but may not yet appear fully in the
    // OS free-memory reading, plus the next child. Never reserve all queued Ps.
    const required=this.memoryReserveMiB+(initializing+1)*this.startupMemoryMiB;
    this.memoryWaitReason=initializing>=this.maxInitializing?'initializing':this.availableMemoryMiB<required?'free_memory':null;
    this.memoryWaiting=this.memoryWaitReason!==null;return !this.memoryWaiting;
  }

  _pump(immediate=true){
    if(this.closing||!this.batch)return;
    const batch=this.batch,active=this.slots.filter(slot=>!slot.exited).length;
    const queued=batch.next<batch.tasks.length;
    if(!queued||active>=this.workerLimit){this.memoryWaiting=false;this.memoryWaitReason=null;}
    if(queued&&active<this.workerLimit&&!this.startup&&this._memoryAdmission()){
      const scheduled={handle:null};this.startup=scheduled;
      scheduled.handle=this.scheduleStartup(()=>{
        if(this.closing||this.startup!==scheduled)return;this.startup=null;
        try{this.guard();this._start();this._pump();}catch(error){this._abort(error);}
      });
    }
    this._progress(immediate);
    if(this.batch===batch&&batch.completed===batch.tasks.length&&!active){this.batch=null;batch.resolve();}
  }

  _start(){
    const batch=this.batch;if(!batch||batch.next>=batch.tasks.length)return;
    if(!this._memoryAdmission())return;
    const index=Array.from({length:this.workerLimit},(_,i)=>i).find(i=>!this.slots.some(slot=>!slot.exited&&slot.index===i));
    if(index===undefined)return;
    const task=batch.tasks[batch.next++],prepared=batch.prepare(task),taskId=++this.nextTaskId;
    const affinity=this.affinityPlan?{...this.affinityPlan,...(this.affinityPlan.status==='planned'?{assignments:this.affinityPlan.assignments.slice(index*this.threadsPerProcess,(index+1)*this.threadsPerProcess)}:{})}:null;
    if(affinity?.status==='planned'&&affinity.assignments.length!==this.threadsPerProcess)throw new Error('Candidate process CPU assignments are incomplete');
    this.guard();
    let child;
    try{
      child=this.forkFactory(fileURLToPath(new URL('./optimizer-process.js',import.meta.url)),[],{
        execPath:process.execPath,execArgv:[],
        windowsHide:true,serialization:'advanced',stdio:['ignore','ignore','ignore','ipc'],env:optimizerProcessEnvironment(),
      });
    }catch(error){this._record(task,failure(error?.message,'worker_start'));return;}
    let resolveExit;
    const slot={child,index,task,taskId,process_id:child.pid,ready:false,initializing:true,exited:false,terminal:null,stopping:false,startupTimer:null,killTimer:null,
      interval:null,intervals:new Set(),reportedBusy:false,progress:{progress:0,processed_bars:0,total_bars:0,completed_intervals:0,total_intervals:this.context.datasets?.length||1},activeThreads:0,workers:[],
      prepared:{...prepared,parallelism:this.threadsPerProcess,analytics_worker_heap_mib:this.analyticsWorkerHeapMiB,...(affinity?{affinity_plan:affinity}:{})},
      exitPromise:new Promise(resolve=>{resolveExit=resolve;}),resolveExit};
    this.slots.push(slot);
    child.on('message',message=>{try{this._message(slot,message);}catch(error){this._abort(error);}});
    child.on('error',error=>this._fail(slot,failure(error?.message,'worker_crash')));
    child.on('exit',(code,signal)=>this._exit(slot,code,signal));
    child.on('close',(code,signal)=>this._exit(slot,code,signal));
    child.on('disconnect',()=>{if(!slot.exited&&!slot.terminal&&!this.closing)this._fail(slot,failure('Candidate process disconnected before returning a result.','worker_disconnect'));});
    slot.startupTimer=this.setTimer(()=>this._fail(slot,failure('Candidate process did not initialize within its startup deadline.','worker_start_timeout')),this.startupTimeoutMs);
    this.onWorkerEvent({type:'created',process_id:slot.process_id,parameter_set_id:task.trial.parameter_set_id});
  }

  _message(slot,message){
    if(this.closing||slot.exited||slot.terminal||!plain(message))return;
    this.guard();
    if(message.type==='ready'){
      if(slot.ready)return;
      if(message.protocol!==1||!integer(message.process_id,1,2**31-1)||message.process_id!==slot.child.pid)return this._fail(slot,failure('Candidate process returned an invalid startup handshake.','worker_protocol'));
      slot.ready=true;slot.process_id=message.process_id;this.clearTimer(slot.startupTimer);slot.startupTimer=null;
      // Sending the context performs one bounded copy; do not start it after the
      // global research deadline or cancellation has already been observed.
      this.guard();
      try{slot.child.send({type:'run',protocol:1,task_id:slot.taskId,coordinator_heap_mib:this.workerHeapMiB,context:this.context,task:slot.prepared},error=>{if(error)this._fail(slot,failure(error.message,'worker_dispatch'));});}
      catch(error){return this._fail(slot,failure(error.message,'worker_dispatch'));}
      this.onWorkerEvent({type:'ready',process_id:slot.process_id,parameter_set_id:slot.task.trial.parameter_set_id});this._progress();return;
    }
    if(!slot.ready||message.task_id!==slot.taskId)return;
    if(message.type==='coordinator_ready'||message.type==='analytics_ready'){
      if(integer(message.thread_id,1,2**31-1)&&integer(message.heap_limit_bytes,1,16*1024**3))this.onWorkerEvent({type:message.type,
        process_id:slot.process_id,thread_id:message.thread_id,heap_limit_bytes:message.heap_limit_bytes,parameter_set_id:slot.task.trial.parameter_set_id});
      return;
    }
    if(message.type==='interval'){
      if(intervals.has(message.interval))this.onWorkerEvent({type:'task_started',process_id:slot.process_id,parameter_set_id:slot.task.trial.parameter_set_id,phase:slot.task.phase,interval:message.interval});return;
    }
    if(message.type==='progress'){this._taskProgress(slot,message);return;}
    if(message.type==='failed'){
      const error=failure(message.error,validCode(message.code)?message.code:'candidate_error');
      if(intervals.has(message.interval))error.interval=message.interval;
      if(message.optimizationBudget===true){error.optimizationBudget=true;throw error;}
      if(message.name==='AbortError'){error.name='AbortError';throw error;}
      return this._fail(slot,error);
    }
    if(message.type==='complete'){
      const expected=this.context.datasets.map(dataset=>dataset.interval).sort();
      if(!plain(message.stage)||JSON.stringify(Object.keys(message.stage).sort())!==JSON.stringify(expected)||Object.entries(message.stage).some(([key,value])=>!intervals.has(key)||!plain(value)||!plain(value.metrics)||!plain(value.data_quality)))return this._fail(slot,failure('Candidate process returned an invalid stage result.','worker_protocol'));
      slot.terminal={stage:message.stage};this._stop(slot,false);return;
    }
    this._fail(slot,failure('Candidate process returned an unknown message.','worker_protocol'));
  }

  _taskProgress(slot,message){
    const previous=slot.progress,{progress,processed_bars,total_bars,completed_intervals,total_intervals,interval}=message;
    if(!Number.isFinite(progress)||progress<previous.progress||progress>1||!intervals.has(interval)
      ||!integer(processed_bars,0,MAX_RESEARCH_BARS)||!integer(total_bars,processed_bars,MAX_RESEARCH_BARS)
      ||!integer(total_intervals,1,2)||total_intervals!==previous.total_intervals||!integer(completed_intervals,previous.completed_intervals,total_intervals)
      ||(progress===1&&(completed_intervals!==total_intervals||processed_bars!==total_bars)))return;
    const changed=slot.interval!==interval;
    const order=this.context.datasets.map(dataset=>dataset.interval),index=order.indexOf(interval);
    if(index<0||completed_intervals<index||completed_intervals>index+1)return;
    if(changed&&(slot.interval===null?index!==0:index!==order.indexOf(slot.interval)+1||completed_intervals!==index))return;
    if(changed&&(slot.intervals.has(interval)||slot.interval!==null&&completed_intervals<1)||!changed&&(processed_bars<previous.processed_bars||previous.total_bars&&total_bars!==previous.total_bars))return;
    if(plain(message.parallelism)){
      const nested=message.parallelism;
      if(integer(nested.active_workers,0,this.threadsPerProcess))slot.activeThreads=nested.active_workers;
      const workers=workerAffinityRecords(nested.workers,this.threadsPerProcess);if(workers)slot.workers=workers;
    }
    const complete=completed_intervals>previous.completed_intervals,initial=previous.total_bars===0&&total_bars>0,firstBusy=!slot.reportedBusy&&slot.activeThreads>0;
    if(firstBusy)slot.reportedBusy=true;
    const initialized=slot.initializing&&(slot.activeThreads>0||processed_bars>0||progress===1);
    if(initialized)slot.initializing=false;
    slot.interval=interval;slot.intervals.add(interval);slot.progress={progress,processed_bars,total_bars,completed_intervals,total_intervals};
    if(initialized&&this.memoryEnabled)this._pump();else this._progress(changed||complete||initial||firstBusy||progress===1);
  }

  _record(task,error,stage){
    const batch=this.batch;if(this.closing||!batch)return;
    this.guard();
    if(error){error.phase=task.phase;error.parameter_set_id=task.trial.parameter_set_id;batch.onFailure(task,error);batch.failed++;}
    else batch.onComplete(task,stage);
    batch.completed++;
    this.onWorkerEvent({type:error?'task_failed':'task_complete',parameter_set_id:task.trial.parameter_set_id,phase:task.phase,...(error?{code:error.code}:{})});
  }

  _fail(slot,error){
    if(slot.exited||slot.terminal||this.closing)return;
    slot.terminal={error};this._stop(slot,true);
  }

  _stop(slot,force=false){
    if(slot.exited)return;
    if(slot.startupTimer){this.clearTimer(slot.startupTimer);slot.startupTimer=null;}
    const kill=()=>{if(!slot.exited)try{slot.child.kill('SIGKILL');}catch{}};
    if(force){if(slot.killTimer)this.clearTimer(slot.killTimer);slot.killTimer=null;kill();return;}
    if(slot.stopping)return;slot.stopping=true;
    if(!slot.terminal&&slot.child.connected)try{slot.child.send({type:'cancel'},()=>{});}catch{}
    slot.killTimer=this.setTimer(kill,this.cancelGraceMs);
  }

  _exit(slot,code,signal){
    if(slot.exited)return;slot.exited=true;slot.activeThreads=0;
    if(slot.startupTimer)this.clearTimer(slot.startupTimer);if(slot.killTimer)this.clearTimer(slot.killTimer);
    slot.resolveExit();
    try{
      this.onWorkerEvent({type:'stopped',process_id:slot.process_id,parameter_set_id:slot.task.trial.parameter_set_id});
      if(!this.closing){
        const error=slot.terminal?.error||((!slot.terminal?.stage||code!==0)?failure(`Candidate process exited without a successful result${signal?' ('+signal+')':''}.`,'worker_crash'):null);
        this._record(slot.task,error,slot.terminal?.stage);this._pump();
      }
    }catch(error){this._abort(error);}
  }

  _abort(error){if(this.closing)return;this.failure=error;const batch=this.batch;this.batch=null;batch?.reject(error);void this.close();}

  close(){
    if(this.closePromise)return this.closePromise;
    this.closing=true;clearInterval(this.timer);
    this.memoryWaiting=false;this.memoryWaitReason=null;
    if(this.startup){this.cancelStartup(this.startup.handle);this.startup=null;}
    if(this.progressTimer){this.clearTimer(this.progressTimer);this.progressTimer=null;}
    const batch=this.batch;this.batch=null;batch?.reject(this.failure||cancelled());
    for(const slot of this.slots)this._stop(slot,false);
    this.closePromise=Promise.allSettled(this.slots.map(slot=>slot.exitPromise)).then(()=>{});return this.closePromise;
  }
}
