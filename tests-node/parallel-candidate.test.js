import test from 'node:test';
import assert from 'node:assert/strict';
import {runBacktest} from '../src/backtest.js';
import {runBacktestParallel} from '../src/backtest-parallel.js';
import {evaluateOptimizationTask,evaluateOptimizationTaskParallel} from '../src/optimizer.js';
import {evaluateComparisonTask} from '../src/backtest-analytics.js';
import {ENHANCED_DEFAULTS} from '../src/strategy.js';

const breakout={...ENHANCED_DEFAULTS,enhanced_signals:true,enable_breakout:true,enable_pullback:false,enable_reversion:false,
  enable_opening_range:false,enable_opening_drive:false,enable_gap_continuation:false,enable_gap_reversal:false,
  enable_vwap_reclaim:false,enable_vwap_rejection:false,enable_volatility_squeeze:false,enable_relative_strength:false,higher_timeframe_filter:false};
// Small explicit costs leave narrow-range synthetic trades eligible for parity checks.
const options={initial_capital:10000,max_runtime_ms:60000,fee_rate:.0001,slippage_rate:.00005,max_position_pct:.6,risk_per_trade_pct:.02,strategy_options:breakout};
const automatic={mode:'automatic',status:'automatic',reason:'Offline test uses OS scheduling.',assignments:[]};
function session(day='2026-09-14',short=false){
  const start=Date.parse(day+'T09:15:00+05:30'),bars=[];
  for(let i=0;i<75;i++){
    const close=i<34?100+i*.02+Math.sin(i*.8)*.2:bars[33].close+(i<=44?(i-33)*.02:.22-(i-44)*.015),open=bars.at(-1)?.close??close-.1;
    const row={time:new Date(start+i*300000),open,close,high:Math.max(open,close)+.05,low:Math.min(open,close)-.05,volume:1000};bars.push(row);
    if(i===33){const previous=bars[31],high=Math.max(...bars.slice(-21,-1).map(value=>value.high));Object.assign(row,{open:previous.close-.02,close:high+.2,high:high+.22,low:previous.close-.04,volume:4000});}
  }
  return short?bars.map(row=>({...row,open:200-row.open,close:200-row.close,high:200-row.low,low:200-row.high})):bars;
}
function intraday(){return {interval:'5minute',symbols:{ALPHA:session(),BETA:session('2026-09-14',true),GAMMA:session()}};}
function daily(){
  const rows=Array.from({length:62},(_,index)=>{const close=index<54?100+index*.1:index<58?106+(index-54)*.1:95,open=index===58?106.3:close-.1;
    return {time:new Date(Date.parse('2026-06-01T09:15:00+05:30')+index*86400000),open,close,high:Math.max(open,close)+.05,low:Math.min(open,close)-.2,volume:index===54?3000:1000};});
  return {interval:'day',symbols:{ALPHA:rows,BETA:structuredClone(rows)}};
}
const task={trial:{id:'incumbent',parameter_set_id:'P1',parameters:{}},phase:'tuning_train',remaining_ms:60000,parallelism:3};
function context(datasets=[intraday()]){
  return {datasets,common:{initial_capital:10000,fee_rate:.001,slippage_rate:.0005,max_position_pct:.6,risk_per_trade_pct:.02},incumbent:breakout,
    limits:{min_trades:1,max_drawdown_pct:5},ranges:{'5minute':{train:{from:'2026-09-14',to:'2026-09-14'}},day:{train:{from:'2026-06-01',to:'2026-08-01'}}}};
}

test('single-run parallel analytics reproduce the entire serial shared-portfolio report',async()=>{
  const dataset=intraday(),before=structuredClone(dataset),events=[],progress=[];
  const expected=runBacktest(dataset,options),actual=await runBacktestParallel(dataset,{...options,parallelism:3,affinity_plan:automatic},{onWorkerEvent:value=>events.push(value),onProgress:value=>progress.push(value)});
  assert.deepEqual(actual,expected);assert.deepEqual(dataset,before);
  assert.ok(actual.trades.some(trade=>trade.side==='BUY'));assert.ok(actual.trades.some(trade=>trade.side==='SELL'));
  assert.equal(new Set(events.filter(event=>event.type==='task_complete').map(event=>event.thread_id)).size,3);
  assert.equal(events.filter(event=>event.type==='stopped').length,3);
  assert.ok(progress.some(value=>value.parallelism.active_workers>1));assert.equal(progress.at(-1).progress,1);
  assert.equal(progress.at(-1).parallelism.active_workers,0);assert.equal(progress.at(-1).parallelism.batch_timestamp,null);
  assert.ok(progress.at(-1).parallelism.workers.every(worker=>worker.state==='stopped'));
});

test('single-run parallel daily protection and next-open fills remain exactly serial',async()=>{
  const dataset=daily(),config={...options,strategy_options:{enhanced_signals:false},max_positions:1,max_position_pct:1,risk_per_trade_pct:1};
  const expected=runBacktest(dataset,config),actual=await runBacktestParallel(dataset,{...config,parallelism:2});
  assert.deepEqual(actual,expected);assert.ok(actual.trades.length>0);assert.equal(actual.trades[0].symbol,'ALPHA');
});

test('single-run score windows retain causal warmup and benchmark/sector context',async()=>{
  const rows=[...session(),...session('2026-09-15')],gapped=structuredClone(rows);gapped.splice(109,1);
  const dataset={interval:'5minute',symbols:{ALPHA:rows,BETA:gapped},benchmark_bars:rows,sector_bars:{TECH:rows},symbol_sectors:{ALPHA:'TECH',BETA:'TECH'}};
  const config={...options,score_from:'2026-09-15',score_to:'2026-09-15'};
  assert.deepEqual(await runBacktestParallel(dataset,{...config,parallelism:2}),runBacktest(dataset,config));
});

test('async candidates share exact serial scoring across intraday and daily intervals',async()=>{
  const input=context([intraday(),daily()]),before=structuredClone(input),events=[],progress=[];
  const expected=evaluateOptimizationTask(input,task,{now:()=>0});
  const actual=await evaluateOptimizationTaskParallel(input,task,{now:()=>0,onWorkerEvent:value=>events.push(value),onProgress:value=>progress.push(value)});
  assert.deepEqual(actual,expected);assert.deepEqual(input,before);
  assert.equal(events.filter(event=>event.type==='created').length,6);assert.equal(events.filter(event=>event.type==='stopped').length,6);
  const firstDaily=progress.find(value=>value.interval==='day');assert.equal(firstDaily.processed_bars,0);assert.equal(firstDaily.progress,.5);assert.equal(firstDaily.parallelism,undefined);
  assert.ok(progress.some(value=>value.parallelism?.active_workers>1));
  assert.ok(progress.every((value,index)=>!index||value.progress>=progress[index-1].progress));
  assert.ok(progress.slice(0,-1).every(value=>value.progress<1));assert.equal(progress.at(-1).completed_intervals,2);
  assert.ok(progress.at(-1).parallelism.workers.every(worker=>worker.state==='stopped'));
});

test('candidate resource assignment reaches its stock pool without entering financial options',async()=>{
  const input=context(),plan={mode:'pinned',status:'planned',assignments:[{group:1,cpu:2,core:7}]};let config,closed=false;
  const expected=evaluateOptimizationTask(input,task,{now:()=>0});
  const actual=await evaluateOptimizationTaskParallel(input,{...task,parallelism:1,affinity_plan:plan,analytics_worker_heap_mib:96},{now:()=>0,poolFactory:value=>{
    config=value;return {snapshot:()=>({workers:[]}),async evaluate(tasks,{strategy_options}){return tasks.map(value=>evaluateComparisonTask(value,strategy_options));},async close(){closed=true;}};
  }});
  assert.deepEqual(actual,expected);assert.equal(config.workerLimit,1);assert.equal(config.workerHeapMiB,96);assert.deepEqual(config.affinityPlan,plan);assert.equal(closed,true);
});

test('cancelling a live parallel candidate joins all stock workers before rejecting',{timeout:5000},async()=>{
  const input=context(),created=[],stopped=[];let cancel=false;
  await assert.rejects(evaluateOptimizationTaskParallel(input,task,{cancelled:()=>cancel,
    onWorkerEvent:event=>{if(event.type==='created')created.push(event.thread_id);if(event.type==='stopped')stopped.push(event.thread_id);},
    onProgress:value=>{if(value.parallelism?.active_workers>0)cancel=true;},
  }),error=>error.name==='AbortError');
  assert.equal(created.length,3);assert.deepEqual(new Set(stopped),new Set(created));
});

test('already cancelled candidates allocate no stock worker pool',async()=>{
  await assert.rejects(evaluateOptimizationTaskParallel(context(),task,{cancelled:()=>true,poolFactory:()=>assert.fail('Cancelled candidate cannot allocate threads')}),error=>error.name==='AbortError');
});

test('incomplete stock analytics fail one candidate with interval attribution and joined cleanup',async()=>{
  let closed=false;
  await assert.rejects(evaluateOptimizationTaskParallel(context(),task,{poolFactory:()=>({snapshot:()=>({workers:[]}),async evaluate(){return [];},async close(){closed=true;}})}),
    error=>error.interval==='5minute'&&/incomplete timestamp batch/.test(error.message));
  assert.equal(closed,true);
});

test('async candidate budget exhaustion after awaited analytics cannot return a stage',async()=>{
  let now=0,closed=false;
  await assert.rejects(evaluateOptimizationTaskParallel(context(),{...task,remaining_ms:1000},{now:()=>now,poolFactory:()=>({snapshot:()=>({workers:[]}),
    async evaluate(tasks,{strategy_options}){const values=tasks.map(value=>evaluateComparisonTask(value,strategy_options));now=1001;return values;},async close(){closed=true;},
  })}),error=>error.optimizationBudget===true);
  assert.equal(closed,true);
});

test('async stage failures and cancellation after final candles never emit successful completion',async()=>{
  for(const kind of ['report_failure','cancel']){
    let cancelled=false;const progress=[];
    await assert.rejects(evaluateOptimizationTaskParallel(context(),task,{cancelled:()=>cancelled,onProgress:value=>{progress.push(value);if(kind==='cancel'&&value.processed_bars===value.total_bars)cancelled=true;},
      runBacktestParallel:async(dataset,_options,hooks)=>{const total=Object.values(dataset.symbols).reduce((count,rows)=>count+rows.length,0);hooks.onProgress({processed_bars:total,total_bars:total});
        if(kind==='report_failure')throw new Error('Synthetic late report failure');return {metrics:{},data_quality:{}};},
    }),error=>kind==='cancel'?error.name==='AbortError':error.interval==='5minute');
    assert.ok(progress.every(value=>value.progress<1));
  }
});

test('single-run resource bounds reject invalid parallelism before spawning',async()=>{
  for(const parallelism of [0,101,1.5,'3'])await assert.rejects(runBacktestParallel(intraday(),{...options,parallelism},{poolFactory:()=>assert.fail('Invalid limit must not spawn')}),/parallelism/);
});
