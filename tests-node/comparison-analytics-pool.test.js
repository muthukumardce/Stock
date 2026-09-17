import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {ComparisonAnalyticsPool} from '../src/comparison-analytics-pool.js';
import {evaluateComparisonTask} from '../src/backtest-analytics.js';
import {daily_holding_exit,technical_exit,intraday_signal,swing_signal} from '../src/strategy.js';

function task(symbol='TEST'){
  const start=Date.parse('2026-09-14T09:15:00+05:30');
  const history=Array.from({length:30},(_,index)=>{const close=index<20?100:100.6;return {time:new Date(start+index*300000),open:index===20?100.1:close,high:close+.1,low:close-.1,close,volume:index===20?3000:1000};});
  return {symbol,strategy:'intraday',history,context:{as_of:new Date(start+30*300000),previous_bars:[],benchmark_bars:[],sector_bars:[]},position:null,signal:true};
}
function fixture(t,options={}){
  const workers=[],progress=[],events=[];
  const pool=new ComparisonAnalyticsPool({workerLimit:3,onProgress:value=>progress.push(value),onWorkerEvent:value=>events.push(value),workerFactory:(url,options)=>{
    const worker=new EventEmitter();worker.threadId=workers.length+1;worker.options=options;worker.sent=[];worker.terminations=0;
    worker.postMessage=message=>worker.sent.push(message);worker.terminate=async()=>{worker.terminations++;worker.emit('exit',0);return 0;};workers.push(worker);return worker;
  },...options});
  t.after(()=>pool.close());
  return {pool,workers,progress,events,ready:()=>workers.forEach(worker=>worker.emit('message',{type:'ready'})),
    complete:(index,assignment=workers[index].sent.at(-1))=>workers[index].emit('message',{type:'complete',task_id:assignment.task_id,results:assignment.tasks.map(item=>({daily:null,technical:null,signal:null,reason:item.symbol}))}),
  };
}

test('shared comparison analytics match direct signal rules and leave input history and positions untouched',()=>{
  const input=task(),before=structuredClone(input),options={enhanced_signals:true};
  const [signal,reason]=intraday_signal(input.history,options,input.context);
  assert.deepEqual(evaluateComparisonTask(input,options),{daily:null,technical:null,signal,reason});assert.deepEqual(input,before);
  const daily=Array.from({length:60},(_,index)=>{const close=100+index*.1;return {time:new Date(Date.UTC(2026,0,1+index)),open:close-.1,high:close+.2,low:close-.2,close,volume:1000};});
  const held={...input,strategy:'swing',history:daily,position:{strategy:'swing',side:'BUY',stop:99,target:110,trailing_stop:99,entry_time:'2026-01-01'},signal:false},saved=structuredClone(held);
  const protection=daily_holding_exit(daily,held.position,options),copy={...held.position};
  if(protection){copy.stop=copy.trailing_stop=Math.max(copy.stop,protection.trailing_stop);if(protection.trend_exit)copy.pending_exit='daily_trend_loss';}
  assert.deepEqual(evaluateComparisonTask(held,options),{daily:protection,technical:technical_exit(daily,copy,options,input.context),signal:null,reason:null});
  assert.deepEqual(held,saved);
  const unheld={...held,position:null,signal:true},[swing,why]=swing_signal(daily,options,unheld.context);
  assert.deepEqual(evaluateComparisonTask(unheld,options),{daily:null,technical:null,signal:swing,reason:why});
});

test('out-of-order chunks preserve exact symbol order and persistent workers accept the next timestamp',async t=>{
  const f=fixture(t);f.ready();const symbols=['A','B','C','D','E'],done=f.pool.evaluate(symbols.map(symbol=>task(symbol)),{phase:'enhanced'});
  assert.equal(f.workers.filter(worker=>worker.sent.length).length,3);assert.equal(f.progress[0].active_workers,3);
  const old=f.workers[0].sent[0];for(const index of [2,0,1])f.complete(index);
  assert.deepEqual((await done).map(value=>value.reason),symbols);
  assert.deepEqual(f.pool.snapshot(),{worker_limit:3,active_workers:0,batch_completed_symbols:5,batch_total_symbols:5});
  const second=f.pool.evaluate([task('NEXT')]);f.complete(0,old);assert.equal(f.pool.snapshot().batch_completed_symbols,0);
  f.complete(0);assert.equal((await second)[0].reason,'NEXT');assert.equal(f.workers.length,3);
});

test('queued candle counts are visible while native workers initialize',async t=>{
  const f=fixture(t),done=f.pool.evaluate([task('A'),task('B'),task('C')]);
  assert.deepEqual(f.progress,[{worker_limit:3,active_workers:0,batch_completed_symbols:0,batch_total_symbols:3}]);
  f.ready();assert.ok(f.progress.some(value=>value.active_workers>0));
  for(let index=0;index<3;index++)f.complete(index);
  assert.equal((await done).length,3);
  assert.deepEqual(f.progress.at(-1),{worker_limit:3,active_workers:0,batch_completed_symbols:3,batch_total_symbols:3});
});

test('ordinary worker completions share one progress flush while batch start and finish stay exact',async t=>{
  let now=0;const timers=[],f=fixture(t,{now:()=>now,setProgressTimer:(callback,delay)=>{const timer={callback,delay,cleared:false,unref(){}};timers.push(timer);return timer;},clearProgressTimer:timer=>{timer.cleared=true;}});
  f.ready();const done=f.pool.evaluate([task('A'),task('B'),task('C')]);
  assert.equal(f.progress.length,1);assert.equal(f.progress[0].active_workers,3);
  f.complete(0);f.complete(1);assert.equal(f.progress.length,1);assert.equal(timers.length,1);assert.equal(timers[0].delay,200);
  now=200;timers[0].callback();assert.equal(f.progress.length,2);assert.deepEqual(f.progress[1],{worker_limit:3,active_workers:1,batch_completed_symbols:2,batch_total_symbols:3});
  f.complete(2);await done;assert.equal(f.progress.at(-1).batch_completed_symbols,3);assert.equal(f.progress.at(-1).active_workers,0);
  const emitted=f.progress.length;await f.pool.close();for(const timer of timers)timer.callback();assert.equal(f.progress.length,emitted);
});

test('streaming worker count and message sizes are bounded while uneven batches use every available worker',async t=>{
  const f=fixture(t,{workerLimit:999,workerHeapMiB:9999});assert.equal(f.workers.length,100);f.ready();
  const done=f.pool.evaluate(Array.from({length:150},(_,index)=>task('S'+index)));
  assert.equal(f.workers.filter(worker=>worker.sent.length).length,100);
  for(const worker of f.workers){assert.equal(worker.options.resourceLimits.maxOldGenerationSizeMb,128);assert.deepEqual(Object.keys(worker.options.workerData),['cancellation']);assert.ok(worker.sent[0].tasks.length<=2);assert.ok(!('dataset'in worker.sent[0]));}
  for(let index=99;index>=0;index--)f.complete(index);assert.equal((await done).length,150);
  await f.pool.close();assert.ok(f.workers.every(worker=>worker.terminations===1));
});

test('large universes on few CPUs queue bounded chunks instead of copying the entire batch into each worker',async t=>{
  const f=fixture(t,{workerLimit:2});f.ready();const tasks=Array.from({length:150},(_,index)=>task('S'+index)),done=f.pool.evaluate(tasks),completed=new Set();
  while(completed.size<5)for(let index=0;index<f.workers.length;index++){
    const assignment=f.workers[index].sent.at(-1);if(!assignment||completed.has(assignment.task_id))continue;
    assert.ok(assignment.tasks.length<=32);completed.add(assignment.task_id);f.complete(index);
  }
  assert.deepEqual((await done).map(value=>value.reason),tasks.map(value=>value.symbol));assert.equal(f.workers.length,2);
});

test('overlapping candle batches reject while malformed bounded requests never reach a worker',async t=>{
  const f=fixture(t);f.ready();
  await assert.rejects(f.pool.evaluate(Array(5001)),/5000/);
  await assert.rejects(f.pool.evaluate([{...task(),history:Array(201)}]),/bounded/);
  await assert.rejects(f.pool.evaluate([{...task(),context:{benchmark_bars:Array(201)}}]),/200 candles/);
  const pending=f.pool.evaluate([task()]);await assert.rejects(f.pool.evaluate([task()]),/overlap/);f.complete(0);await pending;
});

test('a crash discards the incomplete comparison batch and joins every worker before rejection',async t=>{
  const f=fixture(t);f.ready();const done=f.pool.evaluate([task('A'),task('B'),task('C')]);
  f.complete(0);f.workers[1].emit('error',new Error('Synthetic crash'));
  await assert.rejects(done,/Synthetic crash/);assert.ok(f.workers.every(worker=>worker.terminations===1));assert.equal(f.pool.snapshot().active_workers,0);
  await assert.rejects(f.pool.evaluate([task()]),/Synthetic crash/);
});

test('guard deadline and cancellation preserve their typed error and retire all nested workers',async t=>{
  for(const error of [Object.assign(new Error('Variant budget reached'),{code:'worker_timeout'}),Object.assign(new Error('Stopped'),{name:'AbortError'})]){
    let stop=false;const f=fixture(t,{guard:()=>{if(stop)throw error;}});f.ready();const done=f.pool.evaluate([task(),task('B'),task('C')]);
    stop=true;f.complete(0);await assert.rejects(done,value=>value===error);assert.ok(f.workers.every(worker=>worker.terminations===1));
    assert.equal(Atomics.load(new Int32Array(f.workers[0].options.workerData.cancellation),0),1);
  }
});

test('close waits for all worker retirement and a late response cannot publish partial results',async t=>{
  const f=fixture(t);f.ready();const releases=[];
  for(const worker of f.workers)worker.terminate=()=>new Promise(resolve=>releases.push(()=>{worker.terminations++;worker.emit('exit',0);resolve();}));
  let settled=false;const done=f.pool.evaluate([task(),task('B'),task('C')]).finally(()=>{settled=true;});const rejected=assert.rejects(done,{name:'AbortError'});
  const closed=f.pool.close();await Promise.resolve();f.complete(0);await Promise.resolve();assert.equal(settled,false);
  releases[0]();releases[1]();await Promise.resolve();assert.equal(settled,false);releases[2]();await closed;await rejected;
  assert.ok(f.workers.every(worker=>worker.terminations===1));
});

test('worker protocol failures and constructor failures do not leave a pending batch or surviving child',async t=>{
  const f=fixture(t);f.ready();const done=f.pool.evaluate([task()]);const assignment=f.workers[0].sent[0];
  f.workers[0].emit('message',{type:'complete',task_id:assignment.task_id,results:[]});await assert.rejects(done,/invalid result/);assert.ok(f.workers.every(worker=>worker.terminations===1));
  let attempts=0;const pool=new ComparisonAnalyticsPool({workerLimit:3,workerFactory:()=>{attempts++;throw new Error('Cannot start worker');}});t.after(()=>pool.close());
  await assert.rejects(pool.evaluate([task()]),/Cannot start/);assert.equal(attempts,1);
});

test('real persistent CPU workers reproduce direct analytics and terminate on cancellation',{timeout:5000},async t=>{
  const events=[],workers=[],pool=new ComparisonAnalyticsPool({workerLimit:3,onWorkerEvent:event=>events.push(event),workerFactory:(url,options)=>{const worker=new Worker(url,options);workers.push(worker);return worker;}});t.after(()=>pool.close());
  for(let attempt=0;attempt<200&&events.filter(event=>event.type==='ready').length<3;attempt++)await delay(5);
  assert.equal(events.filter(event=>event.type==='ready').length,3);
  const tasks=Array.from({length:9},(_,index)=>task('S'+index)),options={enhanced_signals:true};
  const result=await pool.evaluate(tasks,{strategy_options:options,phase:'enhanced'});
  assert.deepEqual(result,structuredClone(tasks.map(value=>evaluateComparisonTask(value,options))));
  assert.equal(new Set(events.filter(event=>event.type==='created').map(event=>event.thread_id)).size,3);
  assert.equal(new Set(events.filter(event=>event.type==='task_complete').map(event=>event.thread_id)).size,3,'All three real CPU threads must calculate part of the same timestamp batch');
  const second=pool.evaluate(Array.from({length:150},(_,index)=>task('N'+index)),{strategy_options:options});const rejected=assert.rejects(second,{name:'AbortError'});
  await pool.close();await rejected;assert.ok(workers.every(worker=>worker.threadId===-1));
});

test('a hung worker is interrupted by the periodic guard without waiting for a result',{timeout:3000},async t=>{
  let expired=false;const f=fixture(t,{guard:()=>{if(expired)throw Object.assign(new Error('Deadline'),{code:'worker_timeout'});}});f.ready();
  const done=f.pool.evaluate([task()]);const rejected=assert.rejects(done,error=>error.code==='worker_timeout');expired=true;
  await delay(50);await rejected;assert.ok(f.workers.every(worker=>worker.terminations===1));
});
