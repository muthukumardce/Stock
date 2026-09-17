/** Persistent streaming workers; cash, positions and chronology stay with the caller. */
import {Worker} from 'node:worker_threads';
import {workerAffinityRequest,pendingAffinity,confirmedAffinity} from './research-affinity-state.js';

const cancelled=()=>Object.assign(new Error('Comparison cancelled'),{name:'AbortError'});
const failure=(message,code='comparison_worker')=>Object.assign(new Error(String(message||'Comparison analytics failed').slice(0,1000)),{code});
const validCode=value=>typeof value==='string'&&/^[a-z][a-z_]{0,63}$/.test(value);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);

export class ComparisonAnalyticsPool {
  constructor({workerLimit=1,workerHeapMiB=128,affinityPlan=null,guard=()=>{},onProgress=()=>{},onWorkerEvent=()=>{},workerFactory=(url,options)=>new Worker(url,options),now=()=>performance.now(),setProgressTimer=setTimeout,clearProgressTimer=clearTimeout}={}) {
    this.workerLimit=Math.max(1,Math.min(100,Math.trunc(workerLimit)||1));
    this.workerHeapMiB=Math.max(64,Math.min(128,Number.isInteger(workerHeapMiB)?workerHeapMiB:128));
    this.guard=guard;this.onProgress=onProgress;this.onWorkerEvent=onWorkerEvent;this.now=now;this.affinityPlan=affinityPlan;
    this.setProgressTimer=setProgressTimer;this.clearProgressTimer=clearProgressTimer;
    this.workerFactory=workerFactory;this.slots=[];this.batch=null;this.nextTaskId=0;this.failure=null;this.closing=false;this.closePromise=null;
    this.progressTimer=null;this.lastProgressAt=-Infinity;this.cancellation=new Int32Array(new SharedArrayBuffer(4));
    this.lastSnapshot={worker_limit:this.workerLimit,active_workers:0,batch_completed_symbols:0,batch_total_symbols:0};
    try{for(let index=0;index<this.workerLimit;index++)this._spawn();}catch(error){this._abort(error);}
    if(!this.closing){this.timer=setInterval(()=>{try{this.guard();}catch(error){this._abort(error);}},25);this.timer.unref?.();}
  }

  _spawn(){
    const affinityRequest=workerAffinityRequest(this.affinityPlan,this.slots.length);
    const worker=this.workerFactory(new URL('./comparison-analytics-worker.js',import.meta.url),{
      workerData:{cancellation:this.cancellation.buffer,...(affinityRequest?{affinity:affinityRequest}:{})},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:this.workerHeapMiB,maxYoungGenerationSizeMb:16},
    });
    const slot={worker,thread_id:worker.threadId,affinity_request:affinityRequest,affinity:pendingAffinity(affinityRequest),ready:false,task:null,exited:false,termination:null};this.slots.push(slot);
    worker.on('message',message=>{try{this._message(slot,message);}catch(error){this._abort(error);}});
    worker.on('error',error=>this._abort(failure(error?.message)));
    worker.on('exit',code=>{
      if(slot.exited)return;slot.exited=true;
      try{this.onWorkerEvent({type:'stopped',thread_id:slot.thread_id});if(!this.closing)this._abort(failure(`Comparison worker exited unexpectedly (${code})`));}catch(error){this._abort(error);}
    });
    this.onWorkerEvent({type:'created',thread_id:slot.thread_id});
  }

  async evaluate(tasks,{strategy_options={},phase=null}={}) {
    if(this.failure){await this.close();throw this.failure;}
    if(this.closing){await this.close();throw cancelled();}
    if(this.batch)throw new Error('Comparison candle batches cannot overlap');
    if(!Array.isArray(tasks)||tasks.length>5000)throw new RangeError('Comparison batch requires at most 5000 symbol tasks');
    if(!tasks.length)return [];
    if(!plain(strategy_options)||JSON.stringify(strategy_options).length>10000)throw new TypeError('Comparison strategy options must be a small object');
    for(const task of tasks){
      if(!plain(task)||!['intraday','swing'].includes(task.strategy)||!Array.isArray(task.history)||task.history.length>200||typeof task.signal!=='boolean')throw new TypeError('Invalid bounded comparison task');
      for(const key of ['previous_bars','benchmark_bars','sector_bars'])if(task.context?.[key]!==undefined&&(!Array.isArray(task.context[key])||task.context[key].length>200))throw new RangeError('Comparison context must contain at most 200 candles per series');
    }
    // A low CPU count must not turn a large universe into one enormous message.
    // At most 32 bounded history snapshots enter any worker at one time.
    const count=Math.max(Math.min(this.workerLimit,tasks.length),Math.ceil(tasks.length/32)),chunks=[];
    for(let index=0;index<count;index++){
      const offset=Math.floor(index*tasks.length/count),end=Math.floor((index+1)*tasks.length/count);
      chunks.push({offset,tasks:tasks.slice(offset,end)});
    }
    return new Promise((resolve,reject)=>{
      this.batch={chunks,next:0,completed:0,total:tasks.length,results:Array(tasks.length),strategy_options,phase,started:false,resolve,reject};
      try{
        this.guard();
        // Report the known batch while native threads initialize; a ready pool
        // publishes its assigned count immediately from _pump instead.
        if(!this.slots.some(slot=>slot.ready&&!slot.exited))this._progress(true);
        this._pump();
      }catch(error){this._abort(error);}
    });
  }

  snapshot(){
    const workers=this.affinityPlan?{workers:this.slots.map(slot=>({worker_id:slot.thread_id,affinity:slot.affinity,state:slot.exited?'stopped':this.closing?'retiring':slot.task?'busy':slot.ready?'ready':'starting'}))}:{};
    if(!this.batch)return {...this.lastSnapshot,...workers};
    return {worker_limit:this.workerLimit,active_workers:this.slots.filter(slot=>slot.task).length,batch_completed_symbols:this.batch.completed,batch_total_symbols:this.batch.total,...workers};
  }

  _progress(immediate=false){
    if(this.closing||!this.batch)return;
    const remaining=200-(this.now()-this.lastProgressAt);
    if(!immediate&&remaining>0){
      if(!this.progressTimer){const batch=this.batch;this.progressTimer=this.setProgressTimer(()=>{
        this.progressTimer=null;if(this.batch===batch&&!this.closing)try{this._progress(true);}catch(error){this._abort(error);}
      },remaining);this.progressTimer.unref?.();}
      return;
    }
    if(this.progressTimer){this.clearProgressTimer(this.progressTimer);this.progressTimer=null;}
    this.lastProgressAt=this.now();this.lastSnapshot=this.snapshot();this.onProgress({...this.lastSnapshot});
  }

  _pump(){
    if(this.closing||!this.batch)return;const batch=this.batch;
    for(const slot of this.slots){
      if(!slot.ready||slot.task||slot.exited||batch.next>=batch.chunks.length)continue;
      this.guard();const chunk=batch.chunks[batch.next++];slot.task={...chunk,id:++this.nextTaskId};
      slot.worker.postMessage({type:'evaluate',task_id:slot.task.id,tasks:chunk.tasks,strategy_options:batch.strategy_options});
      this.onWorkerEvent({type:'task_started',thread_id:slot.thread_id,phase:batch.phase,symbol_count:chunk.tasks.length});
    }
    const starting=!batch.started&&this.slots.some(slot=>slot.task);
    if(starting)batch.started=true;
    if(batch.started)this._progress(starting);
    if(this.batch===batch&&batch.completed===batch.total){
      this._progress(true);this.batch=null;batch.resolve(batch.results);
    }
  }

  _message(slot,message){
    if(this.closing||slot.exited||!plain(message))return;
    if(message.type==='affinity_error'){
      slot.affinity=confirmedAffinity(slot.affinity_request,message.affinity);this._progress(true);
      throw failure(slot.affinity?.reason||'Research CPU assignment failed.','cpu_affinity');
    }
    if(message.type==='ready'){
      if(slot.ready)return;
      if(slot.affinity_request){
        slot.affinity=confirmedAffinity(slot.affinity_request,message.affinity);
        if(slot.affinity.status==='failed'){this._progress(true);throw failure(slot.affinity.reason,'cpu_affinity');}
      }
      slot.ready=true;this.onWorkerEvent({type:'ready',thread_id:slot.thread_id,...(Number.isSafeInteger(message.heap_limit_bytes)&&message.heap_limit_bytes>0&&message.heap_limit_bytes<=16*1024**3?{heap_limit_bytes:message.heap_limit_bytes}:{})});this._pump();return;
    }
    if(!this.batch||!slot.task||message.task_id!==slot.task.id)return;
    this.guard();
    if(message.type==='failed'){
      const error=failure(message.error,validCode(message.code)?message.code:'comparison_analytics');
      if(message.name==='AbortError')error.name='AbortError';throw error;
    }
    if(message.type!=='complete'||!Array.isArray(message.results)||message.results.length!==slot.task.tasks.length||message.results.some(value=>!plain(value)))throw failure('Comparison worker returned an invalid result','comparison_protocol');
    const task=slot.task,batch=this.batch;slot.task=null;
    for(let index=0;index<message.results.length;index++)batch.results[task.offset+index]=message.results[index];
    batch.completed+=message.results.length;
    this.onWorkerEvent({type:'task_complete',thread_id:slot.thread_id,phase:batch.phase,symbol_count:message.results.length});
    this._pump();
  }

  _terminate(slot){
    if(!slot.termination)slot.termination=slot.exited?Promise.resolve():Promise.resolve().then(()=>slot.worker.terminate());
    return slot.termination;
  }

  _abort(error){
    if(this.closing)return;this.failure=error;void this.close();
  }

  close(){
    if(this.closePromise)return this.closePromise;
    this.closing=true;clearInterval(this.timer);
    if(this.progressTimer){this.clearProgressTimer(this.progressTimer);this.progressTimer=null;}
    Atomics.store(this.cancellation,0,1);const batch=this.batch;this.batch=null;
    this.closePromise=Promise.allSettled(this.slots.map(slot=>this._terminate(slot))).then(()=>{
      for(const slot of this.slots)slot.task=null;
      this.lastSnapshot={...this.lastSnapshot,active_workers:0};batch?.reject(this.failure||cancelled());
    });
    return this.closePromise;
  }
}
