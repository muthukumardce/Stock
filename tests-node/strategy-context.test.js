import test from 'node:test';
import assert from 'node:assert/strict';
import {intraday_signal,swing_signal,technical_exit,STRATEGY_FAMILIES,position_size,daily_holding_exit} from '../src/strategy.js';
import {strategy_snapshot,aggregate_15minute} from '../src/strategy-context.js';

const off=Object.fromEntries(Object.values(STRATEGY_FAMILIES).map(key=>[key,false]));
function day(date,closes,first=null,volume=1000,pad=.02){return closes.map((close,i)=>{
  const open=i?closes[i-1]:first??close-.02;
  return {time:new Date(Date.parse(date+'T09:15:00+05:30')+i*300000),open,high:Math.max(open,close)+pad,low:Math.min(open,close)-pad,close,volume};
});}
function previous(drift=0,amplitude=.2){
  const closes=Array.from({length:75},(_,i)=>100+(i-74)*drift+Math.sin(i*.8)*amplitude),adjust=closes.at(-1)-100;
  return day('2026-09-16',closes.map(value=>value-adjust),null,1000,.05);
}
function fixture(family){
  let bars,seed=previous(),benchmark;
  if(family==='opening_drive'){seed=previous(.005,.2);bars=day('2026-09-17',[100.22,100.34,100.46],100.1,2500);}
  if(family==='opening_range'){seed=previous(0,.3);bars=day('2026-09-17',[100.22,100.34,100.46,100.6],100.1,2500);}
  if(family==='gap_continuation'){seed=previous(0,.4);bars=day('2026-09-17',[100.66,100.7,100.8],100.6,2500);}
  if(family==='gap_reversal'){seed=previous(-.02,.2);bars=day('2026-09-17',[98.9,98.8,98.85,99.1,99.3],99,3000);}
  if(family==='vwap_reclaim'){bars=day('2026-09-17',[100.2,100.1,100.35],100.3);bars[2].volume=3000;}
  if(family==='vwap_rejection'){bars=day('2026-09-17',[100.15,100.25,100.4],100);Object.assign(bars[2],{open:100.2,low:100.1,volume:3000});}
  if(family==='relative_strength'){bars=day('2026-09-17',[100.1,100.2,100.25,100.35,100.45],100,3000);benchmark=day('2026-09-17',Array(5).fill(100),100,0);}
  if(family==='volatility_squeeze'){
    const closes=Array.from({length:75},(_,i)=>100+Math.sin(i*.8)*(i<55?1:.02)),adjust=closes.at(-1)-100;
    seed=day('2026-09-16',closes.map(value=>value-adjust),null,1000,.05);bars=day('2026-09-17',[100.01,100.03,100.3],100,3000);
  }
  return {bars,options:{...off,enhanced_signals:true,[STRATEGY_FAMILIES[family]]:true},context:{previous_bars:seed,...benchmark?{benchmark_bars:benchmark}:{},as_of:new Date(+bars.at(-1).time+300000)}};
}
const mirror=bars=>bars.map(bar=>({...bar,open:200-bar.open,high:200-bar.low,low:200-bar.high,close:200-bar.close}));
for(const family of ['opening_drive','opening_range','gap_continuation','gap_reversal','vwap_reclaim','vwap_rejection','volatility_squeeze','relative_strength']){
  test(`${family} has an eligible causal early-session long and symmetric intraday short`,()=>{
    const {bars,options,context}=fixture(family),long=intraday_signal(bars,options,context);
    assert.equal(long[1],'candidate',JSON.stringify(long));assert.equal(long[0].setup,family);assert.equal(long[0].side,'BUY');assert(long[0].score>=60);
    assert(long[0].stop<long[0].reference&&long[0].reference<long[0].target);
    const shortContext={...context,previous_bars:mirror(context.previous_bars),...context.benchmark_bars?{benchmark_bars:mirror(context.benchmark_bars)}:{}};
    const short=intraday_signal(mirror(bars),options,shortContext);
    assert.equal(short[1],'candidate',JSON.stringify(short));assert.equal(short[0].setup,family);assert.equal(short[0].side,'SELL');assert(short[0].score>=60);
    assert(short[0].target<short[0].reference&&short[0].reference<short[0].stop);
    assert.equal(intraday_signal(mirror(bars),{...options,intraday_short_enabled:false},shortContext)[0],null);
  });
}
test('opening range and drive enforce their exact closed-candle windows',()=>{
  const drive=fixture('opening_drive');assert.equal(intraday_signal(drive.bars.slice(0,2),drive.options,{...drive.context,as_of:new Date(+drive.bars[1].time+300000)})[0],null);
  const range=fixture('opening_range');assert.equal(intraday_signal(range.bars.slice(0,3),range.options,range.context)[0],null);
  assert.equal(intraday_signal(drive.bars,drive.options,{as_of:drive.context.as_of})[1],'warming_up_indicators');
  const missing=range.bars.slice(1);assert.equal(intraday_signal(missing,range.options,range.context)[1],'incomplete_session_vwap');
});
test('indicator seed crosses the date boundary while VWAP resets to current volume',()=>{
  const f=fixture('opening_drive'),view=strategy_snapshot(f.bars,'intraday',f.context,f.options);
  assert.equal(view.seed_bars,75);assert.equal(view.current_session_bars,3);assert.equal(view.indicators_ready,true);assert.equal(view.previous_session_close,100);
  const expected=f.bars.reduce((sum,bar)=>sum+(bar.high+bar.low+bar.close)/3*bar.volume,0)/f.bars.reduce((sum,bar)=>sum+bar.volume,0);
  assert(Math.abs(view.session_vwap-expected)<1e-10);assert.equal(view.vwap_coverage_bars,3);
});
test('15-minute alignment never consumes an incomplete bucket and preserves OHLCV aggregation',()=>{
  const f=fixture('opening_range'),first=aggregate_15minute(f.bars.slice(0,3))[0],expected=f.bars.slice(0,3);
  assert.equal(first.open,expected[0].open);assert.equal(first.close,expected[2].close);assert.equal(first.high,Math.max(...expected.map(bar=>bar.high)));assert.equal(first.volume,7500);
  assert.deepEqual(aggregate_15minute(f.bars),[first]);assert.deepEqual(aggregate_15minute([f.bars[0],f.bars[2]]),[]);
  const three=strategy_snapshot(f.bars.slice(0,3),'intraday',{...f.context,as_of:new Date(+f.bars[2].time+300000)}),four=strategy_snapshot(f.bars,'intraday',f.context);
  assert.equal(three.higher_timeframe_completed_at,four.higher_timeframe_completed_at);assert.equal(three.higher_timeframe_ema3,four.higher_timeframe_ema3);assert.equal(four.higher_timeframe_ready,true);
});
test('future, unfinished, stale and malformed context is rejected before any signal',()=>{
  const f=fixture('opening_drive');
  assert.equal(intraday_signal(f.bars,f.options,{...f.context,as_of:new Date(+f.context.as_of-1)})[1],'unfinished_signal_candle');
  assert.equal(intraday_signal(f.bars,f.options,{...f.context,as_of:new Date(+f.context.as_of+300000)})[1],'stale_signal_candle');
  assert.equal(intraday_signal(f.bars,f.options,{...f.context,previous_bars:[...f.context.previous_bars,f.bars[0]]})[1],'future_previous_session_context');
  const future=day('2026-09-17',[100,100,100,100],100,0);
  assert.equal(intraday_signal(f.bars,f.options,{...f.context,benchmark_bars:future})[1],'future_context');
  const broken=structuredClone(f.context.previous_bars);broken.splice(10,1);
  assert.equal(intraday_signal(f.bars,f.options,{...f.context,previous_bars:broken})[1],'invalid_previous_session_context');
});
test('relative strength requires aligned benchmark observations and checks supplied sector context',()=>{
  const f=fixture('relative_strength');
  for(const reference of [undefined,f.context.benchmark_bars.slice(0,-1)]){
    const result=intraday_signal(f.bars,f.options,{...f.context,benchmark_bars:reference});assert.equal(result[0],null);assert.match(result[2].setups[0].reason,/benchmark_context/);
  }
  const sector=day('2026-09-17',[100.2,100.4,100.6,100.8,101],100,0);
  const result=intraday_signal(f.bars,f.options,{...f.context,sector_bars:sector});assert.equal(result[0],null);assert.equal(result[2].setups[0].reason,'sector_relative_strength_not_confirmed');
});
test('gap signals require the observed final candle of the prior session',()=>{
  const f=fixture('gap_continuation'),result=intraday_signal(f.bars,f.options,{...f.context,previous_bars:f.context.previous_bars.slice(0,-1)});
  assert.equal(result[0],null);assert.equal(result[2].setups[0].reason,'previous_session_close_missing');
});
test('short technical exits invert momentum and ignore candles predating position entry',()=>{
  const closes=Array.from({length:40},(_,i)=>110-i*.1-i*i*.002),long=day('2026-09-17',closes,110.1,1000,.05),bars=mirror(long),as_of=new Date(+bars.at(-1).time+300000);
  const decision=technical_exit(bars,{strategy:'intraday',side:'SELL'},{enhanced_signals:true},{as_of});assert.equal(decision.reason,'technical_trend_failure');assert.equal(decision.side,'SELL');
  assert.equal(technical_exit(bars,{strategy:'intraday',side:'SELL',opened_at:as_of},{enhanced_signals:true},{as_of}),null);
  assert.equal(technical_exit(bars,{strategy:'intraday',side:'SELL'},{enhanced_signals:true},{as_of:new Date(+as_of+300000)}),null);
  assert.equal(technical_exit(bars,{strategy:'swing',side:'SELL'},{enhanced_signals:true}),null);
});
test('short sizing preserves the same cash and risk budget with reversed stop geometry',()=>{
  assert.equal(position_size(100000,1000,100,102,.0025,.1,'SELL'),position_size(100000,1000,100,98,.0025,.1));
  assert.equal(position_size(100000,1000,100,98,.0025,.1,'SELL'),0);assert.equal(position_size(100000,1000,100,102,.0025,.1),0);
});
test('shared daily management ratchets an exact tick floor and confirms SMA trend loss',()=>{
  const bars=Array.from({length:21},(_,i)=>({time:new Date(Date.parse('2026-08-01T00:00:00+05:30')+i*86400000),open:100,high:100.1,low:99.9,close:100,volume:1000}));
  const normal=daily_holding_exit(bars,{trailing_stop:99.45,tick_size:.05});assert.equal(normal.trailing_stop,99.45);assert.equal(normal.trend_exit,false);
  Object.assign(bars.at(-1),{close:90,low:89.9});const fallen=daily_holding_exit(bars,{trailing_stop:99.45,tick_size:.05});assert.equal(fallen.trailing_stop,99.45);assert.equal(fallen.trend_exit,true);
  assert.equal(daily_holding_exit(bars.slice(1),{}),null);assert.equal(daily_holding_exit(bars,{tick_size:0}),null);
  assert.equal(swing_signal(bars,{enhanced_signals:false})[0],null);
});
