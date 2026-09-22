/** Causal context joins and complete exchange-anchored higher-timeframe candles. */
import {dateIST,timeIST,parseTime} from './util.js';
import {indicator_snapshot,validate_bars,session_vwap,ema_series,bollinger} from './indicators.js';

const FIVE=300000,DAY=86400000;
const at=bar=>parseTime(bar.time??bar.date);
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
function intradayHistory(bars){
  const quality=validate_bars(bars);if(!quality.valid)return quality;
  const days=new Map();
  for(const bar of bars){const date=dateIST(at(bar));if(!days.has(date))days.set(date,[]);days.get(date).push(bar);}
  for(const day of days.values()){const result=validate_bars(day,{interval:'intraday'});if(!result.valid)return result;}
  return {valid:true,reason:null};
}
export function aggregate_15minute(bars){
  if(!intradayHistory(bars).valid)return [];
  const buckets=new Map(),result=[];
  for(const bar of bars){
    const time=at(bar),clock=timeIST(time),minute=Number(clock.slice(0,2))*60+Number(clock.slice(3));
    const bucket=+time-((minute-555)%15)*60000;
    if(!buckets.has(bucket))buckets.set(bucket,[]);buckets.get(bucket).push(bar);
  }
  for(const [start,rows] of buckets){
    if(rows.length!==3||rows.some((row,i)=>+at(row)!==start+i*FIVE))continue;
    result.push({time:new Date(start),open:rows[0].open,high:Math.max(...rows.map(row=>row.high)),low:Math.min(...rows.map(row=>row.low)),close:rows[2].close,volume:rows.reduce((sum,row)=>sum+row.volume,0)});
  }
  return result;
}
function relativeContext(current,reference,lastTime){
  if(!Array.isArray(reference)||!reference.length)return {ready:false,excess:null,reason:'benchmark_context_missing'};
  const quality=intradayHistory(reference);if(!quality.valid)return {ready:false,excess:null,reason:'invalid_benchmark_context'};
  if(reference.some(bar=>+at(bar)>lastTime))return {ready:false,excess:null,reason:'future_context'};
  const today=dateIST(new Date(lastTime)),same=reference.filter(bar=>dateIST(at(bar))===today),joined=new Map(same.map(bar=>[+at(bar),bar]));
  if(current.some(bar=>!joined.has(+at(bar))))return {ready:false,excess:null,reason:'benchmark_context_not_aligned'};
  const first=joined.get(+at(current[0])),last=joined.get(lastTime);
  if(!first||!last)return {ready:false,excess:null,reason:'benchmark_context_not_aligned'};
  return {ready:true,excess:current.at(-1).close/current[0].open-last.close/first.open,benchmark_return:last.close/first.open-1,reason:null};
}
export function strategy_snapshot(bars,strategy='intraday',context={},options={}){
  const base=indicator_snapshot(bars,{strategy}),fail=reason=>({...base,data_valid:false,data_issue:reason,indicators_ready:false});
  if(!base.data_valid||!bars.length)return base;
  if(!context||typeof context!=='object'||Array.isArray(context))return fail('invalid_strategy_context');
  const lastTime=+at(bars.at(-1)),closeTime=strategy==='intraday'?lastTime+FIVE:+parseTime(dateIST(new Date(lastTime))+'T15:30:00+05:30');
  if(context.as_of!==undefined){
    const now=parseTime(context.as_of);if(!now)return fail('invalid_context_time');
    if(+now<closeTime)return fail('unfinished_signal_candle');
    if(strategy==='intraday'&&+now-closeTime>=FIVE||strategy==='swing'&&+now-closeTime>7*DAY)return fail('stale_signal_candle');
  }
  if(strategy!=='intraday')return base;
  const previous=context.previous_bars??[];
  if(!Array.isArray(previous)||!intradayHistory(previous).valid)return fail('invalid_previous_session_context');
  if(previous.some(bar=>+at(bar)>=+at(bars[0])||dateIST(at(bar))===dateIST(at(bars[0]))))return fail('future_previous_session_context');
  if(previous.length&&+at(bars[0])-+at(previous.at(-1))>7*DAY)return fail('stale_previous_session_context');
  const combined=[...previous.slice(-150),...bars],indicators=indicator_snapshot(combined);
  if(!indicators.data_valid)return fail(indicators.data_issue);
  const higher=aggregate_15minute(combined),closes=higher.map(bar=>bar.close),fast=ema_series(closes,3).at(-1)??null,slow=ema_series(closes,9).at(-1)??null;
  const higherEnd=higher.length?+at(higher.at(-1))+3*FIVE:null;
  // CAS history ending at 15:10 is useful for indicators, but its last traded
  // price is not the subsequent auction close. Keep gap setups unavailable.
  const priorClose=previous.length&&timeIST(at(previous.at(-1)))==='15:25'?previous.at(-1).close:null;
  const benchmark=relativeContext(bars,context.benchmark_bars,lastTime),sector=relativeContext(bars,context.sector_bars,lastTime);
  if(benchmark.reason==='future_context'||sector.reason==='future_context')return fail('future_context');
  const lookback=options.squeeze_lookback??20,widths=[];
  if(Number.isInteger(lookback)&&lookback>0&&lookback<=100)for(let end=Math.max(20,combined.length-lookback);end<combined.length;end++)widths.push(bollinger(combined.slice(0,end).map(bar=>bar.close)).width);
  const priorBands=bollinger(combined.slice(0,-1).map(bar=>bar.close)),sorted=widths.filter(Number.isFinite).sort((a,b)=>a-b);
  const openingCount=(options.opening_range_minutes??15)/5,opening=Number.isInteger(openingCount)&&openingCount>0?bars.slice(0,openingCount):[];
  const previousSession=previous.length?previous.filter(bar=>dateIST(at(bar))===dateIST(at(previous.at(-1)))):[];
  const previousMatching=new Map(previousSession.map(bar=>[timeIST(at(bar)),bar]));
  const matches=bars.map(bar=>previousMatching.get(timeIST(at(bar))));
  const openingVolume=bars.length>=3&&matches.slice(0,3).every(Boolean)?mean(bars.slice(0,3).map(bar=>bar.volume))/mean(matches.slice(0,3).map(bar=>bar.volume)):null;
  const matchingLast=matches.at(-1),timeVolume=matchingLast?.volume>0?bars.at(-1).volume/matchingLast.volume:null;
  const snapshot={...indicators,...session_vwap(bars),seed_bars:previous.slice(-150).length,current_session_bars:bars.length,
    previous_session_close:priorClose,opening_gap_pct:priorClose===null?null:bars[0].open/priorClose-1,
    opening_range_high:opening.length===openingCount?Math.max(...opening.map(bar=>bar.high)):null,
    opening_range_low:opening.length===openingCount?Math.min(...opening.map(bar=>bar.low)):null,
    previous_bar_vwap:bars.length>1?session_vwap(bars.slice(0,-1)).session_vwap:null,
    opening_relative_volume:Number.isFinite(openingVolume)?openingVolume:null,time_relative_volume:timeVolume,
    higher_timeframe_bars:higher.length,higher_timeframe_ready:Number.isFinite(fast)&&Number.isFinite(slow)&&higherEnd!==null&&closeTime-higherEnd>=0&&closeTime-higherEnd<3*FIVE,
    higher_timeframe_close:higher.at(-1)?.close??null,higher_timeframe_ema3:fast,higher_timeframe_ema9:slow,
    higher_timeframe_completed_at:higherEnd===null?null:new Date(higherEnd).toISOString(),
    relative_strength_ready:benchmark.ready,relative_strength_benchmark:benchmark.excess,benchmark_return:benchmark.benchmark_return??null,relative_strength_issue:benchmark.reason,
    sector_strength_ready:sector.ready,relative_strength_sector:sector.excess,sector_context_provided:Array.isArray(context.sector_bars)&&context.sector_bars.length>0,
    previous_bollinger_upper20:priorBands.upper,previous_bollinger_width20:priorBands.width,
    squeeze_history_ready:sorted.length===lookback,squeeze_width_threshold:sorted.length?sorted[Math.floor((sorted.length-1)*.25)]:null};
  if(Object.values(snapshot).some(value=>typeof value==='number'&&!Number.isFinite(value)))return fail('indicator_overflow');
  return snapshot;
}
