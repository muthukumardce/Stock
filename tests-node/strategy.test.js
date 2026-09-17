import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Candle, CandleBook, Signal, atr, intraday_signal, swing_signal, position_size,indicator_snapshot,technical_exit,STRATEGY_VERSION,STRATEGY_FAMILIES,daily_holding_exit,swing_entry_gate} from '../src/strategy.js';

function intradayBars() {
  const start = new Date('2026-09-17T09:15:00+05:30');
  const bars = Array.from({length: 20}, (_, i) => new Candle(new Date(+start + 300_000 * i),
    100 + i * 0.05, 100.3 + i * 0.05, 99.9 + i * 0.05, 100.2 + i * 0.05, 1000));
  bars.push(new Candle(new Date(+start + 6_000_000), 101, 101.8, 100.95, 101.75, 2500));
  return bars;
}

test('intraday breakout requires contiguous candles, relative volume and a strong close', () => {
  const bars = intradayBars();
  const [signal, reason] = intraday_signal(bars);
  assert.equal(reason, 'candidate');
  assert(signal.stop < signal.reference && signal.reference < signal.target);
  assert.equal(signal.strategy, 'intraday');
  assert.equal(signal.score, 2.5);
  assert.equal(intraday_signal(bars.slice(1))[1], 'warming_up');
  bars.at(-1).volume = 500;
  assert.equal(intraday_signal(bars)[1], 'insufficient_relative_volume');
  bars.at(-1).time = new Date(+bars.at(-1).time + 300_000);
  assert.equal(intraday_signal(bars)[1], 'candle_gap');
});

test('first partial candle never counts, gaps invalidate history and deltas accumulate', () => {
  const book = new CandleBook();
  book.update('2026-09-17 09:17:00', 100, 10000);
  book.update('2026-09-17 09:19:45', 101, 11000);
  assert.equal(book.update('2026-09-17 09:20:00', 102, 11500), null);
  book.update('2026-09-17 09:24:45', 103, 12500);
  const closed = book.update('2026-09-17 09:25:00', 104, 13000);
  assert.equal(closed.volume, 1500);
  assert.equal(closed.time.toISOString(), '2026-09-17T03:50:00.000Z');
  assert.equal(book.bars.length, 1);
  book.update('2026-09-17 09:35:00', 105, 14000);
  assert.equal(book.bars.length, 0);
});

test('invalid, out-of-order and no-trade ticks cannot contaminate candle prices', () => {
  const book = new CandleBook();
  book.update('2026-09-17 09:20:00', 100, 1000);
  const initial = structuredClone(book.current);
  book.update('2026-09-17 09:20:01', 999, 1000);
  assert.equal(book.current.close, initial.close);
  book.update('2026-09-17 09:19:00', 999, 900);
  book.update('2026-09-17 09:20:02', NaN, 2000);
  book.update('bad time', 100, 2000);
  assert.deepEqual({...book.current}, initial);
  book.update('2026-09-18 09:15:00', 101, 100);
  assert.equal(book.current.volume, 0);
  assert.equal(book.complete, false);
});

test('late boundary arrival excludes a candle rather than inventing completeness', () => {
  const book = new CandleBook();
  book.update('2026-09-17 09:15:00', 100, 1000);
  book.update('2026-09-17 09:19:50', 100, 2000);
  book.update('2026-09-17 09:20:45', 100, 2100);
  book.update('2026-09-17 09:24:50', 100, 3000);
  assert.equal(book.update('2026-09-17 09:25:00', 100, 3100), null);
  assert.equal(book.bars.length, 0);
});

test('position sizing respects cash, capital, risk and two-sided fee allowance', () => {
  assert.equal(position_size(100000, 1000, 100, 98, 0.0025, 0.1), 9);
  assert.equal(position_size(100000, 100000, 100, 100, 0.0025, 0.1), 0);
  assert.equal(position_size(100000, 100000, NaN, 95, 0.0025, 0.1), 0);
  assert.equal(position_size(100000, 100000, 100, 98, 0.0002, 0.1), 9);
  assert.equal(position_size(100000, 100000, 100, 98, 0.01, 0.001), 0);
});

test('swing uses completed long history and rejects split-like discontinuities', () => {
  const start = new Date('2026-01-01T00:00:00+05:30');
  const bars = Array.from({length: 54}, (_, i) => new Candle(new Date(+start + i * 86400000),
    100 + i * 0.1, 100.4 + i * 0.1, 99.8 + i * 0.1, 100.3 + i * 0.1, 1000));
  bars.push(new Candle(new Date(+start + 54 * 86400000), 105.2, 106.6, 105, 106.5, 2500));
  assert.equal(swing_signal(bars)[0].strategy, 'swing');
  assert.equal(swing_signal(bars.slice(0, 20))[1], 'warming_up_daily');
  bars[25].open = 50;
  assert.equal(swing_signal(bars)[1], 'daily_discontinuity');
});

test('ATR includes gaps and signal object constructor preserves all fields', () => {
  const bars = [new Candle('2026-01-01', 100, 101, 99, 100, 1000),
    new Candle('2026-01-02', 110, 111, 109, 110, 1000)];
  assert.equal(atr(bars, 1), 11);
  assert.equal(atr(bars), 0);
  const data = {strategy: 'swing', reference: 110, stop: 100, target: 135, score: 3, reason: 'test'};
  assert.deepEqual({...new Signal(data)}, {...data,side:'BUY'});
  assert.equal(bars[0].time.toISOString(), '2025-12-31T18:30:00.000Z');
});

function enhancedBars(length=34,{daily=false,amplitude=.2,drift=.02}={}){
  const start=Date.parse(daily?'2026-01-01T00:00:00+05:30':'2026-09-17T09:15:00+05:30');
  const closes=Array.from({length},(_,i)=>100+i*drift+Math.sin(i*.8)*amplitude);
  return closes.map((close,i)=>{
    const open=i?closes[i-1]:close-.1;
    return new Candle(new Date(start+i*(daily?86400000:300000)),open,Math.max(open,close)+.05,Math.min(open,close)-.05,close,1000);
  });
}
function enhancedBreakout({daily=false}={}){
  const bars=enhancedBars(daily?55:34,{daily}),previous=bars.at(-2),high=Math.max(...bars.slice(-21,-1).map(bar=>bar.high));
  Object.assign(bars.at(-1),{open:previous.close-.02,close:high+.2,high:high+.22,low:previous.close-.04,volume:4000});
  return bars;
}
const noFamilies=Object.fromEntries(Object.values(STRATEGY_FAMILIES).map(key=>[key,false]));
const breakoutOnly={...noFamilies,enhanced_signals:true,enable_breakout:true,higher_timeframe_filter:false,intraday_short_enabled:false};
const shortBars=bars=>bars.map(bar=>({...bar,open:200-bar.open,high:200-bar.low,low:200-bar.high,close:200-bar.close}));
test('enhanced breakout uses confluence score and metadata while baseline remains unchanged',()=>{
  const baseline=intraday_signal(intradayBars());assert.equal(baseline[0].score,2.5);
  assert.deepEqual(intraday_signal(intradayBars(),{enhanced_signals:false}),baseline);
  assert.equal(intraday_signal(intradayBars(),breakoutOnly)[1],'warming_up_indicators');
  const [signal,reason,explanation]=intraday_signal(enhancedBreakout(),breakoutOnly);
  assert.equal(reason,'candidate');assert.equal(signal.setup,'breakout');assert.equal(signal.strategy_version,STRATEGY_VERSION);
  assert(signal.score>=60&&signal.score<=100);assert.match(signal.reason,/not a probability/);assert(signal.evidence.length>=3);
  assert(Math.abs(Object.values(signal.score_components).reduce((a,b)=>a+b,0)-signal.score)<.1);
  assert.equal(explanation.setups[0].reason,'candidate');assert.deepEqual({...new Signal(signal)},{...signal});
  const [short]=intraday_signal(shortBars(enhancedBreakout()),{...breakoutOnly,intraday_short_enabled:true});
  assert.equal(short.side,'SELL');assert.equal(short.setup,'breakout');assert(short.target<short.reference&&short.stop>short.reference);
});
test('enhanced score, regime, RSI and extension thresholds actually block candidates',()=>{
  const bars=enhancedBreakout();
  const score=intraday_signal(bars,{...breakoutOnly,min_signal_score:100});assert.equal(score[1],'score_below_minimum');
  for(const [setting,expected] of [[{min_adx:50},'trend_strength_too_low'],[{max_rsi:50},'rsi_outside_trend_band'],[{max_atr_extension:.01},'price_overextended']]){
    const result=intraday_signal(bars,{...breakoutOnly,...setting});assert.equal(result[0],null);assert.equal(result[2].setups[0].reason,expected);
  }
  assert.equal(intraday_signal(bars,{...breakoutOnly,min_rsi:80,max_rsi:70})[1],'invalid_strategy_options');
  assert.equal(intraday_signal(bars,{...breakoutOnly,enable_breakout:false})[1],'no_setups_enabled');
});
test('enhanced intraday requires contiguous complete session coverage and valid candles',()=>{
  const bars=enhancedBars(40);assert.equal(intraday_signal(bars.slice(1),breakoutOnly)[1],'incomplete_session_vwap');
  const gap=structuredClone(bars);gap.splice(5,1);assert.equal(intraday_signal(gap,breakoutOnly)[1],'candle_gap');
  const malformed=enhancedBreakout();malformed.at(-1).close=NaN;assert.equal(intraday_signal(malformed,breakoutOnly)[1],'invalid_bar_data');
});
test('trend pullback reclaims EMA9 with improving momentum without needing a fresh breakout',()=>{
  const bars=enhancedBars(37),previous=bars.at(-2),high=previous.high;
  Object.assign(bars.at(-1),{open:previous.close-.02,close:high+.2,high:high+.22,low:previous.close-.04,volume:2500});
  bars[20].high=Math.max(bars[20].high,bars.at(-1).close+.01);
  const [signal,reason]=intraday_signal(bars,{...breakoutOnly,enable_breakout:false,enable_pullback:true});
  assert.equal(reason,'candidate');assert.equal(signal.setup,'trend_pullback');assert(signal.score>=60);
  assert.equal(intraday_signal(bars)[1],'no_breakout');
  const [short]=intraday_signal(shortBars(bars),{...breakoutOnly,intraday_short_enabled:true,enable_breakout:false,enable_pullback:true});assert.equal(short.side,'SELL');assert.equal(short.setup,'trend_pullback');
});
test('range reversion uses low ADX and a lower-band recovery without a contradictory above-VWAP gate',()=>{
  const bars=enhancedBars(40),start=+bars[0].time;
  for(let i=0;i<bars.length;i++){
    const close=100+Math.sin(i*2)*.6,open=i?100+Math.sin((i-1)*2)*.6:99.9;
    bars[i]=new Candle(new Date(start+i*300000),open,Math.max(open,close)+.05,Math.min(open,close)-.05,close,1000);
  }
  Object.assign(bars[37],{open:100,close:98,high:100.1,low:97.9});Object.assign(bars[38],{open:97.4,close:97,high:97.5,low:96.9});Object.assign(bars[39],{open:96.95,close:97.8,high:97.85,low:96.9,volume:3000});
  const options={...breakoutOnly,enable_breakout:false,enable_reversion:true},[signal,reason]=intraday_signal(bars,options),metrics=indicator_snapshot(bars);
  assert.equal(reason,'candidate');assert.equal(signal.setup,'range_reversion');assert(metrics.adx14<18);assert(signal.reference<metrics.session_vwap);
  assert.equal(signal.target,metrics.bollinger_middle20);assert((signal.target-signal.reference)/(signal.reference-signal.stop)>=1.2);
  assert.equal(intraday_signal(bars,{...options,min_adx:10})[2].setups[0].reason,'range_regime_not_confirmed');
  assert.equal(intraday_signal(bars,{...options,candlestick_patterns_enabled:false})[1],'score_below_minimum');
  const [short]=intraday_signal(shortBars(bars),{...options,intraday_short_enabled:true});assert.equal(short.side,'SELL');assert.equal(short.setup,'range_reversion');assert(short.target<short.reference&&short.stop>short.reference);
});
test('enhanced swing retains its 55-day minimum and does not require intraday VWAP',()=>{
  const bars=enhancedBreakout({daily:true});
  assert.equal(swing_signal(bars,breakoutOnly)[0].setup,'breakout');
  assert.equal(swing_signal(bars.slice(1),breakoutOnly)[1],'warming_up_daily');
  assert.equal(indicator_snapshot(bars,{strategy:'swing'}).vwap_scope,'not_intraday');
});

test('swing reversion cannot enter when its already-completed daily trend policy demands exit',()=>{
  const start=Date.parse('2026-01-01T09:15:00+05:30');
  const bars=Array.from({length:55},(_,i)=>{
    const close=100+Math.sin(i*2)*.6,open=i?100+Math.sin((i-1)*2)*.6:99.9;
    return new Candle(new Date(start+i*86400000),open,Math.max(open,close)+.05,Math.min(open,close)-.05,close,1000);
  });
  Object.assign(bars.at(-3),{open:100,close:98,high:100.1,low:97.9});
  Object.assign(bars.at(-2),{open:97.4,close:97,high:97.5,low:96.9});
  Object.assign(bars.at(-1),{open:96.95,close:97.8,high:97.85,low:96.9,volume:3000});
  const result=swing_signal(bars,{...breakoutOnly,enable_breakout:false,enable_reversion:true});
  assert.equal(daily_holding_exit(bars).trend_exit,true);
  assert.equal(result[0],null);assert.equal(result[2].setups[0].reason,'daily_trend_exit_active');
  assert(result[2].setups[0].score>=60,'The score would otherwise qualify; the daily policy prevents immediate churn');
});

test('swing entry gate checks actual price against the shared daily trail and rejects unavailable history',()=>{
  const bars=enhancedBreakout({daily:true}),[signal]=swing_signal(bars,breakoutOnly);
  assert(signal);assert.equal(swing_entry_gate(bars,signal),null);
  const daily=daily_holding_exit(bars,{...signal,stop:signal.stop-10});
  const wider={...signal,stop:signal.stop-10,tick_size:.01};
  assert.equal(swing_entry_gate(bars,wider,daily_holding_exit(bars,wider).trailing_stop),'daily_trailing_exit_active');
  assert.equal(swing_entry_gate(bars,wider,daily.trailing_stop+1),null);
  assert.equal(swing_entry_gate(bars.slice(-14),signal),'daily_entry_history_unavailable');
  assert.equal(swing_entry_gate(bars,{...signal,side:'SELL'}),'invalid_swing_entry');
  assert.equal(swing_entry_gate(bars,signal,NaN),'invalid_swing_entry');
});
test('technical exits require explicit enhanced mode and multiple completed-candle confirmations',()=>{
  const bars=enhancedBars(40);
  for(let i=0;i<bars.length;i++){
    const close=110-i*.1-i*i*.002,open=i?110-(i-1)*.1-(i-1)**2*.002:110.1;
    Object.assign(bars[i],{open,close,high:open+.05,low:close-.05});
  }
  assert.equal(technical_exit(bars,{strategy:'intraday'}),null);
  assert.equal(technical_exit(bars,{strategy:'intraday'},{enhanced_signals:true,technical_exit_enabled:false}),null);
  const decision=technical_exit(bars,{strategy:'intraday'},{enhanced_signals:true});assert.equal(decision.reason,'technical_trend_failure');assert.equal(decision.exit,true);assert(decision.evidence.length>=2);
  assert.equal(technical_exit(bars.slice(0,20),{strategy:'intraday'},{enhanced_signals:true}),null);
  bars.at(-1).close=NaN;assert.equal(technical_exit(bars,{strategy:'intraday'},{enhanced_signals:true}),null);
});
