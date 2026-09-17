import test from 'node:test';
import assert from 'node:assert/strict';
import {ema_series,wilder_rsi_series,directional_series,macd_series,bollinger,session_vwap,indicator_snapshot,validate_bars} from '../src/indicators.js';

const close=(actual,expected,tolerance=1e-9)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const candle=(i,open,high,low,value,volume=100)=>({time:new Date(Date.parse('2026-09-17T09:15:00+05:30')+i*300000),open,high,low,close:value,volume});
test('EMA uses an SMA seed and the exact 2/(period+1) recurrence',()=>{
  assert.deepEqual(ema_series([1,2,3,2,4,5],3),[null,null,2,2,3,4]);
  assert.deepEqual(ema_series([1,2],3),[null,null]);assert.deepEqual(ema_series([1,NaN],2),[]);
});
test('Wilder RSI reference series uses recursive average gains and losses',()=>{
  const prices=[44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46.00,46.03,46.41,46.22,45.64];
  const values=wilder_rsi_series(prices);
  assert(values.slice(0,14).every(value=>value===null));close(values[14],70.46413502109705);close(values[15],66.24961855355505);close(values[19],57.91502067008556);
  assert.equal(wilder_rsi_series(Array(20).fill(100)).at(-1),50);
  assert.equal(wilder_rsi_series(Array.from({length:20},(_,i)=>100+i)).at(-1),100);
});
test('Wilder ATR, directional movement and ADX agree with hand-calculated mixed bars',()=>{
  const bars=[[9,10,8,9],[10,12,9,11],[10,11,8,9],[11,13,10,12],[10,12,7,8]].map((row,i)=>candle(i,...row));
  const values=directional_series(bars,2);
  assert.deepEqual(values.adx.slice(0,3),[null,null,null]);close(values.atr[2],3);close(values.atr[4],4.25);
  close(values.plus_di[4],300/17);close(values.minus_di[4],650/17);close(values.adx[3],1100/21);close(values.adx[4],17800/399);
});
test('MACD has separate SMA-seeded EMAs, signal EMA and no early histogram',()=>{
  const result=macd_series([1,2,3,4,3,5,6],2,3,2);
  assert.deepEqual(result.histogram.slice(0,3),[null,null,null]);close(result.macd.at(-1),25/54);close(result.signal.at(-1),23/54);close(result.histogram.at(-1),1/27);
  const regular=macd_series(Array.from({length:40},(_,i)=>i+1));assert.equal(regular.histogram[32],null);close(regular.macd[33],7);close(regular.histogram[33],0);
});
test('Bollinger width uses population standard deviation of the last 20 closes',()=>{
  const result=bollinger(Array.from({length:20},(_,i)=>i+1));close(result.middle,10.5);close(result.upper,10.5+2*Math.sqrt(33.25));close(result.width,4*Math.sqrt(33.25)/10.5);
  assert.equal(bollinger(Array(20).fill(100)).width,0);assert.equal(bollinger([100]).width,null);
});
test('VWAP labels complete session coverage separately from a partial or gapped window',()=>{
  const bars=[candle(0,100,101,99,100,100),candle(1,101,104,100,102,300)];
  const complete=session_vwap(bars);close(complete.session_vwap,101.5);assert.equal(complete.vwap_scope,'session');assert.equal(complete.session_vwap_complete,true);
  const partial=session_vwap(bars.slice(1));assert.equal(partial.session_vwap,null);assert.equal(partial.window_vwap,102);assert.equal(partial.vwap_scope,'window');
  const gap=[bars[0],{...bars[1],time:candle(2,100,101,99,100).time}];assert.equal(session_vwap(gap).vwap_scope,'window');assert.equal(validate_bars(gap,{interval:'intraday'}).reason,'candle_gap');
  const daily=bars.map((bar,i)=>({...bar,time:new Date(`2026-09-${16+i}T00:00:00+05:30`)}));assert.equal(session_vwap(daily).vwap_scope,'not_intraday');
  const dailyOpen=daily.map(bar=>({...bar,time:new Date(+bar.time+9.25*3600000)}));assert.equal(indicator_snapshot(dailyOpen,{strategy:'swing'}).session_vwap,null);assert.equal(indicator_snapshot(dailyOpen,{strategy:'swing'}).vwap_scope,'not_intraday');
  assert.equal(session_vwap(bars.map(bar=>({...bar,volume:0}))).session_vwap,null);
});
test('invalid OHLCV, duplicate timestamps and mixed sessions cannot become valid enhanced indicators',()=>{
  const good=candle(0,100,101,99,100);
  for(const change of [{close:102},{volume:-1},{open:NaN},{low:0},{time:'bad'},{time:'2026-02-30 10:00:00'},{time:'2026-09-17 24:00:00'}])assert.equal(indicator_snapshot([{...good,...change}]).data_valid,false);
  assert.equal(validate_bars([good,good]).reason,'non_monotonic_bars');
  assert.equal(validate_bars([good,{...good,time:new Date('2026-09-18T09:15:00+05:30')}],{interval:'intraday'}).reason,'session_mismatch');
  const warming=indicator_snapshot([good]);assert.equal(warming.indicators_ready,false);assert.equal(warming.rsi14,null);assert.equal(warming.macd_histogram,null);
});
test('arithmetic overflow cannot yield apparently ready or tradable indicators',()=>{
  const bars=Array.from({length:40},(_,i)=>candle(i,1e308,1.1e308,.9e308,1e308,1e308));
  const result=indicator_snapshot(bars);assert.equal(result.data_valid,false);assert.equal(result.data_issue,'indicator_overflow');assert.equal(result.indicators_ready,false);
  assert.equal(session_vwap(bars).session_vwap,null);
});
test('indicators are prefix-only and flat OHLC has finite neutral warmed-up values',()=>{
  const flat=Array.from({length:40},(_,i)=>candle(i,100,100,100,100)),snapshot=indicator_snapshot(flat,{strategy:'intraday'});
  assert.equal(snapshot.indicators_ready,true);assert.equal(snapshot.rsi14,50);assert.equal(snapshot.adx14,0);assert.equal(snapshot.macd_histogram,0);assert.equal(snapshot.atr_wilder14,0);assert.deepEqual(snapshot.patterns,[]);
  const before=indicator_snapshot(flat.slice(0,34));flat.push(candle(40,100,200,100,200));assert.deepEqual(indicator_snapshot(flat.slice(0,34)),before);
});
