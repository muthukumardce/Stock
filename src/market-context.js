/** Read-only market context. No trading client or secrets are persisted.
 * Public schemas were verified against NSE's corporate-filings.js and current
 * NSE Indices CSV downloads. Public website endpoints have no availability SLA.
 * https://www.nseindia.com/companies-listing/corporate-filings-board-meetings
 * https://www.nseindia.com/companies-listing/corporate-filings-event-calendar
 * https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-500
 * https://kite.trade/docs/connect/v3/market-data-and-instruments/
 * https://kite.trade/docs/connect/v3/historical/
 */
import {createHash} from 'node:crypto';
import {dateIST, isoIST, parseTime} from './util.js';

const DAY=86400000,MINUTE=60000,VERSION=1,CACHE_KEY='market_context_cache_v1';
const SYMBOL=/^[A-Z0-9][A-Z0-9&._-]{0,39}$/,ISIN=/^IN[A-Z0-9]{10}$/;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>finite(value)&&value>0;
const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
const text=(value,max=250)=>typeof value==='string'?value.trim().slice(0,max):'';
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const bounded=(value,fallback,min,max)=>finite(value)&&value>=min&&value<=max?value:fallback;

export const MARKET_CONTEXT_DEFAULTS=Object.freeze({event_risk_enabled:true,event_blackout_before_days:1,event_blackout_after_days:1,
  market_context_max_age_minutes:60,classification_max_age_days:7,benchmark_max_age_seconds:120});
export const INDEX_SOURCES=Object.freeze([
  ['niftytotalmarket','NIFTY TOTAL MARKET','totalmarket_'],
  ['nifty500','NIFTY 500','500'],['nifty50','NIFTY 50','50'],['niftybank','NIFTY BANK','bank'],
  ['niftyit','NIFTY IT','it'],['niftypharma','NIFTY PHARMA','pharma'],['niftyauto','NIFTY AUTO','auto'],
  ['niftyfmcg','NIFTY FMCG','fmcg'],['niftymetal','NIFTY METAL','metal'],
].map(([id,name,file])=>Object.freeze({id,name,url:`https://www.niftyindices.com/IndexConstituent/ind_nifty${file}list.csv`})));
const CONSTITUENT_MINIMUM={niftytotalmarket:700,nifty500:400,nifty50:40,niftybank:8,niftyit:7,niftypharma:10,niftyauto:8,niftyfmcg:8,niftymetal:8};
export const BROAD_INDEX_NAMES=Object.freeze(['NIFTY 50','NIFTY 500','NIFTY TOTAL MARKET']);
export const BENCHMARKS=Object.freeze(INDEX_SOURCES.filter(source=>source.id!=='niftytotalmarket').map(({name})=>Object.freeze({name,key:`NSE:${name}`})));
const EVENT_SOURCES=Object.freeze({board:'https://www.nseindia.com/api/corporate-board-meetings',calendar:'https://www.nseindia.com/api/event-calendar'});
class ContextError extends Error {constructor(code){super(code);this.name='ContextError';this.code=code;}}
const fail=code=>{throw new ContextError(code);};

/** RFC 4180, with column/row consistency checked before accepting any mapping. */
export function parseIndexConstituents(csv,{withMetadata=false}={}){
  if(typeof csv!=='string'||csv.length>2_000_000)fail('invalid_constituent_size');
  const records=[];let row=[],field='',quoted=false;
  for(let i=0;i<csv.length;i++){
    const char=csv[i];
    if(char==='"'){if(quoted&&csv[i+1]==='"'){field+='"';i++;}else if(quoted||!field)quoted=!quoted;else fail('invalid_csv_quote');}
    else if(!quoted&&[',','\r','\n'].includes(char)){
      row.push(field);field='';if(char!==','){if(row.some(Boolean))records.push(row);row=[];if(char==='\r'&&csv[i+1]==='\n')i++;}
    }else field+=char;
  }
  if(quoted)fail('invalid_csv_quote');if(field||row.length){row.push(field);records.push(row);}
  const columns=records.shift()?.map(value=>value.replace(/^\uFEFF/,'').trim())||[];
  const required=['Company Name','Industry','Symbol','Series','ISIN Code'];
  if(required.some(key=>!columns.includes(key))||new Set(columns).size!==columns.length||records.length<1||records.length>2000)fail('invalid_constituent_schema');
  const seen=new Set(),excluded=[];
  const accepted=records.flatMap(values=>{
    if(values.length!==columns.length)fail('invalid_constituent_row');
    const record=Object.fromEntries(columns.map((key,i)=>[key,values[i].trim()]));
    const symbol=record.Symbol,industry=record.Industry,name=record['Company Name'],isin=record['ISIN Code'];
    if(!SYMBOL.test(symbol)||!['EQ','BE','BZ'].includes(record.Series)||!industry||industry==='-'||industry.length>120||!name||name.length>250||seen.has(symbol))fail('invalid_constituent_row');
    seen.add(symbol);
    // Index corporate-action placeholders are not tradable securities. The
    // official Nifty500 file currently includes a Dummy HEG/DUMMYHEG/DUM... row.
    // Exclude only this unambiguous marker combination; malformed real rows fail.
    if(/^Dummy\s/i.test(name)&&symbol.startsWith('DUMMY')&&/^DU[A-Z0-9]{9,10}$/.test(isin)){excluded.push({symbol,reason:'index_corporate_action_placeholder'});return [];}
    if(!ISIN.test(isin))fail('invalid_constituent_row');
    return [{symbol,industry,name,isin,series:record.Series}];
  });
  return withMetadata?{records:accepted,excluded,total_rows:records.length}:accepted;
}

/** Calendar dates have no event time. Interpret entire days in exchange time. */
export function parseNseDate(value){
  if(typeof value!=='string')return null;
  const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  let match=value.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/),year,month,day;
  if(match){day=+match[1];month=months[match[2].toLowerCase()];year=+match[3];}
  else if((match=value.match(/^(\d{4})-(\d{2})-(\d{2})$/))){year=+match[1];month=+match[2];day=+match[3];}
  else return null;
  if(year<2000||year>2100||!month||day<1||day>31)return null;
  const check=new Date(Date.UTC(year,month-1,day));if(check.getUTCMonth()!==month-1||check.getUTCDate()!==day)return null;
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function announcementTime(value){
  if(typeof value!=='string')return null;
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/.test(value))return parseTime(value)?value:null;
  const match=value.match(/^(\d{2}-[A-Za-z]{3}-\d{4}) (\d{2}:\d{2}:\d{2})$/),date=match&&parseNseDate(match[1]);
  if(!date||!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(match[2]))return null;
  return `${date}T${match[2]}+05:30`;
}
export function parseCorporateEvents(payload,{source,from,to}={}){
  if(!Object.hasOwn(EVENT_SOURCES,source)||!parseNseDate(from)||!parseNseDate(to)||from>to||!Array.isArray(payload)||payload.length>20000)fail('invalid_event_schema');
  const seen=new Set(),events=[];
  for(const row of payload){
    if(!object(row))fail('invalid_event_row');
    const symbol=source==='board'?row.bm_symbol:row.symbol,date=parseNseDate(source==='board'?row.bm_date:row.date);
    const purpose=text(source==='board'?row.bm_purpose:row.purpose,500),description=text(row.bm_desc,3000);
    if(typeof symbol!=='string'||!SYMBOL.test(symbol)||!date||date<from||date>to||!purpose)fail('invalid_event_row');
    const kind=/financial\s+results|(?:quarterly|annual|audited|unaudited)\s+(?:financial\s+)?results|earnings/i.test(purpose+' '+description)?'financial_results':'board_meeting';
    const id=hash([source,symbol,date,purpose,description].join('|'));
    if(seen.has(id))continue;seen.add(id);
    events.push({id,symbol,date,kind,purpose,description,source,announced_at:source==='board'?announcementTime(row.bm_timestamp):null,
      possible_schedule_change:/reschedul|postpon|cancel/i.test(purpose+' '+description)});
  }
  return events.sort((a,b)=>a.date.localeCompare(b.date)||a.symbol.localeCompare(b.symbol)||a.id.localeCompare(b.id));
}

function ddmmyyyy(date){return date.split('-').reverse().join('-');}
function age(now,at){const parsed=parseTime(at);return parsed&&+parsed<=+now+5000?Math.max(0,+now-parsed):Infinity;}
function isoDayAt(date){return parseTime(date+'T00:00:00+05:30');}
function validMeta(meta,now){return object(meta)&&Number.isFinite(age(now,meta.observed_at));}
function errorCode(error){return error instanceof ContextError?error.code:error?.name==='AbortError'||error?.name==='TimeoutError'?'request_timeout':'request_failed';}
function copy(value){return structuredClone(value);}

export class MarketContext {
  constructor(store,settings={},options={}){
    this.store=store;this.settings=settings;this.fetch=options.fetch||globalThis.fetch;this.now=options.now||(()=>new Date());
    this.timeout_ms=bounded(options.timeout_ms,10000,5,30000);this.max_response_bytes=bounded(options.max_response_bytes,5_000_000,100,10_000_000);
    this.indexSources=options.indexSources||INDEX_SOURCES;this.benchmarks=options.benchmarks||BENCHMARKS;
    if(!Array.isArray(this.indexSources)||this.indexSources.some(source=>!INDEX_SOURCES.some(known=>known.id===source.id&&known.url===source.url&&known.name===source.name))||new Set(this.indexSources.map(s=>s.id)).size!==this.indexSources.length)throw new TypeError('Only the fixed official constituent sources are supported');
    if(!Array.isArray(this.benchmarks)||this.benchmarks.some(source=>!BENCHMARKS.some(known=>known.key===source.key&&known.name===source.name))||new Set(this.benchmarks.map(s=>s.key)).size!==this.benchmarks.length)throw new TypeError('Unsupported benchmark selection');
    this.controller=new AbortController();this.closed=false;this.pending=null;this.brokerPending=new Map();this.universe=[];this.symbols=new Set();this.lookupDirty=true;this.engine=null;this.boundBroker=null;this.brokerGeneration=0;
    this.cache={version:VERSION,indexes:{},events:{},benchmarks:{},attempts:{}};this._restore();
  }
  _options(){return {event_risk_enabled:this.settings.event_risk_enabled??true,
    before:bounded(this.settings.event_blackout_before_days,1,0,14),after:bounded(this.settings.event_blackout_after_days,1,0,14),
    event_age:bounded(this.settings.market_context_max_age_minutes,60,1,1440)*MINUTE,
    classification_age:bounded(this.settings.classification_max_age_days,7,1,30)*DAY,
    benchmark_age:bounded(this.settings.benchmark_max_age_seconds,120,10,600)*1000};}
  _restore(){
    let saved;try{saved=this.store?.get(CACHE_KEY,null);}catch{return;}
    if(!object(saved)||saved.version!==VERSION)return;
    const now=this.now();
    for(const source of this.indexSources){try{
      const item=saved.indexes?.[source.id];if(!validMeta(item,now)||item.source!==source.url||!Array.isArray(item.records))continue;
      const csv='Company Name,Industry,Symbol,Series,ISIN Code\n'+item.records.map(r=>[r.name,r.industry,r.symbol,r.series||'EQ',r.isin].map(value=>'"'+String(value).replaceAll('"','""')+'"').join(',')).join('\n');
      const records=parseIndexConstituents(csv);if(records.length<CONSTITUENT_MINIMUM[source.id]||source.id==='niftytotalmarket'&&records.length>1000)continue;
      this.cache.indexes[source.id]={...item,records};
    }catch{}}
    for(const source of Object.keys(EVENT_SOURCES)){try{
      const item=saved.events?.[source];if(!validMeta(item,now)||item.source!==EVENT_SOURCES[source]||!parseNseDate(item.from)||!parseNseDate(item.to)||!Array.isArray(item.rows))continue;
      this.cache.events[source]={...item,events:parseCorporateEvents(item.rows,{source,from:item.from,to:item.to})};
    }catch{}}
    for(const benchmark of this.benchmarks){try{
      const item=saved.benchmarks?.[benchmark.key];if(!object(item))continue;
      const restored={};if(item.quote)restored.quote=this._quote(item.quote.raw,now,{observed_at:item.quote.observed_at});
      if(item.history&&validMeta(item.history,now))restored.history={...item.history,bars:this._history(item.history.bars,now)};
      if(item.intraday&&validMeta(item.intraday,now))restored.intraday={...item.intraday,bars:this._intraday(item.intraday.bars,now)};
      this.cache.benchmarks[benchmark.key]=restored;
    }catch{}}
    for(const [key,item] of Object.entries(saved.attempts||{}))if(this._knownKey(key)&&object(item)&&Number.isInteger(item.failures)&&item.failures>=0&&item.failures<=20&&typeof item.error==='string'&&/^[a-z_0-9]+$/.test(item.error)&&parseTime(item.next_attempt_at)&&age(now,item.last_attempt_at)<DAY)this.cache.attempts[key]=copy(item);
  }
  _knownKey(key){return this.indexSources.some(s=>'index:'+s.id===key)||Object.keys(EVENT_SOURCES).some(s=>'event:'+s===key)||key==='benchmark:quotes'||this.benchmarks.some(b=>'history:'+b.key===key||'intraday:'+b.key===key);}
  _persist(){this.lookupDirty=true;this.store?.set(CACHE_KEY,this.cache);}
  _ready(key,force=false){const attempt=this.cache.attempts[key];return !this.closed&&(!attempt||!parseTime(attempt.next_attempt_at)||this.now()>=parseTime(attempt.next_attempt_at));}
  _success(key){delete this.cache.attempts[key];}
  _failure(key,error){
    if(this.closed)return;
    const previous=this.cache.attempts[key],failures=Math.min(20,(previous?.failures||0)+1),code=errorCode(error),now=this.now();
    this.cache.attempts[key]={failures,error:code,last_attempt_at:isoIST(now),next_attempt_at:isoIST(new Date(+now+Math.min(60*MINUTE,MINUTE*2**Math.min(6,failures-1))))};
    if(previous?.error!==code)this.store?.event('market_context.unavailable','A market-context source is unavailable; source age and coverage remain explicit.',{source:key,reason:code},'warning');
  }
  async _bounded(task){
    const local=new AbortController(),signal=AbortSignal.any([this.controller.signal,local.signal]);let timer;
    const timed=new Promise((_,reject)=>{timer=setTimeout(()=>{local.abort();reject(new ContextError('request_timeout'));},this.timeout_ms);});
    const aborted=new Promise((_,reject)=>{if(signal.aborted)reject(new ContextError('request_cancelled'));else signal.addEventListener('abort',()=>reject(new ContextError(this.closed?'request_cancelled':'request_timeout')),{once:true});});
    try{return await Promise.race([Promise.resolve().then(()=>task(signal)),timed,aborted]);}finally{clearTimeout(timer);local.abort();}
  }
  async _read(url,type){
    return this._bounded(async signal=>{
      const response=await this.fetch(url,{signal,redirect:'error',headers:{Accept:type==='json'?'application/json':'text/csv, text/plain, application/octet-stream'}});
      if(!response.ok)fail(`http_${Number(response.status)||0}`);
      const contentType=response.headers?.get('content-type')||'';
      if(type==='json'?!/application\/(?:[\w.+-]*\+)?json/i.test(contentType):!/text\/(?:csv|plain)|application\/(?:octet-stream|vnd.ms-excel)/i.test(contentType))fail('invalid_content_type');
      const announced=Number(response.headers?.get('content-length'));if(announced>this.max_response_bytes)fail('response_too_large');
      if(!response.body?.getReader)fail('invalid_response_body');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>this.max_response_bytes)fail('response_too_large');chunks.push(value);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}
      const body=Buffer.concat(chunks).toString('utf8');
      if(type==='json'){try{return JSON.parse(body);}catch{fail('invalid_json');}}return body;
    });
  }
  async _refreshIndexes(force,sources=this.indexSources){
    for(const source of sources){
      if(this.closed)return;
      const key='index:'+source.id,item=this.cache.indexes[source.id];
      if(!this._ready(key,force)||!force&&item&&age(this.now(),item.observed_at)<DAY)continue;
      try{const parsed=parseIndexConstituents(await this._read(source.url,'csv'),{withMetadata:true});if(parsed.records.length<CONSTITUENT_MINIMUM[source.id]||source.id==='niftytotalmarket'&&parsed.records.length>1000)fail('constituent_coverage_incomplete');if(this.closed)return;
        this.cache.indexes[source.id]={source:source.url,observed_at:isoIST(this.now()),...parsed};this._success(key);
      }catch(error){this._failure(key,error);}
      if(!this.closed)this._persist();
    }
  }
  async _refreshEvents(force){
    const now=this.now(),opts=this._options(),today=isoDayAt(dateIST(now)),from=dateIST(new Date(+today-Math.max(14,opts.after)*DAY)),to=dateIST(new Date(+today+Math.max(14,opts.before)*DAY));
    for(const [source,base] of Object.entries(EVENT_SOURCES)){
      if(this.closed)return;
      const key='event:'+source,item=this.cache.events[source];
      if(!this._ready(key,force)||!force&&item&&age(now,item.observed_at)<Math.min(30*MINUTE,opts.event_age/2)&&item.from<=from&&item.to>=to)continue;
      const url=new URL(base);if(source==='board')url.searchParams.set('index','equities');url.searchParams.set('from_date',ddmmyyyy(from));url.searchParams.set('to_date',ddmmyyyy(to));
      try{const rows=await this._read(url.href,'json'),events=parseCorporateEvents(rows,{source,from,to});if(this.closed)return;
        // Keep only fields the strict parser uses. Source descriptions are public;
        // no attachments, credentials, cookies or arbitrary response objects persist.
        const compact=events.map(event=>source==='board'?{bm_symbol:event.symbol,bm_date:event.date,bm_purpose:event.purpose,bm_desc:event.description,bm_timestamp:event.announced_at?event.announced_at:null}:{symbol:event.symbol,date:event.date,purpose:event.purpose,bm_desc:event.description});
        this.cache.events[source]={source:base,observed_at:isoIST(this.now()),from,to,rows:compact,events};this._success(key);
      }catch(error){this._failure(key,error);}
      if(!this.closed)this._persist();
    }
  }
  _quote(raw,now,{observed_at=isoIST(now)}={}){
    if(!object(raw)||!positive(raw.last_price)||!Number.isSafeInteger(raw.instrument_token)||raw.instrument_token<=0||!object(raw.ohlc)||!positive(raw.ohlc.open)||!positive(raw.ohlc.close)||!Number.isFinite(age(now,observed_at)))fail('invalid_benchmark_quote');
    const exchange=parseTime(raw.timestamp??raw.last_trade_time);if(!exchange||+exchange>+now+5000)fail('invalid_benchmark_timestamp');
    const clean={instrument_token:raw.instrument_token,last_price:raw.last_price,ohlc:{open:raw.ohlc.open,close:raw.ohlc.close},timestamp:isoIST(exchange)};
    return {raw:clean,observed_at,exchange_at:clean.timestamp,price:raw.last_price,change_from_open:raw.last_price/raw.ohlc.open-1,change_from_previous_close:raw.last_price/raw.ohlc.close-1};
  }
  _history(rows,now){
    if(!Array.isArray(rows)||rows.length>1000)fail('invalid_benchmark_history');
    const result=[];let previous='';
    for(const row of rows){
      if(!object(row)||!['open','high','low','close','volume'].every(k=>finite(row[k]))||Math.min(row.open,row.high,row.low,row.close)<=0||row.volume<0||row.high<Math.max(row.open,row.close)||row.low>Math.min(row.open,row.close))fail('invalid_benchmark_history');
      const at=parseTime(row.time??row.date);if(!at)fail('invalid_benchmark_history');const date=dateIST(at);
      if(date>=dateIST(now))continue;if(date<=previous)fail('invalid_benchmark_history');previous=date;
      result.push({time:isoIST(at),open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume});
    }
    if(result.length<50||+now-parseTime(result.at(-1).time)>7*DAY)fail('benchmark_history_unavailable');
    return result;
  }
  _intraday(rows,now){
    if(!Array.isArray(rows)||rows.length>100)fail('invalid_benchmark_intraday');
    const result=[];let previous=null;
    for(const row of rows){
      if(!object(row)||!['open','high','low','close','volume'].every(k=>finite(row[k]))||Math.min(row.open,row.high,row.low,row.close)<=0||row.volume<0||row.high<Math.max(row.open,row.close)||row.low>Math.min(row.open,row.close))fail('invalid_benchmark_intraday');
      const at=parseTime(row.time??row.date);if(!at||dateIST(at)!==dateIST(now)||+at%300000!==0)fail('invalid_benchmark_intraday');
      const clock=isoIST(at).slice(11,16);if(clock<'09:15'||clock>='15:30')fail('invalid_benchmark_intraday');
      if(+at+300000>+now)continue;if(previous&&+at-previous!==300000)fail('benchmark_intraday_gap');previous=+at;
      result.push({time:isoIST(at),open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume});
    }
    if(result.length&&isoIST(parseTime(result[0].time)).slice(11,16)!=='09:15')fail('benchmark_intraday_partial_session');
    return result;
  }
  async _brokerCall(broker,method,...args){
    const key=method+':'+(method==='quote'?'benchmarks':args[0]+':'+args[3]);
    if(this.brokerPending.has(key))fail('broker_request_pending');
    const task=Promise.resolve().then(()=>broker.call(method,...args));this.brokerPending.set(key,task);
    task.finally(()=>{if(this.brokerPending.get(key)===task)this.brokerPending.delete(key);}).catch(()=>{});
    return this._bounded(()=>task);
  }
  async _refreshBenchmarks(engine,force){
    if(this.closed||!engine?.connected||!engine.broker||!this.benchmarks.length)return;
    const broker=engine.broker,generation=this.brokerGeneration,valid=()=>!this.closed&&engine.broker===broker&&engine.connected&&this.boundBroker===broker&&this.brokerGeneration===generation;
    const now=this.now(),key='benchmark:quotes',recent=this.benchmarks.every(b=>age(now,this.cache.benchmarks[b.key]?.quote?.observed_at)<30_000);
    if(this._ready(key,force)&&(force||!recent)){
      try{const quotes=await this._brokerCall(broker,'quote',this.benchmarks.map(b=>b.key));if(!valid())return;
        if(!object(quotes))fail('invalid_benchmark_quote');let missing=false;
        for(const benchmark of this.benchmarks){try{
          const quote=this._quote(quotes[benchmark.key],this.now()),item=this.cache.benchmarks[benchmark.key]||={};
          if(item.history?.instrument_token!==quote.raw.instrument_token)delete item.history;
          if(item.quote&&item.quote.raw.instrument_token!==quote.raw.instrument_token)delete item.intraday;item.quote=quote;delete item.quote_error;
        }catch(error){(this.cache.benchmarks[benchmark.key]||={}).quote_error=errorCode(error);missing=true;}}
        if(missing)this._failure(key,new ContextError('benchmark_quote_missing'));else this._success(key);
      }catch(error){this._failure(key,error);}
      if(!this.closed)this._persist();
    }
    for(const benchmark of this.benchmarks){
      if(!valid())return;
      const item=this.cache.benchmarks[benchmark.key],historyKey='history:'+benchmark.key;
      if(!item?.quote)continue;
      if(this._ready(historyKey,force)&&(force||!item.history||dateIST(parseTime(item.history.observed_at))!==dateIST(now))){
        try{const end=isoDayAt(dateIST(now)),rows=await this._brokerCall(broker,'historical_data',item.quote.raw.instrument_token,new Date(+end-180*DAY),new Date(+end-1000),'day');
          if(!valid())return;
          item.history={observed_at:isoIST(this.now()),instrument_token:item.quote.raw.instrument_token,bars:this._history(rows,this.now())};this._success(historyKey);
        }catch(error){this._failure(historyKey,error);}
      }
      const intradayKey='intraday:'+benchmark.key,today=dateIST(this.now()),start=parseTime(today+'T09:15:00+05:30'),end=new Date(Math.min(+this.now(),+parseTime(today+'T15:30:00+05:30')));
      if(+end>=+start+300000&&this._ready(intradayKey,force)&&(force||!item.intraday||Math.floor(+parseTime(item.intraday.observed_at)/300000)<Math.floor(+end/300000))){
        try{const rows=await this._brokerCall(broker,'historical_data',item.quote.raw.instrument_token,start,end,'5minute');
          if(!valid())return;
          item.intraday={observed_at:isoIST(this.now()),bars:this._intraday(rows,this.now())};this._success(intradayKey);
        }catch(error){this._failure(intradayKey,error);}
      }
      if(!this.closed)this._persist();
    }
  }
  async refresh(engine={},options={}){
    if(this.closed)return this.snapshot();this._bindEngine(engine);if(this.pending){await this.pending;return this.snapshot();}
    this.universe=[...new Set(Object.values(engine.universe||{}).map(row=>row?.tradingsymbol).filter(symbol=>typeof symbol==='string'&&SYMBOL.test(symbol)))];
    this.symbols=new Set(this.universe);
    this.pending=(async()=>{const results=await Promise.allSettled([this._refreshIndexes(options.force===true),this._refreshEvents(options.force===true),this._refreshBenchmarks(engine,options.force===true)]);this.last_error=results.some(result=>result.status==='rejected')?'context_refresh_failed':null;})();
    try{await this.pending;}finally{this.pending=null;}return this.snapshot();
  }
  _bindEngine(engine){
    this.engine=engine;const broker=engine?.connected?engine.broker:null;
    if(broker===this.boundBroker)return;this.boundBroker=broker;this.brokerGeneration++;
    // Public classifications/calendar are reusable. A quote or same-session bar
    // from a former login must not silently authorize a new login's decision.
    for(const item of Object.values(this.cache.benchmarks)){delete item.quote;delete item.quote_error;delete item.intraday;}
    delete this.cache.attempts['benchmark:quotes'];
  }
  _brokerCurrent(){return !!this.boundBroker&&this.engine?.connected===true&&this.engine?.broker===this.boundBroker;}
  _lookups(){
    if(!this.lookupDirty)return;this.lookupDirty=false;this.classifications=new Map();this.eventsBySymbol=new Map();
    for(const source of this.indexSources){const cache=this.cache.indexes[source.id];for(const record of cache?.records||[]){if(!this.classifications.has(record.symbol))this.classifications.set(record.symbol,[]);this.classifications.get(record.symbol).push({source,cache,record});}}
    for(const source of Object.values(this.cache.events))for(const event of source.events){if(!this.eventsBySymbol.has(event.symbol))this.eventsBySymbol.set(event.symbol,[]);this.eventsBySymbol.get(event.symbol).push(event);}
  }
  _eventState(){
    const now=this.now(),options=this._options(),date=dateIST(now),from=dateIST(new Date(+isoDayAt(date)-options.after*DAY)),to=dateIST(new Date(+isoDayAt(date)+options.before*DAY));
    const sources=Object.entries(EVENT_SOURCES).map(([id,url])=>{
      const item=this.cache.events[id],fresh=!!item&&age(now,item.observed_at)<=options.event_age&&item.from<=from&&item.to>=to;
      return {id,url,status:fresh?'fresh':item?'stale':'unavailable',observed_at:item?.observed_at||null,from:item?.from||null,to:item?.to||null,event_count:item?.events.length||0,last_error:this.cache.attempts['event:'+id]?.error||null,next_attempt_at:this.cache.attempts['event:'+id]?.next_attempt_at||null};
    });
    return {status:sources.every(source=>source.status==='fresh')?'fresh':sources.some(source=>source.status==='fresh')?'partial':sources.some(source=>source.status==='stale')?'stale':'unavailable',sources};
  }
  async tradingConstituents(){
    const source=this.indexSources.find(item=>item.id==='niftytotalmarket');
    const cached=source&&this.cache.indexes[source.id],observed=parseTime(cached?.observed_at);
    // Entry eligibility needs today's membership, even when the previous day's
    // cache is still recent enough for research/classification. Respect retries.
    if(source)await this._refreshIndexes(!observed||dateIST(observed)!==dateIST(this.now()),[source]);
    const index=this.researchConstituents(),at=parseTime(index.observed_at);
    return {...index,status:index.status==='fresh'&&(!at||dateIST(at)!==dateIST(this.now()))?'stale':index.status};
  }
  researchConstituents(){
    const source=INDEX_SOURCES.find(item=>item.id==='niftytotalmarket'),cached=this.cache.indexes[source.id];
    return {name:source.name,source:source.url,observed_at:cached?.observed_at||null,
      status:cached?(age(this.now(),cached.observed_at)<=this._options().classification_age?'fresh':'stale'):'unavailable',
      records:copy(cached?.records||[]),excluded:copy(cached?.excluded||[])};
  }
  forSymbol(symbol){
    this._lookups();const now=this.now(),opts=this._options(),matches=(this.classifications.get(symbol)||[]).map(row=>({...row,fresh:age(now,row.cache.observed_at)<=opts.classification_age}));
    const fresh=matches.filter(row=>row.fresh),industries=[...new Set(fresh.map(row=>row.record.industry))],classification=industries.length===1?'fresh':industries.length>1?'conflict':matches.length?'stale':'unknown';
    const industry=classification==='fresh'?industries[0]:null,eventState=this._eventState(),today=dateIST(now),days=+isoDayAt(today);
    const events=(this.eventsBySymbol.get(symbol)||[]).map(event=>{
      const distance=Math.round((+isoDayAt(event.date)-days)/DAY);return {...event,days_from_today:distance,blackout:distance>=-opts.after&&distance<=opts.before,observed_at:this.cache.events[event.source].observed_at};
    });
    const unique=new Map();for(const event of events){const key=event.date+':'+event.kind;const existing=unique.get(key);if(existing)existing.sources=[...new Set([...existing.sources,event.source])];else unique.set(key,{...event,sources:[event.source]});}
    const upcoming=[...unique.values()].sort((a,b)=>a.date.localeCompare(b.date)),blackout=upcoming.some(event=>event.blackout);
    const known=typeof symbol==='string'&&SYMBOL.test(symbol)&&this.symbols.has(symbol);
    const eventStatus=!known?'symbol_unverified':eventState.status==='fresh'?blackout?'blackout':'no_announced_event':eventState.status;
    const entryBlocked=opts.event_risk_enabled&&(blackout||eventStatus!=='no_announced_event');
    return {symbol,sector:industry,industry,classification_status:classification,classification_label:'NSE Indices Industry classification; not a complete exchange sector taxonomy',
      classification_observed_at:classification==='fresh'?fresh.map(row=>row.cache.observed_at).sort()[0]:matches.map(row=>row.cache.observed_at).sort()[0]||null,
      index_membership:matches.map(row=>({index:row.source.name,status:row.fresh?'fresh':'stale',observed_at:row.cache.observed_at,source:row.source.url})),
      event_status:eventStatus,event_sources:eventState.sources,events:upcoming,blackout,entry_blocked:entryBlocked,
      reason:entryBlocked?(blackout?'announced_corporate_event_blackout':'corporate_event_coverage_unavailable'):null,
      message:blackout?'An announced corporate meeting falls inside the configured calendar-day blackout.':eventStatus==='no_announced_event'?'No announced event found in the fresh queried feeds; this does not exclude unannounced events.':'Corporate-event coverage is unavailable, stale, incomplete or not verified for this symbol.'};
  }
  contextForSymbol(symbol,asOf=this.now()){
    const at=parseTime(asOf);if(!at||+at>+this.now()+5000)throw new TypeError('Market context requires a current or earlier as-of timestamp');
    const info=this.forSymbol(symbol),sector=info.index_membership.filter(row=>row.status==='fresh'&&!BROAD_INDEX_NAMES.includes(row.index)).sort((a,b)=>a.index.localeCompare(b.index))[0]?.index||null;
    const barsFor=(name,type)=>{if(!this._brokerCurrent())return [];const benchmark=this.cache.benchmarks['NSE:'+name];if(!benchmark?.quote||type==='history'&&benchmark.history?.instrument_token!==benchmark.quote.raw.instrument_token)return [];const item=benchmark[type];return (item?.bars||[]).filter(row=>type==='intraday'?+parseTime(row.time)+300000<=+at&&dateIST(parseTime(row.time))===dateIST(at):dateIST(parseTime(row.time))<dateIST(at)).map(row=>({...row,time:parseTime(row.time)}));};
    const benchmark_bars=barsFor('NIFTY 50','intraday'),sector_bars=sector?barsFor(sector,'intraday'):[];
    const complete=bars=>bars.length>0&&+at-(+bars.at(-1).time+300000)<300000;
    return {...info,as_of:isoIST(at),benchmark:'NIFTY 50',sector_index:sector,benchmark_bars,sector_bars,
      benchmark_daily_bars:barsFor('NIFTY 50','history'),sector_daily_bars:sector?barsFor(sector,'history'):[],
      benchmark_intraday_status:complete(benchmark_bars)?'fresh':'unavailable',sector_intraday_status:complete(sector_bars)?'fresh':'unavailable',
      membership_as_of:'Current verified membership only; historical membership is not reconstructed.'};
  }
  snapshot(){
    this._lookups();
    const now=this.now(),opts=this._options(),sources=this.indexSources.map(source=>{const cached=this.cache.indexes[source.id];return {id:source.id,index:source.name,source:source.url,status:cached?(age(now,cached.observed_at)<=opts.classification_age?'fresh':'stale'):'unavailable',observed_at:cached?.observed_at||null,symbol_count:cached?.records.length||0,excluded:cached?.excluded||[],last_error:this.cache.attempts['index:'+source.id]?.error||null};});
    const classified=this.universe.filter(symbol=>new Set((this.classifications.get(symbol)||[]).filter(row=>age(now,row.cache.observed_at)<=opts.classification_age).map(row=>row.record.industry)).size===1).length;
    const benchmarks=this.benchmarks.map(benchmark=>{
      const item=this.cache.benchmarks[benchmark.key]||{},quote=item.quote,bars=item.history?.bars||[],last=bars.at(-1),historyFresh=!!last&&age(now,item.history.observed_at)<=DAY&&+now-parseTime(last.time)<=7*DAY;
      const quoteFresh=this._brokerCurrent()&&!!quote&&age(now,quote.observed_at)<=opts.benchmark_age&&age(now,quote.exchange_at)<=opts.benchmark_age&&!item.quote_error;
      const closes=bars.map(row=>row.close),sma20=closes.length>=20?mean(closes.slice(-20)):null,sma50=closes.length>=50?mean(closes.slice(-50)):null;
      return {name:benchmark.name,key:benchmark.key,quote_status:quoteFresh?'fresh':quote?'stale':'unavailable',history_status:historyFresh?'fresh':last?'stale':'unavailable',
        observed_at:quote?.observed_at||null,exchange_at:quote?.exchange_at||null,price:quote?.price??null,change_from_open:quote?.change_from_open??null,change_from_previous_close:quote?.change_from_previous_close??null,
        history_observed_at:item.history?.observed_at||null,last_completed_day:last?dateIST(parseTime(last.time)):null,bar_count:bars.length,sma20,sma50,
        intraday_observed_at:item.intraday?.observed_at||null,intraday_bar_count:item.intraday?.bars.length||0,
        return_20_sessions:closes.length>=21?closes.at(-1)/closes.at(-21)-1:null,
        trend:!historyFresh||sma50===null?'unknown':last.close>sma20&&sma20>sma50?'uptrend':last.close<sma20&&sma20<sma50?'downtrend':'mixed',
        last_error:item.quote_error||this.cache.attempts['history:'+benchmark.key]?.error||this.cache.attempts['benchmark:quotes']?.error||null};
    });
    const today=+isoDayAt(dateIST(now)),blackouts=[];
    for(const [symbol,events] of this.eventsBySymbol){if(!this.symbols.has(symbol))continue;const matching=events.filter(event=>{const days=(+isoDayAt(event.date)-today)/DAY;return days>=-opts.after&&days<=opts.before;});if(matching.length)blackouts.push({symbol,dates:[...new Set(matching.map(e=>e.date))].sort(),kinds:[...new Set(matching.map(e=>e.kind))]});}
    blackouts.sort((a,b)=>a.symbol.localeCompare(b.symbol));
    const calendar=this._eventState(),available=sources.some(source=>source.status==='fresh')||calendar.status==='fresh'||benchmarks.some(b=>b.quote_status==='fresh');return {status:this.closed?'closed':this.pending?'refreshing':this.last_error?'degraded':!available?'unavailable':calendar.status==='fresh'&&sources.every(source=>source.status==='fresh')?'ready':'partial',observed_at:isoIST(now),last_error:this.last_error||null,
      classification:{covered_symbols:classified,universe_symbols:this.universe.length,coverage:this.universe.length?classified/this.universe.length:null,sources,
        message:'Industry and membership apply only to the downloaded current index constituents. Other NSE symbols remain unknown; no historic membership is inferred.'},
      calendar:{...calendar,risk_filter_enabled:opts.event_risk_enabled,blackout_before_days:opts.before,blackout_after_days:opts.after,blackout_count:blackouts.length,blackout_symbols:blackouts.slice(0,100),
        message:'Announced board meetings and financial-result events only; missing or stale coverage blocks event-sensitive entries. Dates have no guaranteed intraday time.'},benchmarks};
  }
  async close(){this.closed=true;this.controller.abort();await this.pending;}
}
