import test from 'node:test';
import assert from 'node:assert/strict';
import {compareStrategies} from '../src/backtest.js';
import {compareStrategiesParallel} from '../src/backtest-parallel.js';
import {evaluateComparisonTask} from '../src/backtest-analytics.js';

const options={initial_capital:10000,fee_rate:.001,slippage_rate:.0005,max_runtime_ms:60000};
const breakout={enhanced_signals:true,enable_breakout:true,enable_pullback:false,enable_reversion:false,
  enable_opening_range:false,enable_opening_drive:false,enable_gap_continuation:false,enable_gap_reversal:false,
  enable_vwap_reclaim:false,enable_vwap_rejection:false,enable_volatility_squeeze:false,enable_relative_strength:false,higher_timeframe_filter:false};
function session(day='2026-09-14',short=false){
  const start=Date.parse(day+'T09:15:00+05:30'),bars=[];
  for(let i=0;i<75;i++){
    const close=i<34?100+i*.02+Math.sin(i*.8)*.2:bars[33].close+(i<=44?(i-33)*.02:.22-(i-44)*.015),open=bars.at(-1)?.close??close-.1;
    const bar={time:new Date(start+i*300000),open,close,high:Math.max(open,close)+.05,low:Math.min(open,close)-.05,volume:1000};
    bars.push(bar);
    if(i===33){const previous=bars[31],high=Math.max(...bars.slice(-21,-1).map(row=>row.high));Object.assign(bar,{open:previous.close-.02,close:high+.2,high:high+.22,low:previous.close-.04,volume:4000});}
  }
  return short?bars.map(bar=>({...bar,open:200-bar.open,close:200-bar.close,high:200-bar.low,low:200-bar.high})):bars;
}
function intraday(){return {interval:'5minute',symbols:{ALPHA:session(),BETA:session('2026-09-14',true),GAMMA:session()}};}
function daily(){
  const rows=Array.from({length:62},(_,i)=>{
    const close=i<54?100+i*.1:i<58?106+(i-54)*.1:95,open=i===58?106.3:close-.1;
    return {time:new Date(Date.parse('2026-06-01T09:15:00+05:30')+i*86400000),open,close,high:Math.max(open,close)+.05,low:Math.min(open,close)-.2,volume:i===54?3000:1000};
  });return {interval:'day',symbols:{ALPHA:rows,BETA:structuredClone(rows)}};
}

test('parallel comparison preserves the full serial portfolio report for simultaneous long and short candidates',async()=>{
  const data=intraday(),before=structuredClone(data),config={...options,enhanced_options:breakout,max_position_pct:.6,risk_per_trade_pct:.02};
  const expected=compareStrategies(data,config),events=[],progress=[];
  const actual=await compareStrategiesParallel(data,{...config,parallelism:3},{onWorkerEvent:event=>events.push(event),onProgress:value=>progress.push(structuredClone(value))});
  assert.deepEqual(actual,expected);assert.deepEqual(data,before);
  assert.ok(actual.enhanced.trades.some(trade=>trade.side==='BUY'));assert.ok(actual.enhanced.trades.some(trade=>trade.side==='SELL'));
  assert.ok(actual.enhanced.equity.every(point=>point.cash>=-1e-8));
  const calculated=new Set(events.filter(event=>event.type==='task_complete').map(event=>event.thread_id));assert.ok(calculated.size>1);
  assert.equal(events.filter(event=>event.type==='stopped').length,3);
  assert.ok(progress.some(value=>value.parallelism.active_workers>1));assert.equal(progress.at(-1).progress,1);
  assert.ok(progress.every((value,index)=>index===0||value.progress>=progress[index-1].progress));
});

test('parallel swing comparison preserves entry-time and closing ATR protection and exact portfolio results',async()=>{
  const data=daily(),config={...options,max_position_pct:1,risk_per_trade_pct:1,max_positions:1};
  const expected=compareStrategies(data,config),actual=await compareStrategiesParallel(data,{...config,parallelism:2});
  assert.deepEqual(actual,expected);assert.ok(expected.baseline.trades.length>0);
  assert.equal(expected.baseline.trades[0].symbol,'ALPHA','A tied second stock cannot obtain a separate cash account');
});

test('parallel comparison keeps causal data gaps, prior sessions and benchmark context identical',async()=>{
  const prior=session('2026-09-14'),current=session('2026-09-15'),all=[...prior,...current],gapped=structuredClone(all);gapped.splice(109,1);
  const data={interval:'5minute',symbols:{ALPHA:all,BETA:gapped,GAMMA:all.slice(0,-15)},benchmark_bars:all,sector_bars:{TECH:all},symbol_sectors:{ALPHA:'TECH',BETA:'TECH'}};
  const config={...options,enhanced_options:breakout},expected=compareStrategies(data,config),actual=await compareStrategiesParallel(data,{...config,parallelism:3});
  assert.deepEqual(actual,expected);assert.ok(expected.enhanced.data_quality.gap_count>0);
});

test('worker tasks contain only candles closed at the current timestamp and no portfolio cash',async()=>{
  const data=intraday(),config={...options,enhanced_options:breakout};let inspected=0,closed=false;
  const actual=await compareStrategiesParallel(data,{...config,parallelism:3},{poolFactory:()=>({
    async evaluate(tasks,{strategy_options}){
      for(const task of tasks){
        inspected++;assert.equal(Object.hasOwn(task,'cash'),false);assert.equal(Object.hasOwn(task,'dataset'),false);
        const end=+new Date(task.history.at(-1).time);assert.equal(+new Date(task.context.as_of),end+300000);
        for(const row of [...task.history,...task.context.previous_bars,...task.context.benchmark_bars,...task.context.sector_bars])assert.ok(+new Date(row.time)<=end);
      }
      return tasks.map(task=>evaluateComparisonTask(task,strategy_options));
    },async close(){closed=true;},
  })});
  assert.ok(inspected>100);assert.equal(closed,true);assert.deepEqual(actual,compareStrategies(data,config));
});

test('cancellation after parallel analytics discards the unfinished comparison and always closes the pool',async()=>{
  let cancelled=false,closed=false,evaluated=0;
  await assert.rejects(compareStrategiesParallel(intraday(),{...options,parallelism:3},{cancelled:()=>cancelled,poolFactory:()=>({
    async evaluate(tasks,{strategy_options}){evaluated++;const result=tasks.map(task=>evaluateComparisonTask(task,strategy_options));cancelled=true;return result;},
    async close(){closed=true;},
  })}),/Research cancelled/);
  assert.equal(evaluated,1);assert.equal(closed,true);
});

test('incomplete parallel analytics fails the comparison and never fabricates missing stock decisions',async()=>{
  let closed=false;
  await assert.rejects(compareStrategiesParallel(intraday(),{...options,parallelism:3},{poolFactory:()=>({async evaluate(){return [];},async close(){closed=true;}})}),/incomplete timestamp batch/);
  assert.equal(closed,true);
});

test('cancellation from the final progress callback cannot publish a completed comparison',async()=>{
  let cancelled=false;
  await assert.rejects(compareStrategiesParallel(intraday(),{...options,parallelism:2},{cancelled:()=>cancelled,
    onProgress:value=>{if(value.phase==='enhanced'&&value.progress===1)cancelled=true;},
  }),/Research cancelled/);
});

test('already-cancelled comparison does not start any child analytics workers',async()=>{
  await assert.rejects(compareStrategiesParallel(intraday(),{...options,parallelism:3},{cancelled:()=>true,
    poolFactory:()=>{assert.fail('Cancelled work must not allocate a CPU pool');},
  }),/Research cancelled/);
});

test('one-worker fallback uses the same exact report without creating a nested worker pool',async()=>{
  const data=intraday(),expected=compareStrategies(data,options);
  const actual=await compareStrategiesParallel(data,{...options,parallelism:1},{poolFactory:()=>{throw new Error('Unnecessary child pool');}});
  assert.deepEqual(actual,expected);
});

test('comparison progress separates overall and pass completion and clears old candle batches',async()=>{
  const progress=[];
  await compareStrategiesParallel(intraday(),{...options,parallelism:3},{onProgress:value=>progress.push(structuredClone(value))});
  for(const [phase,offset] of [['baseline',0],['enhanced',.5]]){
    const values=progress.filter(value=>value.phase===phase),first=values[0],last=values.at(-1);
    assert.equal(first.phase_progress,0);assert.equal(first.progress,offset);assert.equal(first.processed_bars,0);
    assert.deepEqual(first.parallelism,{worker_limit:3,active_workers:0,batch_completed_symbols:0,batch_total_symbols:0,batch_timestamp:null});
    assert.ok(values.some(value=>value.parallelism.active_workers>0&&value.parallelism.batch_timestamp!==null));
    assert.equal(last.phase_progress,1);assert.equal(last.progress,offset+.5);
    assert.equal(last.processed_bars,last.total_bars);
    assert.deepEqual(last.parallelism,{worker_limit:3,active_workers:0,batch_completed_symbols:0,batch_total_symbols:0,batch_timestamp:null});
    for(let index=0;index<values.length;index++){
      const value=values[index];
      assert.equal(value.progress,offset+value.phase_progress/2);
      if(value.total_bars)assert.equal(value.phase_progress,value.processed_bars/value.total_bars);
      if(index){assert.ok(value.phase_progress>=values[index-1].phase_progress);assert.ok(value.processed_bars>=values[index-1].processed_bars);}
    }
  }
});
