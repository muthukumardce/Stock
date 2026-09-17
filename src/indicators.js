/** Closed-candle indicators. All recurrences use only the supplied prefix. */
import {parseTime,dateIST,timeIST} from './util.js';
import {detect_patterns} from './patterns.js';

const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
const last=values=>values.at(-1)??null;
export function validate_bars(bars,{interval=null}={}) {
  if(!Array.isArray(bars))return {valid:false,reason:'invalid_bar_data'};
  let previous=null,session=null;
  for(const bar of bars){
    if(!bar||![bar.open,bar.high,bar.low,bar.close,bar.volume].every(Number.isFinite)||bar.low<=0||bar.volume<0||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close))return {valid:false,reason:'invalid_bar_data'};
    const raw=bar.time??bar.date,at=parseTime(raw);if(!at)return {valid:false,reason:'invalid_bar_time'};
    if(typeof raw==='string'){
      const parts=/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
      if(!parts||new Date(Date.UTC(+parts[1],+parts[2]-1,+parts[3])).toISOString().slice(0,10)!==raw.slice(0,10)||
          parts[4]!==undefined&&(+parts[4]>23||+parts[5]>59||+(parts[6]??0)>59))return {valid:false,reason:'invalid_bar_time'};
    }
    if(previous&&at<=previous)return {valid:false,reason:'non_monotonic_bars'};
    if(interval==='intraday'){
      if(+at%300000!==0||timeIST(at)<'09:15'||timeIST(at)>='15:30')return {valid:false,reason:'invalid_session_bar'};
      session??=dateIST(at);if(dateIST(at)!==session)return {valid:false,reason:'session_mismatch'};
      if(previous&&at-previous!==300000)return {valid:false,reason:'candle_gap'};
    }
    if(interval==='swing'&&previous){
      if(dateIST(at)===dateIST(previous))return {valid:false,reason:'duplicate_daily_bar'};
      if(at-previous>7*86400000)return {valid:false,reason:'daily_gap'};
    }
    previous=at;
  }
  return {valid:true,reason:null};
}
function periodOK(period){return Number.isInteger(period)&&period>0;}
export function ema_series(values,period){
  if(!Array.isArray(values)||!periodOK(period)||values.some(value=>!Number.isFinite(value)))return [];
  const result=Array(values.length).fill(null);if(values.length<period)return result;
  let value=mean(values.slice(0,period));result[period-1]=value;
  const alpha=2/(period+1);
  for(let i=period;i<values.length;i++){value+=alpha*(values[i]-value);result[i]=value;}
  return result;
}
export function wilder_rsi_series(values,period=14){
  if(!Array.isArray(values)||!periodOK(period)||values.some(value=>!Number.isFinite(value)))return [];
  const result=Array(values.length).fill(null);if(values.length<=period)return result;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const change=values[i]-values[i-1];gain+=Math.max(0,change)/period;loss+=Math.max(0,-change)/period;}
  const rsi=()=>gain+loss===0?50:Math.max(0,Math.min(100,100*gain/(gain+loss))); // Explicit neutral convention for flat series.
  result[period]=rsi();
  for(let i=period+1;i<values.length;i++){const change=values[i]-values[i-1];gain=(gain*(period-1)+Math.max(0,change))/period;loss=(loss*(period-1)+Math.max(0,-change))/period;result[i]=rsi();}
  return result;
}
export function directional_series(bars,period=14){
  const count=Array.isArray(bars)?bars.length:0;
  const result={atr:Array(count).fill(null),plus_di:Array(count).fill(null),minus_di:Array(count).fill(null),adx:Array(count).fill(null)};
  if(!periodOK(period)||!validate_bars(bars).valid||count<=period)return result;
  let tr=0,plus=0,minus=0,adx=null;const dx=[];
  for(let i=1;i<count;i++){
    const bar=bars[i],before=bars[i-1],up=bar.high-before.high,down=before.low-bar.low;
    const range=Math.max(bar.high-bar.low,Math.abs(bar.high-before.close),Math.abs(bar.low-before.close));
    const pos=up>down&&up>0?up:0,neg=down>up&&down>0?down:0;
    if(i<=period){tr+=range/period;plus+=pos/period;minus+=neg/period;}else{tr=(tr*(period-1)+range)/period;plus=(plus*(period-1)+pos)/period;minus=(minus*(period-1)+neg)/period;}
    if(i<period)continue;
    result.atr[i]=tr;result.plus_di[i]=tr?100*plus/tr:0;result.minus_di[i]=tr?100*minus/tr:0;
    const value=plus+minus?100*Math.abs(plus-minus)/(plus+minus):0;dx.push(value);
    if(dx.length===period)adx=mean(dx);else if(dx.length>period)adx=(adx*(period-1)+value)/period;
    result.adx[i]=adx;
  }
  return result;
}
export function macd_series(values,fast=12,slow=26,signal=9){
  if(!Array.isArray(values)||values.some(value=>!Number.isFinite(value))||!periodOK(fast)||!periodOK(slow)||!periodOK(signal)||fast>=slow)return {macd:[],signal:[],histogram:[]};
  const fastEMA=ema_series(values,fast),slowEMA=ema_series(values,slow);
  const macd=values.map((_,i)=>slowEMA[i]===null||slowEMA[i]===undefined?null:fastEMA[i]-slowEMA[i]);
  const compact=ema_series(macd.filter(value=>value!==null),signal),signalLine=macd.map((value,i)=>value===null?null:compact[i-slow+1]??null);
  return {macd,signal:signalLine,histogram:macd.map((value,i)=>signalLine[i]===null?null:value-signalLine[i])};
}
export function bollinger(values,period=20,deviations=2){
  if(!Array.isArray(values)||!periodOK(period)||!Number.isFinite(deviations)||deviations<0||values.length<period||values.some(value=>!Number.isFinite(value)))return {middle:null,upper:null,lower:null,width:null};
  const window=values.slice(-period),middle=mean(window),sd=Math.sqrt(mean(window.map(value=>(value-middle)**2)));
  const upper=middle+deviations*sd,lower=middle-deviations*sd;
  return {middle,upper,lower,width:middle>0?(upper-lower)/middle:null};
}
export function session_vwap(bars){
  const missing={session_vwap:null,window_vwap:null,vwap_scope:'unavailable',session_vwap_complete:false,vwap_coverage_bars:0};
  if(!bars?.length||!validate_bars(bars).valid)return missing;
  const end=parseTime(bars.at(-1).time??bars.at(-1).date),session=bars.filter(bar=>dateIST(parseTime(bar.time??bar.date))===dateIST(end));
  if(session.some(bar=>{const at=parseTime(bar.time??bar.date);return +at%300000!==0||timeIST(at)<'09:15'||timeIST(at)>='15:30';}))return {...missing,vwap_scope:'not_intraday'};
  let volume=0,weighted=0;
  for(const bar of session){volume+=bar.volume;weighted+=(bar.high+bar.low+bar.close)/3*bar.volume;}
  if(volume<=0||!Number.isFinite(volume)||!Number.isFinite(weighted))return {...missing,vwap_coverage_bars:session.length};
  const complete=timeIST(parseTime(session[0].time??session[0].date))==='09:15'&&validate_bars(session,{interval:'intraday'}).valid;
  const value=weighted/volume;
  return {session_vwap:complete?value:null,window_vwap:value,vwap_scope:complete?'session':'window',session_vwap_complete:complete,vwap_coverage_bars:session.length};
}
export function indicator_snapshot(bars,{strategy=null}={}){
  const quality=validate_bars(bars,{interval:strategy});
  const unavailable={data_valid:quality.valid,data_issue:quality.reason,indicators_ready:false,ema9:null,ema21:null,rsi14:null,macd:null,macd_signal:null,macd_histogram:null,previous_macd_histogram:null,previous_rsi14:null,adx14:null,plus_di14:null,minus_di14:null,atr_wilder14:null,atr_extension:null,relative_volume20:null,bollinger_middle20:null,bollinger_upper20:null,bollinger_lower20:null,bollinger_width20:null,previous_bollinger_lower20:null,previous_ema9:null,session_vwap:null,window_vwap:null,vwap_scope:'unavailable',session_vwap_complete:false,vwap_coverage_bars:0,patterns:[]};
  if(!quality.valid||!bars.length)return unavailable;
  const closes=bars.map(bar=>bar.close),ema9=ema_series(closes,9),ema21=ema_series(closes,21),rsi=wilder_rsi_series(closes),macd=macd_series(closes),direction=directional_series(bars),bands=bollinger(closes),previousBands=bollinger(closes.slice(0,-1));
  const atr=last(direction.atr),slow=last(ema21),priorVolume=bars.length>=21?mean(bars.slice(-21,-1).map(bar=>bar.volume)):null;
  const snapshot={...unavailable,indicators_ready:Number.isFinite(last(macd.histogram))&&Number.isFinite(last(direction.adx)),
    ema9:last(ema9),ema21:slow,rsi14:last(rsi),macd:last(macd.macd),macd_signal:last(macd.signal),macd_histogram:last(macd.histogram),previous_macd_histogram:macd.histogram.at(-2)??null,previous_rsi14:rsi.at(-2)??null,
    adx14:last(direction.adx),plus_di14:last(direction.plus_di),minus_di14:last(direction.minus_di),atr_wilder14:atr,atr_extension:atr>0&&slow!==null?(closes.at(-1)-slow)/atr:null,relative_volume20:priorVolume>0?bars.at(-1).volume/priorVolume:null,
    bollinger_middle20:bands.middle,bollinger_upper20:bands.upper,bollinger_lower20:bands.lower,bollinger_width20:bands.width,previous_bollinger_lower20:previousBands.lower,previous_ema9:ema9.at(-2)??null,
    ...(strategy==='swing'?{vwap_scope:'not_intraday'}:session_vwap(bars)),patterns:detect_patterns(bars)};
  if(Object.values(snapshot).some(value=>typeof value==='number'&&!Number.isFinite(value)))return {...unavailable,data_valid:false,data_issue:'indicator_overflow'};
  return snapshot;
}
