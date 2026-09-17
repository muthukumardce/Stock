import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {setImmediate as turn} from 'node:timers/promises';
import {OptimizerPool} from '../src/optimizer-pool.js';

const task=id=>({trial:{id:'candidate_'+id,parameter_set_id:'P'+id,parameters:{}},phase:'tuning_train',remaining_ms:60000});
function fixture(t,options={}){
  const workers=[],events=[],completed=[],failed=[],progress=[];
  const pool=new OptimizerPool({}, {workerLimit:1,onWorkerEvent:event=>events.push(event),workerFactory:(_url,options)=>{
    const worker=new EventEmitter();worker.threadId=workers.length+1;worker.sent=[];worker.terminations=0;worker.options=options;
    worker.postMessage=message=>worker.sent.push(message);
    worker.terminate=async()=>{worker.terminations++;worker.emit('exit',0);return 0;};
    workers.push(worker);return worker;
  },...options});
  t.after(()=>pool.close());
  return {pool,workers,events,completed,failed,progress,
    run:tasks=>pool.runBatch(tasks,{onComplete:(task,stage)=>completed.push({task,stage}),onFailure:(task,error)=>failed.push({task,error}),onProgress:value=>progress.push(value)}),
    ready:index=>workers[index].emit('message',{type:'ready'}),
    send:(index,type,fields={},assignment=workers[index].sent.at(-1))=>workers[index].emit('message',{type,task_id:assignment.task_id,...fields}),
  };
}

function progressClock(){
  const timers=[];let now=0;
  return {timers,options:{now:()=>now,setProgressTimer:(callback,delay)=>{const timer={callback,delay,cleared:false,unref(){}};timers.push(timer);return timer;},clearProgressTimer:timer=>{timer.cleared=true;}},
    flush:()=>{now+=200;for(const timer of timers.filter(value=>!value.cleared)){timer.cleared=true;timer.callback();}}};
}
function startupClock(){
  const callbacks=[];
  return {callbacks,options:{staggerStartup:true,scheduleStartup:callback=>{const entry={callback,cancelled:false,called:false};callbacks.push(entry);return entry;},cancelStartup:entry=>{entry.cancelled=true;}},
    tick:()=>{const entry=callbacks.find(value=>!value.called&&!value.cancelled);if(!entry)return false;entry.called=true;entry.callback();return true;}};
}
const fraction=(progress,processed_bars,total_bars=100,completed_intervals=0,total_intervals=1,interval='5minute')=>({progress,processed_bars,total_bars,completed_intervals,total_intervals,interval});

test('staggered startup dispatches ready workers before the remaining dataset copies are created',async t=>{
  const clock=startupClock(),f=fixture(t,{...clock.options,workerLimit:3}),done=f.run([task(1),task(2),task(3)]);
  assert.equal(f.workers.length,0);assert.equal(f.pool.pendingStarts,3);assert.equal(f.failed.length,0);
  clock.tick();assert.equal(f.workers.length,1);f.ready(0);
  assert.equal(f.workers[0].sent.length,1,'The first candidate starts before the final Worker constructor');
  assert.equal(f.pool.pendingStarts,2);assert.equal(f.failed.length,0);
  clock.tick();f.ready(1);clock.tick();f.ready(2);
  assert.equal(f.workers.length,3);assert.equal(f.pool.pendingStarts,0);assert.equal(f.progress.at(-1).active_workers,3);
  assert.equal(clock.tick(),false,'Initial startup cannot oversubscribe the pool with replacement attempts');
  for(let index=0;index<3;index++)f.send(index,'complete',{stage:{}});await done;assert.equal(f.completed.length,3);
});

test('staggered constructor failures preserve pending starters and check the global guard before every copy',async t=>{
  const clock=startupClock(),workers=[],completed=[],failed=[];let attempts=0,guardChecked=false;
  const pool=new OptimizerPool({}, {...clock.options,workerLimit:2,maxWorkerRestarts:0,guard:()=>{guardChecked=true;},workerFactory:()=>{
    assert.equal(guardChecked,true);guardChecked=false;
    if(++attempts===1)throw new Error('One starter failed.');
    const worker=new EventEmitter();worker.threadId=attempts;worker.sent=[];worker.postMessage=value=>worker.sent.push(value);worker.terminate=async()=>0;workers.push(worker);return worker;
  }});t.after(()=>pool.close());
  const done=pool.runBatch([task(1),task(2)],{onComplete:value=>completed.push(value),onFailure:value=>failed.push(value)});
  clock.tick();assert.equal(attempts,1);assert.equal(pool.pendingStarts,1);assert.equal(failed.length,0,'Unstarted slots must not look like unavailable workers');
  clock.tick();assert.equal(attempts,2);workers[0].emit('message',{type:'ready'});
  for(let index=0;index<2;index++)workers[0].emit('message',{type:'complete',task_id:workers[0].sent.at(-1).task_id,stage:{}});
  await done;assert.equal(completed.length,2);assert.equal(failed.length,0);assert.equal(clock.tick(),false);
});

test('all staggered constructor failures exhaust only the bounded initial and replacement attempts',async t=>{
  const clock=startupClock();let attempts=0;
  const f=fixture(t,{...clock.options,workerLimit:2,workerFactory:()=>{attempts++;throw new Error('Cannot create worker.');}}),done=f.run([task(1),task(2)]);
  for(let index=0;index<3;index++){assert.equal(clock.tick(),true);assert.equal(f.failed.length,0);}
  assert.equal(clock.tick(),true);await done;
  assert.equal(attempts,4);assert.equal(f.failed.length,2);assert.ok(f.failed.every(value=>value.error.code==='worker_unavailable'));assert.equal(clock.tick(),false);
});

for(const kind of ['cancel','deadline'])test(`a ${kind} between staggered copies stops further creation and joins the existing worker`,async t=>{
  const clock=startupClock();let stop=false;
  const f=fixture(t,{...clock.options,workerLimit:3,guard:()=>{if(stop)throw Object.assign(new Error('Stop startup.'),kind==='cancel'?{name:'AbortError'}:{optimizationBudget:true});}}),done=f.run([task(1),task(2),task(3)]);
  clock.tick();f.ready(0);const rejected=assert.rejects(done,error=>kind==='cancel'?error.name==='AbortError':error.optimizationBudget===true);
  stop=true;clock.tick();await rejected;await f.pool.close();
  assert.equal(f.workers.length,1);assert.equal(f.workers[0].terminations,1);assert.equal(f.pool.pendingStarts,0);assert.equal(f.failed.length,0);assert.equal(f.completed.length,0);
  assert.equal(clock.tick(),false);
});

test('closing before staggered startup cancels the callback and a late callback cannot create workers',async t=>{
  const clock=startupClock(),f=fixture(t,{...clock.options,workerLimit:3}),done=f.run([task(1)]),scheduled=clock.callbacks[0];
  const rejected=assert.rejects(done,error=>error.name==='AbortError');await f.pool.close();await rejected;
  assert.equal(scheduled.cancelled,true);scheduled.callback();assert.equal(f.workers.length,0);assert.equal(f.pool.pendingStarts,0);
});

test('a fast worker can finish the batch before startup completes and final cleanup cancels unused copies',async t=>{
  const clock=startupClock(),f=fixture(t,{...clock.options,workerLimit:3}),done=f.run([task(1),task(2),task(3)]);
  clock.tick();f.ready(0);const pending=clock.callbacks.at(-1);
  for(let index=0;index<3;index++)f.send(0,'complete',{stage:{}});
  await done;assert.equal(f.completed.length,3);assert.equal(f.workers.length,1);assert.equal(f.pool.pendingStarts,2);
  await f.pool.close();assert.equal(pending.cancelled,true);pending.callback();
  assert.equal(f.workers.length,1);assert.equal(f.workers[0].terminations,1);assert.equal(f.pool.pendingStarts,0);assert.equal(clock.tick(),false);
});

test('staggered starters and replacements never overlap an affinity assignment before retirement',async t=>{
  const clock=startupClock(),assignments=[{group:0,cpu:2,core:1},{group:1,cpu:32,core:272}],affinityPlan={mode:'pinned',status:'planned',assignments};
  const f=fixture(t,{...clock.options,workerLimit:2,affinityPlan}),done=f.run([task(1),task(2),task(3)]);
  const ready=index=>f.workers[index].emit('message',{type:'ready',affinity:{...f.workers[index].options.workerData.affinity.assignment,status:'pinned',verified:true}});
  clock.tick();ready(0);
  let release;f.workers[0].terminate=()=>new Promise(resolve=>{release=()=>{f.workers[0].emit('exit',1);resolve(1);};});
  f.workers[0].emit('error',new Error('Worker failed.'));await turn();
  clock.tick();assert.deepEqual(f.workers[1].options.workerData.affinity.assignment,assignments[1]);ready(1);
  assert.equal(clock.tick(),false,'The retiring CPU slot still consumes capacity');assert.equal(f.workers.length,2);
  release();await turn();assert.equal(f.workers.length,2,'Replacement creation yields after the retirement completes');
  clock.tick();assert.deepEqual(f.workers[2].options.workerData.affinity.assignment,assignments[0]);ready(2);
  f.send(1,'complete',{stage:{}});f.send(2,'complete',{stage:{}});await done;
  assert.equal(f.failed.length,1);assert.equal(f.completed.length,2);assert.equal(clock.tick(),false);
});

test('task progress advances with actual counts and coalesces fractional updates without losing the latest one',async t=>{
  const clock=progressClock(),f=fixture(t,clock.options),done=f.run([task(1)]);f.ready(0);
  assert.equal(f.progress.at(-1).active_sets[0].progress,0);
  f.send(0,'progress',fraction(.1,10));const initial=f.progress.length;
  assert.equal(f.progress.at(-1).active_sets[0].processed_bars,10);
  f.send(0,'progress',fraction(.2,20));f.send(0,'progress',fraction(.3,30));
  assert.equal(f.progress.length,initial);assert.equal(clock.timers.length,1);assert.equal(clock.timers[0].delay,200);
  clock.flush();assert.equal(f.progress.length,initial+1);
  const active=f.progress.at(-1).active_sets[0];assert.equal(active.progress,.3);assert.equal(active.processed_bars,30);assert.equal(active.total_bars,100);
  f.send(0,'progress',fraction(1,100,100,1));assert.equal(f.progress.at(-1).active_sets[0].progress,1);
  assert.equal(f.progress.at(-1).completed_tasks,0,'Progress is not a fabricated task result');
  f.send(0,'complete',{stage:{}});await done;assert.deepEqual(f.progress.at(-1).active_sets,[]);assert.equal(f.progress.at(-1).completed_tasks,1);
});

test('malformed, stale and regressing task progress cannot overwrite the current candidate counters',async t=>{
  const clock=progressClock(),f=fixture(t,clock.options),done=f.run([task(1)]);f.ready(0);f.send(0,'progress',fraction(.3,30));
  const before=f.progress.length,previous=f.progress.at(-1).active_sets[0];
  for(const value of [fraction(.2,30),fraction(.4,29),fraction(.4,40,101),fraction(NaN,30),fraction(.4,40,1000001),fraction(.4,40,100,2),fraction(.4,40,100,0,2),fraction(1,100),fraction(.4,40,100,0,1,'unknown'),fraction(.4,40,100,0,1,null),fraction(.4,40.5)])f.send(0,'progress',value);
  f.workers[0].emit('message',{type:'progress',task_id:999,...fraction(1,100,100,1)});
  clock.flush();assert.equal(f.progress.length,before);assert.deepEqual(f.progress.at(-1).active_sets[0],previous);
  f.send(0,'complete',{stage:{}});await done;
});

test('bar counters reset for the next interval while candidate progress and completed interval counts stay monotonic',async t=>{
  const clock=progressClock(),f=fixture(t,clock.options),done=f.run([task(1)]);f.ready(0);
  f.send(0,'progress',fraction(.25,50,100,0,2));f.send(0,'progress',fraction(.5,100,100,1,2));
  f.send(0,'interval',{interval:'day'});f.send(0,'progress',fraction(.5,0,50,1,2,'day'));
  let active=f.progress.at(-1).active_sets[0];assert.equal(active.interval,'day');assert.equal(active.progress,.5);assert.equal(active.processed_bars,0);assert.equal(active.total_bars,50);
  f.send(0,'progress',fraction(.75,25,50,1,2,'day'));clock.flush();active=f.progress.at(-1).active_sets[0];assert.equal(active.progress,.75);assert.equal(active.completed_intervals,1);
  f.send(0,'interval',{interval:'5minute'});f.send(0,'progress',fraction(.9,90,100,1,2));assert.equal(f.progress.at(-1).active_sets[0].interval,'day');
  f.send(0,'progress',fraction(1,50,50,2,2,'day'));active=f.progress.at(-1).active_sets[0];assert.equal(active.progress,1);assert.equal(active.completed_intervals,2);
  f.send(0,'complete',{stage:{}});await done;
});

test('a candidate error removes its progress and the next assignment starts at zero despite late old updates',async t=>{
  const clock=progressClock(),f=fixture(t,clock.options),done=f.run([task(1),task(2)]);f.ready(0);const first=f.workers[0].sent[0];
  f.send(0,'progress',fraction(.4,40));f.send(0,'failed',{error:'Candidate failed.'});
  let active=f.progress.at(-1).active_sets[0];assert.equal(active.parameter_set_id,'P2');assert.equal(active.progress,0);assert.equal(active.processed_bars,0);assert.equal(active.total_bars,0);assert.equal(active.completed_intervals,0);
  f.send(0,'progress',fraction(1,100,100,1),first);clock.flush();active=f.progress.at(-1).active_sets[0];assert.equal(active.progress,0);
  f.send(0,'progress',fraction(.2,20));assert.equal(f.progress.at(-1).active_sets[0].progress,.2);
  f.send(0,'complete',{stage:{}});await done;assert.equal(f.failed.length,1);assert.equal(f.completed.length,1);assert.deepEqual(f.progress.at(-1).active_sets,[]);
});

test('fifty workers share one fractional progress flush instead of serializing fifty reports per burst',async t=>{
  const clock=progressClock(),f=fixture(t,{...clock.options,workerLimit:50}),done=f.run(Array.from({length:50},(_,index)=>task(index+1)));
  for(let index=0;index<50;index++){f.ready(index);f.send(index,'progress',fraction(.1,10));}
  const before=f.progress.length;
  for(let index=0;index<50;index++)f.send(index,'progress',fraction(.2,20));
  for(let index=0;index<50;index++)f.send(index,'progress',fraction(.3,30));
  assert.equal(clock.timers.filter(value=>!value.cleared).length,1);assert.equal(f.progress.length,before);
  clock.flush();assert.equal(f.progress.length,before+1);assert.ok(f.progress.at(-1).active_sets.every(value=>value.progress===.3&&value.processed_bars===30));
  for(let index=0;index<50;index++)f.send(index,'complete',{stage:{}});await done;
});

test('closing the pool cancels pending fractional progress and ignores a late timer callback',async t=>{
  const clock=progressClock(),f=fixture(t,clock.options),done=f.run([task(1)]);f.ready(0);f.send(0,'progress',fraction(.1,10));f.send(0,'progress',fraction(.2,20));
  const timer=clock.timers[0],before=f.progress.length,rejected=assert.rejects(done,error=>error.name==='AbortError');
  await f.pool.close();await rejected;assert.equal(timer.cleared,true);timer.callback();assert.equal(f.progress.length,before);
  f.send(0,'progress',fraction(1,100,100,1));assert.equal(f.progress.length,before);
});

test('a task failure is attributed, counted and followed by queued work on the same healthy worker',async t=>{
  const f=fixture(t),done=f.run([task(1),task(2),task(3)]);f.ready(0);
  const first=f.workers[0].sent[0];f.send(0,'interval',{interval:'day'});
  f.send(0,'failed',{error:'One candidate exceeded its own budget.',code:'candidate_timeout',interval:'day'});
  assert.equal(f.failed.length,1);assert.equal(f.failed[0].error.code,'candidate_timeout');assert.equal(f.failed[0].error.phase,'tuning_train');
  assert.equal(f.failed[0].error.interval,'day');assert.equal(f.failed[0].error.parameter_set_id,'P1');
  assert.equal(f.workers[0].sent.length,2);assert.equal(f.workers[0].terminations,0);
  f.send(0,'failed',{error:'Stale duplicate.'},first);f.send(0,'complete',{stage:{stale:true}},first);
  assert.equal(f.failed.length,1);assert.equal(f.completed.length,0);
  f.send(0,'complete',{stage:{valid:2}});f.send(0,'complete',{stage:{valid:3}});await done;
  assert.deepEqual(f.completed.map(value=>value.task.trial.parameter_set_id),['P2','P3']);
  assert.equal(f.progress.at(-1).completed_tasks,3);assert.equal(f.progress.at(-1).failed_tasks,1);assert.equal(f.progress.at(-1).active_workers,0);
  assert.equal(new Set(f.workers[0].sent.map(message=>message.task_id)).size,3);
});

test('a ready worker continues while a peer has not completed startup',async t=>{
  const f=fixture(t,{workerLimit:2}),done=f.run([task(1),task(2)]);f.ready(0);
  assert.equal(f.workers[0].sent.length,1);assert.equal(f.workers[1].sent.length,0);
  f.send(0,'complete',{stage:{}});f.send(0,'complete',{stage:{}});await done;
  assert.equal(f.completed.length,2);assert.equal(f.workers[1].sent.length,0);
});

test('a native crash waits for retirement while healthy peers keep consuming their queue',async t=>{
  const f=fixture(t,{workerLimit:2}),done=f.run([task(1),task(2),task(3),task(4)]);f.ready(0);f.ready(1);
  let release;f.workers[0].terminate=()=>new Promise(resolve=>{release=()=>{f.workers[0].emit('exit',1);resolve(1);};});
  f.send(0,'interval',{interval:'5minute'});f.workers[0].emit('error',new Error('CPU worker crashed.'));await turn();
  f.send(1,'complete',{stage:{}});f.send(1,'complete',{stage:{}});f.send(1,'complete',{stage:{}});
  assert.equal(f.completed.length,3);assert.equal(f.failed.length,0);assert.equal(f.workers.length,2);
  let finished=false;done.then(()=>{finished=true;});await turn();assert.equal(finished,false);
  release();await done;assert.equal(f.failed.length,1);assert.equal(f.failed[0].error.code,'worker_crash');assert.equal(f.failed[0].error.interval,'5minute');
  assert.equal(f.progress.at(-1).completed_tasks,4);assert.equal(f.progress.at(-1).failed_tasks,1);assert.equal(f.workers.length,2,'No replacement needed once the queue is empty');
});

test('a single crashed worker is replaced only after retirement and duplicate exit events cannot settle replacement work',async t=>{
  const f=fixture(t),done=f.run([task(1),task(2),task(3)]);f.ready(0);const original=f.workers[0].sent[0];
  let release;f.workers[0].terminate=()=>new Promise(resolve=>{release=()=>{f.workers[0].emit('exit',1);resolve(1);};});
  f.workers[0].emit('error',new Error('Crash.'));await turn();assert.equal(f.workers.length,1);
  release();await turn();assert.equal(f.workers.length,2);assert.equal(f.failed.length,1);f.ready(1);
  f.workers[0].emit('exit',1);f.workers[0].emit('error',new Error('Duplicate.'));f.send(0,'complete',{stage:{}},original);
  assert.equal(f.failed.length,1);assert.equal(f.completed.length,0);
  f.send(1,'complete',{stage:{}});f.send(1,'complete',{stage:{}});await done;
  assert.deepEqual(f.completed.map(value=>value.task.trial.parameter_set_id),['P2','P3']);assert.equal(f.workers.length,2);
});

test('repeated native crashes exhaust a bounded replacement budget and attribute every unavailable queued task',async t=>{
  const f=fixture(t),done=f.run([task(1),task(2),task(3),task(4)]);f.ready(0);
  f.workers[0].emit('exit',1);await turn();assert.equal(f.workers.length,2);f.ready(1);
  f.workers[1].emit('exit',1);await done;
  assert.deepEqual(f.failed.map(value=>value.error.code),['worker_crash','worker_crash','worker_unavailable','worker_unavailable']);
  assert.equal(f.failed.length,4);assert.equal(f.completed.length,0);assert.equal(f.workers.length,2);
  assert.equal(f.progress.at(-1).failed_tasks,4);assert.equal(f.progress.at(-1).completed_tasks,4);
  await f.run([task(5)]);assert.equal(f.failed.at(-1).error.code,'worker_unavailable');assert.equal(f.workers.length,2);
});

test('worker-constructor failures cannot cause an unbounded respawn loop or leave queued tasks hanging',async t=>{
  let attempts=0;const f=fixture(t,{workerLimit:2,workerFactory:()=>{attempts++;throw new Error('Cannot start worker.');}});
  await f.run([task(1),task(2),task(3)]);
  assert.equal(attempts,4);assert.equal(f.failed.length,3);assert.ok(f.failed.every(value=>value.error.code==='worker_unavailable'));
  assert.equal(f.progress.at(-1).completed_tasks,3);assert.equal(f.progress.at(-1).active_workers,0);
});

test('startup failures leave the available healthy worker free to finish every queued task',async t=>{
  let attempts=0;const completed=[],failed=[],worker=new EventEmitter();worker.threadId=1;worker.sent=[];
  worker.postMessage=message=>worker.sent.push(message);worker.terminate=async()=>{worker.emit('exit',0);return 0;};
  const pool=new OptimizerPool({}, {workerLimit:2,workerFactory:()=>{if(++attempts!==2)throw new Error('Worker startup failed.');return worker;}});t.after(()=>pool.close());
  const done=pool.runBatch([task(1),task(2),task(3)],{onComplete:task=>completed.push(task),onFailure:task=>failed.push(task)});
  worker.emit('message',{type:'ready'});
  for(let index=0;index<3;index++)worker.emit('message',{type:'complete',task_id:worker.sent.at(-1).task_id,stage:{}});
  await done;assert.equal(attempts,4);assert.equal(completed.length,3);assert.equal(failed.length,0);
});

test('an idle exited worker is replaced only when a later phase actually queues work',async t=>{
  const f=fixture(t);f.ready(0);f.workers[0].emit('exit',1);await turn();assert.equal(f.workers.length,1);
  const done=f.run([task(1)]);assert.equal(f.workers.length,2);f.ready(1);f.send(1,'complete',{stage:{}});await done;
  assert.equal(f.completed.length,1);assert.equal(f.failed.length,0);
});

test('a postMessage failure retires the affected worker and continues the queue',async t=>{
  const f=fixture(t),done=f.run([task(1),task(2)]);
  f.workers[0].postMessage=()=>{throw new Error('Worker channel is closed.');};f.ready(0);await turn();
  assert.equal(f.failed[0].error.code,'worker_dispatch');assert.equal(f.workers[0].terminations,1);assert.equal(f.workers.length,2);
  f.ready(1);f.send(1,'complete',{stage:{}});await done;assert.equal(f.completed.length,1);
});

for(const kind of ['deadline','cancel'])test(`a global ${kind} rejects and closes every worker instead of recording a candidate failure`,async t=>{
  const f=fixture(t,{workerLimit:2}),done=f.run([task(1),task(2),task(3)]);f.ready(0);f.ready(1);
  const rejected=assert.rejects(done,error=>kind==='deadline'?error.optimizationBudget===true:error.name==='AbortError');
  f.send(0,'failed',{error:'Global work stopped.',...(kind==='deadline'?{optimizationBudget:true}:{name:'AbortError'})});
  await rejected;await f.pool.close();assert.equal(f.failed.length,0);assert.equal(f.completed.length,0);
  assert.ok(f.workers.every(worker=>worker.terminations===1));assert.equal(f.workers.length,2);
});

test('global guards and scheduler hooks remain fatal and do not leave active workers',async t=>{
  const f=fixture(t);f.ready(0);
  const done=f.pool.runBatch([task(1)],{prepare:()=>{throw new Error('Invalid scheduler context.');}});
  await assert.rejects(done,/Invalid scheduler context/);await f.pool.close();assert.equal(f.workers[0].terminations,1);
  assert.equal(f.workers[0].sent.length,0);
});

test('a guard cancellation after task dispatch joins the worker without recording a candidate result',async t=>{
  let cancel=false;const f=fixture(t,{guard:()=>{if(cancel)throw Object.assign(new Error('Cancelled.'),{name:'AbortError'});}}),done=f.run([task(1),task(2)]);f.ready(0);
  const rejected=assert.rejects(done,error=>error.name==='AbortError');cancel=true;f.send(0,'complete',{stage:{}});
  await rejected;await f.pool.close();assert.equal(f.failed.length,0);assert.equal(f.completed.length,0);assert.equal(f.workers[0].terminations,1);
});

function realContext(){
  const from='2026-09-14',start=Date.parse(from+'T09:15:00+05:30');
  const bars=Array.from({length:75},(_,index)=>({time:new Date(start+index*300000).toISOString(),open:100,high:101,low:99,close:100,volume:1000}));
  return {datasets:[{interval:'5minute',symbols:{TEST:bars}}],common:{},incumbent:{enhanced_signals:true},limits:{min_trades:1,max_drawdown_pct:5},ranges:{'5minute':{train:{from,to:from}}}};
}

test('a real healthy thread handles a failed task and then calculates a later task',{timeout:5000},async t=>{
  const events=[],failed=[],completed=[],progress=[],pool=new OptimizerPool(realContext(),{workerLimit:1,onWorkerEvent:event=>events.push(event)});t.after(()=>pool.close());
  const invalid={...task(1),phase:'invalid_phase'};
  await pool.runBatch([invalid,task(2)],{onFailure:(task,error)=>failed.push({task,error}),onComplete:(task,stage)=>completed.push({task,stage}),onProgress:value=>progress.push(value)});
  assert.equal(failed.length,1);assert.equal(failed[0].error.code,'candidate_error');assert.equal(failed[0].error.interval,'5minute');
  assert.equal(completed.length,1);assert.equal(completed[0].task.trial.parameter_set_id,'P2');assert.ok(completed[0].stage['5minute'].metrics);
  assert.equal(events.filter(event=>event.type==='created').length,1);assert.equal(progress.at(-1).failed_tasks,1);await pool.close();
  assert.ok(progress.some(update=>update.active_sets.some(set=>set.parameter_set_id==='P2'&&set.progress===0)));
  assert.ok(progress.some(update=>update.active_sets.some(set=>set.parameter_set_id==='P2'&&set.progress===1&&set.processed_bars===75&&set.total_bars===75)));
  assert.deepEqual(progress.at(-1).active_sets,[]);
  assert.equal(events.filter(event=>event.type==='stopped').length,1);
});

test('a real native worker exit is replaced and the remaining candidate completes',{timeout:5000},async t=>{
  const events=[],failed=[],completed=[];let created=0;
  const pool=new OptimizerPool(realContext(),{workerLimit:1,onWorkerEvent:event=>events.push(event),workerFactory:(url,options)=>{
    if(created++===0)return new Worker("const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>process.exit(7));parentPort.postMessage({type:'ready'});",{eval:true,execArgv:[]});
    return new Worker(url,options);
  }});t.after(()=>pool.close());
  await pool.runBatch([task(1),task(2)],{onFailure:(task,error)=>failed.push({task,error}),onComplete:(task,stage)=>completed.push({task,stage})});
  assert.equal(created,2);assert.equal(failed.length,1);assert.equal(failed[0].error.code,'worker_crash');assert.equal(completed.length,1);
  await pool.close();assert.equal(events.filter(event=>event.type==='stopped').length,2);
});
