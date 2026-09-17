import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';

test('comparison worker flushes latest progress during a silent long batch and resets at the next pass',{timeout:5000},async t=>{
  // Exercise the real worker transport with a deterministic comparison driver.
  // A silent asynchronous batch reproduces the previously dropped final update
  // without depending on native thread startup speed or costly trading fixtures.
  const source=readFileSync(new URL('../src/backtest-worker.js',import.meta.url),'utf8');
  const replacement=`async function compareStrategiesParallel(_dataset,_options,hooks){
    const send=(phase,progress,phase_progress,processed_bars,active_workers,batch_timestamp)=>hooks.onProgress({
      phase,progress,phase_progress,processed_bars,total_bars:100,
      parallelism:{worker_limit:3,active_workers,batch_completed_symbols:0,batch_total_symbols:active_workers?3:0,batch_timestamp},
    });
    send('baseline',0,0,0,0,null);
    send('baseline',.1,.2,20,2,'2026-09-14T04:00:00.000Z');
    send('baseline',.2,.4,40,3,'2026-09-14T04:05:00.000Z');
    await new Promise(resolve=>setTimeout(resolve,220));
    parentPort.postMessage({type:'silent_batch_checkpoint'});
    send('baseline',.5,1,100,0,null);
    send('enhanced',.5,0,0,0,null);
    send('enhanced',.6,.2,20,2,'2026-09-14T04:00:00.000Z');
    send('enhanced',1,1,100,0,null);
    return {verified:true};
  }`;
  const patched=source.replace("import { compareStrategiesParallel } from './backtest-parallel.js';",replacement);
  assert.notEqual(patched,source,'The isolated test must replace only the comparison calculation');
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(patched)),{workerData:{dataset:{},options:{}},execArgv:[]});
  t.after(()=>worker.terminate());
  const messages=[];worker.on('message',value=>messages.push(value));
  assert.deepEqual(await once(worker,'exit'),[0]);
  const checkpoint=messages.findIndex(value=>value.type==='silent_batch_checkpoint');
  assert.ok(checkpoint>0);
  const quietUpdate=messages.slice(0,checkpoint).find(value=>value.type==='progress'&&value.processed_bars===40);
  assert.ok(quietUpdate,'The most recent update must arrive before the long batch produces another callback');
  assert.equal(quietUpdate.parallelism.active_workers,3);assert.equal(quietUpdate.phase_progress,.4);assert.equal(quietUpdate.progress,.2);
  const firstEnhanced=messages.find(value=>value.type==='progress'&&value.phase==='enhanced');
  assert.equal(firstEnhanced.processed_bars,0);assert.equal(firstEnhanced.phase_progress,0);assert.equal(firstEnhanced.parallelism.batch_timestamp,null);
  assert.equal(messages.at(-2).phase_progress,1);assert.equal(messages.at(-2).parallelism.active_workers,0);
  assert.deepEqual(messages.at(-1),{type:'complete',result:{verified:true}});
});
