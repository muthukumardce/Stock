/** Deterministic research strategies. These rules make no performance claims. */
import {parseTime,timeIST,dateIST} from './util.js';
import {indicator_snapshot,validate_bars} from './indicators.js';
import {strategy_snapshot} from './strategy-context.js';
export {indicator_snapshot,validate_bars} from './indicators.js';
export {strategy_snapshot,aggregate_15minute} from './strategy-context.js';

export const STRATEGY_VERSION='3.1.1';
export const STRATEGY_FAMILIES=Object.freeze({breakout:'enable_breakout',trend_pullback:'enable_pullback',range_reversion:'enable_reversion',
  opening_range:'enable_opening_range',opening_drive:'enable_opening_drive',gap_continuation:'enable_gap_continuation',gap_reversal:'enable_gap_reversal',
  vwap_reclaim:'enable_vwap_reclaim',vwap_rejection:'enable_vwap_rejection',volatility_squeeze:'enable_volatility_squeeze',relative_strength:'enable_relative_strength'});
export const ENHANCED_DEFAULTS=Object.freeze({enhanced_signals:true,min_signal_score:60,min_adx:18,min_rsi:45,max_rsi:78,max_atr_extension:2.5,
  ...Object.fromEntries(Object.values(STRATEGY_FAMILIES).map(key=>[key,true])),candlestick_patterns_enabled:true,technical_exit_enabled:true,
  intraday_short_enabled:true,opening_range_minutes:15,higher_timeframe_filter:true,min_setup_volume:1.2,min_gap_pct:.005,max_gap_pct:.05,
  relative_strength_min:.002,squeeze_width_max:.02,squeeze_lookback:20});

const FIVE_MINUTES = 300_000;
const IST_OFFSET = 19_800_000;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const instant = value => parseTime(value) ?? new Date(NaN);
const day = value => new Date(+value + IST_OFFSET).toISOString().slice(0, 10);

export class Candle {
  constructor(time, open, high, low, close, volume) {
    if (time && typeof time === 'object' && !(time instanceof Date)) ({time, open, high, low, close, volume} = time);
    Object.assign(this, {time: instant(time), open, high, low, close, volume});
  }
}

export class Signal {
  constructor(strategy, reference, stop, target, reason, score) {
    const metadata=strategy&&typeof strategy==='object'?strategy:null;
    if (metadata) ({strategy, reference, stop, target, reason, score} = metadata);
    Object.assign(this, {strategy, reference, stop, target, reason, score});
    this.side=metadata?.side??'BUY';
    if(metadata)for(const key of ['setup','evidence','opposition','score_components','strategy_version'])if(Object.hasOwn(metadata,key))this[key]=structuredClone(metadata[key]);
  }
}

export class CandleBook {
  constructor() {
    this.bars = [];
    this.current = null;
    this.last_time = null;
    this.last_volume = null;
    this.complete = false;
  }

  update(at, price, cumulative_volume) {
    at = instant(at);
    if (!Number.isFinite(+at) || !Number.isFinite(price) || !Number.isFinite(cumulative_volume) || price <= 0 || cumulative_volume < 0) return null;
    if (this.last_time && at < this.last_time) return null;
    // Intraday cumulative volume cannot move backwards. Reject the whole tick
    // before changing timing or the baseline, otherwise recovery double counts
    // trades. A new trading date resets the baseline below.
    if (this.last_time && day(at) === day(this.last_time) && this.last_volume !== null && cumulative_volume < this.last_volume) return null;
    const bucket = new Date(Math.floor(+at / FIVE_MINUTES) * FIVE_MINUTES);
    if (this.last_time && day(at) !== day(this.last_time)) {
      this.bars.length = 0;
      this.current = null;
      this.last_volume = null;
    }
    const delta = this.last_volume === null ? 0 : Math.max(0, cumulative_volume - this.last_volume);
    let closed = null;
    if (!this.current || +bucket !== +this.current.time) {
      if (this.current) {
        const contiguous = bucket - this.current.time === FIVE_MINUTES;
        const late_enough = +this.last_time >= +bucket - 30_000;
        if (this.complete && contiguous && late_enough) {
          closed = this.current;
          this.bars.push(closed);
          if (this.bars.length > 80) this.bars.shift();
        } else this.bars.length = 0;
        this.complete = contiguous && at - bucket <= 30_000;
      } else this.complete = false;
      this.current = new Candle(bucket, price, price, price, price, delta);
    } else if (delta > 0) {
      this.current.high = Math.max(this.current.high, price);
      this.current.low = Math.min(this.current.low, price);
      this.current.close = price;
      this.current.volume += delta;
    }
    this.last_time = at;
    this.last_volume = cumulative_volume;
    return closed;
  }
}

export function atr(bars, period = 14) {
  if (bars.length < period + 1) return 0;
  return mean(bars.slice(-period).map((bar, index) => {
    const previous = bars[bars.length - period - 1 + index];
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));
  }));
}

export function intraday_signal(bars,options={},context={}) {
  if(options?.enhanced_signals===true)return enhanced_signal('intraday',bars,options,context);
  if (bars.length < 21) return [null, 'warming_up'];
  const recent = bars.slice(-21);
  if (recent.slice(1).some((bar, index) => instant(bar.time) - instant(recent[index].time) !== FIVE_MINUTES)) return [null, 'candle_gap'];
  const last = recent.at(-1), previous = recent.slice(0, -1);
  if (last.close <= Math.max(...previous.map(bar => bar.high))) return [null, 'no_breakout'];
  const avg_volume = mean(previous.map(bar => bar.volume));
  if (avg_volume <= 0 || last.volume < avg_volume * 1.5) return [null, 'insufficient_relative_volume'];
  const closes = recent.map(bar => bar.close);
  if (mean(closes.slice(-5)) <= mean(closes.slice(-20))) return [null, 'trend_not_confirmed'];
  const spread = last.high - last.low;
  if (spread <= 0 || (last.close - last.open) / spread < 0.6 || (last.high - last.close) / spread > 0.2) return [null, 'weak_candle'];
  const risk = Math.max(atr(recent) * 1.5, last.close * 0.004);
  if (risk / last.close > 0.025) return [null, 'excessive_volatility'];
  return [new Signal('intraday', last.close, last.close - risk, last.close + 2 * risk,
    '20-bar breakout, rising trend, strong candle, volume >= 1.5x', Math.min(10, last.volume / avg_volume)), 'candidate'];
}

export function swing_signal(bars,options={},context={}) {
  if(options?.enhanced_signals===true)return enhanced_signal('swing',bars,options,context);
  if (bars.length < 55) return [null, 'warming_up_daily'];
  bars = bars.slice(-55);
  if (bars.slice(1).some((bar, index) => Math.abs(bar.open / bars[index].close - 1) > 0.2)) return [null, 'daily_discontinuity'];
  const last = bars.at(-1), previous = bars.slice(-21, -1);
  if (last.close <= Math.max(...previous.map(bar => bar.high))) return [null, 'no_daily_breakout'];
  if (mean(bars.slice(-20).map(bar => bar.close)) <= mean(bars.slice(-50).map(bar => bar.close))) return [null, 'daily_trend_not_confirmed'];
  const avg_volume = mean(previous.map(bar => bar.volume));
  if (avg_volume <= 0 || last.volume < 1.5 * avg_volume) return [null, 'insufficient_daily_volume'];
  const spread = last.high - last.low;
  if (spread <= 0 || last.close <= last.open || (last.high - last.close) / spread > 0.25) return [null, 'weak_daily_candle'];
  const risk = Math.max(2 * atr(bars), last.close * 0.02);
  if (risk / last.close > 0.08) return [null, 'excessive_daily_volatility'];
  const signal=new Signal('swing', last.close, last.close - risk, last.close + 2.5 * risk,
    'Completed daily 20-day breakout, SMA20 > SMA50, volume >= 1.5x', Math.min(10, last.volume / avg_volume));
  const dailyGate=swing_entry_gate(bars,signal);
  return dailyGate?[null,dailyGate]:[signal,'candidate'];
}

const clamp=value=>Math.max(0,Math.min(1,value));
function options_valid(options){
  return ['min_signal_score','min_adx','min_rsi','max_rsi','max_atr_extension'].every(key=>Number.isFinite(options[key]))&&
    options.min_signal_score>=0&&options.min_signal_score<=100&&options.min_adx>0&&options.min_adx<=60&&
    options.min_rsi>=0&&options.max_rsi<=100&&options.min_rsi<options.max_rsi&&options.max_atr_extension>0&&
    [...Object.values(STRATEGY_FAMILIES),'candlestick_patterns_enabled','technical_exit_enabled','intraday_short_enabled','higher_timeframe_filter'].every(key=>typeof options[key]==='boolean')&&
    Number.isInteger(options.opening_range_minutes)&&options.opening_range_minutes>=5&&options.opening_range_minutes<=60&&options.opening_range_minutes%5===0&&
    ['min_setup_volume','min_gap_pct','max_gap_pct','relative_strength_min','squeeze_width_max'].every(key=>Number.isFinite(options[key])&&options[key]>0)&&
    options.min_gap_pct<options.max_gap_pct&&options.max_gap_pct<=.2&&options.min_setup_volume<=10&&options.relative_strength_min<=.1&&options.squeeze_width_max<=.5&&
    Number.isInteger(options.squeeze_lookback)&&options.squeeze_lookback>=5&&options.squeeze_lookback<=100;
}
function pattern_evidence(metrics,options,side='BUY'){
  const patterns=options.candlestick_patterns_enabled?metrics.patterns:[];
  const bullish=patterns.filter(row=>row.direction===(side==='BUY'?'bullish':'bearish')),bearish=patterns.filter(row=>row.direction===(side==='BUY'?'bearish':'bullish'));
  return {bullish,bearish,support:Math.max(0,...bullish.map(row=>row.strength)),opposition:Math.max(0,...bearish.map(row=>row.strength))};
}
function oriented_bars(bars,direction){return direction===1?bars:bars.map(bar=>({...bar,open:-bar.open,high:-bar.low,low:-bar.high,close:-bar.close}));}
function oriented_metrics(source,direction){
  if(direction===1)return source;
  const result={...source};
  for(const key of ['ema9','ema21','previous_ema9','macd','macd_signal','macd_histogram','previous_macd_histogram','atr_extension','bollinger_middle20','session_vwap','window_vwap','previous_bar_vwap','previous_session_close','opening_gap_pct','relative_strength_benchmark','relative_strength_sector','benchmark_return','higher_timeframe_close','higher_timeframe_ema3','higher_timeframe_ema9'])if(Number.isFinite(source[key]))result[key]=-source[key];
  for(const key of ['rsi14','previous_rsi14'])if(Number.isFinite(source[key]))result[key]=100-source[key];
  for(const [upper,lower] of [['bollinger_upper20','bollinger_lower20'],['previous_bollinger_upper20','previous_bollinger_lower20'],['opening_range_high','opening_range_low']]){result[upper]=Number.isFinite(source[lower])?-source[lower]:null;result[lower]=Number.isFinite(source[upper])?-source[upper]:null;}
  result.plus_di14=source.minus_di14;result.minus_di14=source.plus_di14;return result;
}
function breakout_reason(bars,strategy){
  if(bars.length<(strategy==='swing'?55:21))return strategy==='swing'?'warming_up_daily':'warming_up';
  const last=bars.at(-1),previous=bars.slice(-21,-1),closes=bars.map(bar=>bar.close),volume=mean(previous.map(bar=>bar.volume)),range=last.high-last.low;
  if(last.close<=Math.max(...previous.map(bar=>bar.high)))return strategy==='swing'?'no_daily_breakout':'no_breakout';
  if(volume<=0||last.volume<volume*1.5)return strategy==='swing'?'insufficient_daily_volume':'insufficient_relative_volume';
  if(mean(closes.slice(strategy==='swing'?-20:-5))<=mean(closes.slice(strategy==='swing'?-50:-20)))return 'trend_not_confirmed';
  if(range<=0||last.close<=last.open||(last.high-last.close)/range>(strategy==='swing'?.25:.2)||strategy==='intraday'&&(last.close-last.open)/range<.6)return 'weak_candle';
  return null;
}
function enhanced_signal(strategy,bars,supplied,context){
  // BUY and SELL inspect the same closed candles/context. Only orientation and
  // setup gates differ. Keep this cache local to this one decision; callers may
  // mutate their candle book or options before the next call.
  let snapshot;
  const snapshotFor=options=>snapshot??=strategy_snapshot(bars,strategy,context,options);
  const long=evaluate_direction(strategy,bars,supplied,context,'BUY',snapshotFor);
  if(strategy!=='intraday'||supplied.intraday_short_enabled===false)return long;
  const short=evaluate_direction(strategy,bars,supplied,context,'SELL',snapshotFor);
  const selected=[long,short].filter(row=>row[0]).sort((a,b)=>b[0].score-a[0].score||a[0].side.localeCompare(b[0].side))[0];
  const explanation={...long[2],setups:[...(long[2]?.setups??[]),...(short[2]?.setups??[])]};
  return selected?[selected[0],'candidate',explanation]:[null,long[1],explanation];
}
function evaluate_direction(strategy,bars,supplied,context,side,snapshotFor){
  const direction=side==='SELL'?-1:1,options={...ENHANCED_DEFAULTS,...supplied},explanation={strategy_version:STRATEGY_VERSION,mode:'enhanced',setups:[]};
  const reject=reason=>[null,reason,explanation];
  if(!options_valid(options))return reject('invalid_strategy_options');
  const quality=validate_bars(bars,{interval:strategy});if(!quality.valid)return reject(quality.reason);
  if(bars.length<(strategy==='swing'?55:2))return reject(strategy==='swing'?'warming_up_daily':'warming_up_indicators');
  if(strategy==='swing'&&bars.slice(1).some((bar,i)=>Math.abs(bar.open/bars[i].close-1)>.2))return reject('daily_discontinuity');
  const snapshot=snapshotFor(options);if(!snapshot.data_valid)return reject(snapshot.data_issue);
  const metrics=oriented_metrics(snapshot,direction),price=bars.at(-1).close;
  if(!metrics.indicators_ready||!(metrics.atr_wilder14>0))return reject('warming_up_indicators');
  if(strategy==='intraday'&&!metrics.session_vwap_complete)return reject('incomplete_session_vwap');
  const enabled=Object.entries(STRATEGY_FAMILIES).filter(([setup,key])=>options[key]&&(strategy==='intraday'||['breakout','trend_pullback','range_reversion'].includes(setup))).map(([setup])=>setup);
  if(!enabled.length)return reject('no_setups_enabled');
  bars=oriented_bars(bars,direction);
  const last=bars.at(-1),previous=bars.at(-2),body=(last.close-last.open)/(last.high-last.low||1),volume=metrics.relative_volume20??0;
  const patterns=pattern_evidence(metrics,options,side),candidates=[];
  const higherGate=()=>strategy==='swing'||!options.higher_timeframe_filter?null:!metrics.higher_timeframe_ready?'warming_up_15minute':
    metrics.higher_timeframe_ema3<=metrics.higher_timeframe_ema9||metrics.higher_timeframe_close<metrics.higher_timeframe_ema3?'higher_timeframe_not_aligned':null;
  const trendGate=()=>metrics.ema9<=metrics.ema21||last.close<=metrics.ema21?'ema_trend_not_confirmed':
    metrics.adx14<options.min_adx?'trend_strength_too_low':metrics.plus_di14<=metrics.minus_di14?'direction_not_confirmed':
    metrics.atr_extension>options.max_atr_extension?'price_overextended':
    strategy==='intraday'&&last.close<metrics.session_vwap?'wrong_side_of_session_vwap':higherGate();
  for(const setup of enabled){
    const minimum={breakout:21,trend_pullback:2,range_reversion:2,opening_range:options.opening_range_minutes/5+1,opening_drive:3,gap_continuation:2,gap_reversal:2,vwap_reclaim:2,vwap_rejection:2,volatility_squeeze:2,relative_strength:5}[setup];
    if(bars.length<minimum){explanation.setups.push({setup,side,reason:'warming_up_setup',required_current_bars:minimum});continue;}
    let reason=null,target=null,risk=Math.max(metrics.atr_wilder14*(strategy==='intraday'?1.5:2),price*(strategy==='intraday'?.004:.02));
    let components={},evidence=[];
    if(setup==='breakout'){
      reason=breakout_reason(bars,strategy)??trendGate();
      reason??=metrics.macd_histogram<=0?'macd_momentum_not_confirmed':metrics.rsi14<options.min_rsi||metrics.rsi14>options.max_rsi?'rsi_outside_trend_band':null;
      components={trend:20*clamp(metrics.adx14/40),direction:10*clamp((metrics.plus_di14-metrics.minus_di14)/(metrics.plus_di14+metrics.minus_di14||1)),
        momentum:15*clamp(metrics.macd_histogram/(metrics.atr_wilder14*.1)),volume:20*clamp((volume-1)/2),candle:15*clamp(body),
        extension:10*clamp(1-metrics.atr_extension/options.max_atr_extension),pattern:10*patterns.support/100};
      evidence=['20-bar extreme breakout with relative volume at least 1.5','EMA9/EMA21, ADX and directional movement agree with the order side','MACD histogram and bounded Wilder RSI confirm direction'];
    }else if(setup==='trend_pullback'){
      reason=trendGate();
      const touched=last.low<=metrics.ema9||previous.low<=metrics.previous_ema9;
      reason??=!touched||last.close<=metrics.ema9||body<.4?'no_pullback_reclaim':
        metrics.macd<=0||metrics.previous_macd_histogram===null||metrics.macd_histogram<=metrics.previous_macd_histogram?'pullback_momentum_not_recovering':
        metrics.rsi14<options.min_rsi||metrics.rsi14>Math.min(70,options.max_rsi)?'rsi_outside_pullback_band':volume<1?'insufficient_pullback_volume':
        patterns.support<60&&last.close<=previous.high?'pullback_confirmation_missing':null;
      components={trend:20*clamp(metrics.adx14/40),direction:10*clamp((metrics.plus_di14-metrics.minus_di14)/(metrics.plus_di14+metrics.minus_di14||1)),
        momentum:15*clamp((metrics.macd_histogram-(metrics.previous_macd_histogram??metrics.macd_histogram))/(metrics.atr_wilder14*.1)),
        volume:15*clamp(volume/1.5),candle:15*clamp(body),extension:15*clamp(1-metrics.atr_extension/options.max_atr_extension),pattern:10*patterns.support/100};
      evidence=['Trend pullback touches and reclaims the directional side of EMA9','MACD supports the order side while its histogram improves in that direction','A contextual pattern or break of the prior candle extreme confirms recovery'];
    }else if(setup==='range_reversion'){
      const touched=previous.close<=metrics.previous_bollinger_lower20||last.low<=metrics.bollinger_lower20;
      const reentry=last.close>metrics.bollinger_lower20&&last.close<metrics.bollinger_middle20&&last.close>last.open;
      risk=Math.max(last.close-Math.min(last.low,previous.low)+metrics.atr_wilder14*.25,price*(strategy==='intraday'?.004:.01));
      target=metrics.bollinger_middle20;const reward=(target-last.close)/risk;
      reason=metrics.adx14>=options.min_adx?'range_regime_not_confirmed':!touched||!reentry?'no_lower_band_reentry':
        metrics.previous_rsi14===null||metrics.previous_rsi14>40||metrics.rsi14<=metrics.previous_rsi14||metrics.rsi14>=55?'range_rsi_not_recovering':
        patterns.support<60&&last.close<=previous.high?'range_reversal_confirmation_missing':reward<1.2?'insufficient_reversion_reward':null;
      components={range:20*clamp(1-metrics.adx14/options.min_adx),momentum:20*clamp((metrics.rsi14-(metrics.previous_rsi14??metrics.rsi14))/10),
        candle:20*clamp(body+(Math.min(last.open,last.close)-last.low)/(last.high-last.low||1)),reward:15*clamp(reward/2),volume:15*clamp(volume/1.5),pattern:10*patterns.support/100};
      evidence=['ADX below the trend threshold identifies a range','Price re-enters its adverse Bollinger boundary as Wilder RSI recovers','Mid-band target offers at least 1.2 times initial price risk'];
    }else{
      const setupVolume=metrics.time_relative_volume??volume,clock=timeIST(last.time),higher=higherGate();
      const directional=()=>metrics.ema9<=metrics.ema21||last.close<=metrics.ema21?'ema_trend_not_confirmed':
        metrics.plus_di14<=metrics.minus_di14?'direction_not_confirmed':metrics.macd_histogram<=0?'macd_momentum_not_confirmed':
        metrics.rsi14<options.min_rsi||metrics.rsi14>options.max_rsi?'rsi_outside_trend_band':metrics.atr_extension>options.max_atr_extension?'price_overextended':
        last.close<metrics.session_vwap?'wrong_side_of_session_vwap':higher;
      let momentum=metrics.macd_histogram,structure=0,usedVolume=setupVolume;
      if(setup==='opening_range'){
        reason=clock>='10:30'?'opening_window_passed':previous.close>metrics.opening_range_high||last.close<=metrics.opening_range_high?'no_opening_range_breakout':
          body<.5?'weak_opening_breakout':setupVolume<options.min_setup_volume?'insufficient_setup_volume':directional();
        risk=Math.max(price*.004,last.close-metrics.opening_range_high+metrics.atr_wilder14*.25);structure=10;
        evidence=[`${options.opening_range_minutes}-minute opening range uses only the completed opening candles`,'First close through the opening boundary with strong candle and relative volume'];
      }else if(setup==='opening_drive'){
        const opening=bars.slice(0,3),strong=opening.filter(bar=>(bar.close-bar.open)/(bar.high-bar.low||1)>=.5).length;
        usedVolume=metrics.opening_relative_volume??volume;
        reason=bars.length!==3?'opening_drive_window_passed':opening.some(bar=>bar.close<=bar.open)||strong<2||opening.slice(1).some((bar,i)=>bar.close<=opening[i].close)?'opening_drive_not_directional':
          last.close-opening[0].open<metrics.atr_wilder14*.5?'opening_drive_too_small':usedVolume<options.min_setup_volume?'insufficient_opening_volume':directional();
        risk=Math.max(price*.004,last.close-last.low+metrics.atr_wilder14*.25);structure=10;
        evidence=['First three completed candles form a sustained opening drive','At least two strong bodies, rising directional closes and elevated opening volume'];
      }else if(setup==='gap_continuation'){
        reason=metrics.opening_gap_pct===null?'previous_session_close_missing':clock>='10:30'?'opening_window_passed':
          metrics.opening_gap_pct<options.min_gap_pct||metrics.opening_gap_pct>options.max_gap_pct?'gap_outside_continuation_band':
          last.close<=bars[0].open||last.close<=previous.high||Math.min(...bars.map(bar=>bar.low))<=metrics.previous_session_close?'gap_not_holding':
          body<.4?'weak_gap_confirmation':setupVolume<options.min_setup_volume?'insufficient_setup_volume':directional();
        risk=Math.max(price*.004,last.close-Math.min(last.low,previous.low)+metrics.atr_wilder14*.25);structure=10;
        evidence=['Verified previous-session final close establishes a directional opening gap','Gap remains unfilled and price breaks the prior candle extreme in the gap direction'];
      }else if(setup==='gap_reversal'){
        target=metrics.previous_session_close;risk=Math.max(price*.004,last.close-Math.min(last.low,previous.low)+metrics.atr_wilder14*.25);
        momentum=metrics.macd_histogram-(metrics.previous_macd_histogram??metrics.macd_histogram);
        reason=metrics.opening_gap_pct===null?'previous_session_close_missing':clock>='10:30'?'opening_window_passed':
          metrics.opening_gap_pct>-options.min_gap_pct||metrics.opening_gap_pct<-options.max_gap_pct?'gap_outside_reversal_band':
          last.close<=bars[0].open||last.close<=previous.high||last.close<=metrics.session_vwap||body<.4?'gap_reversal_not_confirmed':
          momentum<=0||metrics.previous_rsi14===null||metrics.rsi14<=metrics.previous_rsi14?'gap_reversal_momentum_missing':
          (target-last.close)/risk<1.2?'insufficient_gap_fill_reward':setupVolume<options.min_setup_volume?'insufficient_setup_volume':null;
        structure=10;evidence=['Price reverses an opening gap against the proposed order direction','Recovery crosses the opening price and VWAP; previous close offers at least 1.2R gap-fill reward'];
      }else if(setup==='vwap_reclaim'){
        reason=metrics.previous_bar_vwap===null?'warming_up_session_vwap':previous.close>metrics.previous_bar_vwap||last.close<=metrics.session_vwap?'no_vwap_cross':
          last.close<=previous.high||body<.4?'vwap_reclaim_not_confirmed':setupVolume<options.min_setup_volume?'insufficient_setup_volume':directional();
        risk=Math.max(price*.004,last.close-metrics.session_vwap+metrics.atr_wilder14*.25);structure=10;
        evidence=['Previous close was on the adverse side of the causal session VWAP','Current candle crosses VWAP and the prior extreme in the supported trend direction'];
      }else if(setup==='vwap_rejection'){
        reason=metrics.previous_bar_vwap===null?'warming_up_session_vwap':previous.close<metrics.previous_bar_vwap||last.low>metrics.session_vwap+metrics.atr_wilder14*.1?'no_vwap_retest':
          last.close<=metrics.session_vwap+metrics.atr_wilder14*.1||body<.4?'vwap_rejection_not_confirmed':setupVolume<options.min_setup_volume?'insufficient_setup_volume':directional();
        risk=Math.max(price*.004,last.close-metrics.session_vwap+metrics.atr_wilder14*.25);structure=10;
        evidence=['Price retests session VWAP from its favorable side','A directional rejection candle closes away from VWAP with trend and volume confirmation'];
      }else if(setup==='volatility_squeeze'){
        reason=!metrics.squeeze_history_ready?'warming_up_squeeze':metrics.previous_bollinger_width20>options.squeeze_width_max||metrics.previous_bollinger_width20>metrics.squeeze_width_threshold?'no_volatility_squeeze':
          last.close<=metrics.previous_bollinger_upper20||metrics.bollinger_width20<=metrics.previous_bollinger_width20?'squeeze_not_released':
          body<.5?'weak_squeeze_release':setupVolume<Math.max(1.5,options.min_setup_volume)?'insufficient_squeeze_volume':directional();
        risk=Math.max(price*.004,last.close-metrics.previous_bollinger_upper20+metrics.atr_wilder14*.25);structure=10;
        evidence=[`Previous Bollinger width is below its trailing ${options.squeeze_lookback}-bar lower quartile and configured cap`,'Current completed candle expands volatility beyond the previous outer band'];
      }else if(setup==='relative_strength'){
        reason=!metrics.relative_strength_ready?metrics.relative_strength_issue??'benchmark_context_missing':
          metrics.relative_strength_benchmark<options.relative_strength_min?'insufficient_relative_strength':
          metrics.sector_context_provided&&(!metrics.sector_strength_ready||metrics.relative_strength_sector<0)?'sector_relative_strength_not_confirmed':
          last.close<=Math.max(...bars.slice(-5,-1).map(bar=>bar.high))||body<.4?'relative_strength_price_confirmation_missing':
          setupVolume<options.min_setup_volume?'insufficient_setup_volume':directional();
        structure=10;evidence=['Symbol and benchmark use identical completed timestamps and the same session-open return anchor','Excess return, price structure and directional indicators confirm relative leadership'];
      }
      components={trend:20*clamp(metrics.adx14/40),direction:10*clamp((metrics.plus_di14-metrics.minus_di14)/(metrics.plus_di14+metrics.minus_di14||1)),
        momentum:15*clamp(momentum/(metrics.atr_wilder14*.1)),volume:20*clamp(usedVolume/2),candle:15*clamp(body),structure,pattern:10*patterns.support/100};
      if(higher===null&&!['gap_reversal'].includes(setup)&&options.higher_timeframe_filter)evidence.push('Completed 15-minute EMA3/EMA9 aligns with the order direction');
    }
    reason??=patterns.opposition>=80&&patterns.opposition>=patterns.support?(side==='BUY'?'bearish_pattern_opposition':'bullish_pattern_opposition'):
      risk/price>(strategy==='intraday'?.025:.08)||risk>=price?'excessive_volatility':null;
    if(!reason&&strategy==='swing')reason=swing_entry_gate(bars,{strategy,side,reference:price,stop:price-risk});
    const score=Math.round(Math.max(0,Math.min(100,Object.values(components).reduce((sum,value)=>sum+value,0)))*10)/10;
    reason??=score<options.min_signal_score?'score_below_minimum':null;
    explanation.setups.push({setup,side,reason:reason??'candidate',score});
    if(reason)continue;
    if(strategy==='intraday')evidence.push(['range_reversion','gap_reversal'].includes(setup)?'Complete current-session VWAP coverage; reversal-specific positioning rules apply':'Complete current-session VWAP coverage; entry is on its directional side');
    evidence.push(...patterns.bullish.map(row=>`${row.name}: ${row.context} (heuristic strength ${row.strength}/100)`));
    candidates.push(new Signal({strategy,side,reference:price,stop:price-direction*risk,target:direction*(target??last.close+risk*(strategy==='intraday'?2:2.5)),
      reason:`${side} ${setup.replaceAll('_',' ')}: ${score}/100 confluence (not a probability)`,score,setup,evidence,
      opposition:patterns.bearish.map(row=>row.name),score_components:Object.fromEntries(Object.entries(components).map(([key,value])=>[key,Math.round(value*100)/100])),strategy_version:STRATEGY_VERSION}));
  }
  candidates.sort((a,b)=>b.score-a.score||a.setup.localeCompare(b.setup));
  return candidates.length?[candidates[0],'candidate',explanation]:reject(explanation.setups.some(row=>row.reason==='score_below_minimum')?'score_below_minimum':'no_enhanced_setup');
}

/** Optional software exit from completed candles; caller still verifies live ownership/quotes. */
export function technical_exit(bars,position, supplied={},context={}){
  if(supplied?.enhanced_signals!==true||supplied.technical_exit_enabled===false)return null;
  if(!Array.isArray(bars)||bars.length<2)return null;
  const options={...ENHANCED_DEFAULTS,...supplied},strategy=position?.strategy,side=position?.side??'BUY',direction=side==='SELL'?-1:1;
  if(!options_valid(options)||!['intraday','swing'].includes(strategy))return null;
  if(!['BUY','SELL'].includes(side)||strategy==='swing'&&side==='SELL')return null;
  const snapshot=strategy_snapshot(bars,strategy,context,options);if(!snapshot.data_valid||!snapshot.indicators_ready)return null;
  if(strategy==='swing'&&bars.slice(1).some((bar,i)=>Math.abs(bar.open/bars[i].close-1)>.2))return null;
  const opened=parseTime(position?.opened_at??position?.entry_time),lastAt=parseTime(bars.at(-1).time??bars.at(-1).date);
  const closed=strategy==='intraday'?+lastAt+FIVE_MINUTES:+parseTime(dateIST(lastAt)+'T15:30:00+05:30');
  if(opened&&closed<=+opened)return null;
  const metrics=oriented_metrics(snapshot,direction);bars=oriented_bars(bars,direction);
  const last=bars.at(-1),previous=bars.at(-2),patterns=pattern_evidence(metrics,options,side);
  let reason=null,evidence=[];
  if(position?.setup==='range_reversion'&&last.close>=metrics.bollinger_middle20){reason='reversion_mean_reached';evidence=['Completed close reached the current Bollinger mid-band'];}
  else if(last.close<metrics.ema21&&metrics.ema9<metrics.ema21&&metrics.macd_histogram<0&&metrics.minus_di14>metrics.plus_di14){
    reason='technical_trend_failure';evidence=['Close and EMA9 crossed to the adverse side of EMA21','MACD histogram and directional movement oppose the held position'];
  }else if(patterns.opposition>=80&&last.close<previous.low&&metrics.previous_macd_histogram!==null&&metrics.macd_histogram<metrics.previous_macd_histogram&&metrics.rsi14<60){
    reason=side==='BUY'?'bearish_pattern_confirmed':'bullish_pattern_confirmed';evidence=[...patterns.bearish.filter(row=>row.strength>=80).map(row=>row.name),'Close crossed the prior adverse extreme with deteriorating directional momentum'];
  }
  return reason?{exit:true,reason,evidence,side,strategy_version:STRATEGY_VERSION}:null;
}

/** Shared daily delivery management; executable-price checks remain at the caller. */
export function daily_holding_exit(bars,position={}){
  if(!validate_bars(bars,{interval:'swing'}).valid||bars.length<21||bars.slice(1).some((bar,i)=>Math.abs(bar.open/bars[i].close-1)>.2))return null;
  const volatility=atr(bars),tick=position.tick_size??.05,previous=position.trailing_stop??position.stop??0;
  if(!Number.isFinite(volatility)||volatility<=0||!Number.isFinite(tick)||tick<=0||!Number.isFinite(previous)||previous<0)return null;
  const raw=Math.max(previous,Math.max(...bars.slice(-20).map(bar=>bar.close))-3*volatility);if(!Number.isFinite(raw)||raw<=0)return null;
  const fraction=value=>{const [mantissa,exponent='0']=String(value).toLowerCase().split('e'),parts=mantissa.split('.'),scale=(parts[1]?.length??0)-Number(exponent);return scale>=0?[BigInt(parts.join('')),10n**BigInt(scale)]:[BigInt(parts.join(''))*10n**BigInt(-scale),1n];};
  const [rn,rd]=fraction(raw),[tn,td]=fraction(tick),trailing_stop=Number((rn*td/(rd*tn))*tn)/Number(td);
  const average20=mean(bars.slice(-20).map(bar=>bar.close));
  return {trailing_stop,trend_exit:bars.at(-1).close<average20&&mean(bars.slice(-5).map(bar=>bar.close))<average20,atr14:volatility,reference_close:bars.at(-1).close};
}

/** Do not create overnight exposure that the already-known daily policy exits.
 * Call again with the executable entry: a gap can cross a stronger daily trail
 * while remaining above the original signal stop. Only completed bars belong here.
 */
export function swing_entry_gate(bars,signal,executable_entry=signal?.reference){
  if(signal?.strategy!=='swing'||(signal.side??'BUY')!=='BUY'||!Number.isFinite(executable_entry)||executable_entry<=0||!Number.isFinite(signal.stop)||signal.stop<=0)return 'invalid_swing_entry';
  const daily=daily_holding_exit(bars,signal);
  if(!daily)return 'daily_entry_history_unavailable';
  if(daily.trend_exit)return 'daily_trend_exit_active';
  return executable_entry<=daily.trailing_stop?'daily_trailing_exit_active':null;
}

export function position_size(capital, free_cash, entry, stop, risk_pct, max_position_pct,side='BUY') {
  if (![capital, free_cash, entry, stop, risk_pct, max_position_pct].every(Number.isFinite)) return 0;
  if (!['BUY','SELL'].includes(side)||capital <= 0 || free_cash <= 0 || entry<=0||stop <= 0||(side==='BUY'?entry<=stop:entry>=stop)) return 0;
  const per_share_risk = Math.abs(entry - stop) + entry * 0.002;
  return Math.max(0, Math.floor(Math.min(capital * risk_pct / per_share_risk,
    capital * max_position_pct / (entry * 1.001), free_cash / (entry * 1.001))));
}
