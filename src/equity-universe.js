/** NSE's equity and ETF directories classify the cash universe. Kite instrument
 * type EQ alone also includes bonds and is not the exchange's trading series.
 * Source links: https://www.nseindia.com/static/market-data/securities-available-for-trading
 */
import {dateIST,isoIST,parseTime} from './util.js';

export const EQUITY_CACHE_KEY='nse_equity_directory_v1';
export const EQUITY_SOURCES=Object.freeze([
  Object.freeze({id:'equities',url:'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv'}),
  Object.freeze({id:'etfs',url:'https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv'}),
]);
const VERSION=1,MAX_BYTES=2_000_000,MAX_ROWS=20_000,MAX_MASTER=200_000,TIMEOUT_MS=10_000;
const MINIMUM_ROWS=Object.freeze({equities:1000,etfs:50});
const SYMBOL=/^[A-Z0-9][A-Z0-9&._-]{0,79}$/,ISIN=/^IN[A-Z0-9]{10}$/;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw Object.assign(new Error('NSE equity directory: '+code),{code});};
const COLUMNS={
  equities:['symbol','nameofcompany','series','dateoflisting','paidupvalue','marketlot','isinnumber','facevalue'],
  etfs:['symbol','underlyingasset','securityname','dateoflisting','marketlot','isinnumber','facevalue','etfunderlying','underlyingkey'],
};

function csvRows(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))fail('invalid_csv_size_or_encoding');
  text=text.replace(/^\uFEFF/,'');
  const rows=[];let row=[],field='',state='start';
  const cell=()=>{row.push(field);field='';state='start';if(row.length>12)fail('invalid_csv_columns');};
  const line=()=>{cell();if(row.some(value=>value.trim()))rows.push(row);row=[];if(rows.length>MAX_ROWS+1)fail('too_many_directory_rows');};
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(state==='quoted'){
      if(char==='"'){if(text[i+1]==='"'){field+='"';i++;}else state='closed';}
      else field+=char;
    }else if(char===',')cell();
    else if(char==='\r'||char==='\n'){line();if(char==='\r'&&text[i+1]==='\n')i++;}
    else if(state==='closed'){if(char!==' '&&char!=='\t')fail('invalid_csv_quote');}
    else if(char==='"'){if(state!=='start')fail('invalid_csv_quote');state='quoted';}
    else{field+=char;state='unquoted';}
    if(field.length>2048)fail('directory_field_too_long');
  }
  if(state==='quoted')fail('invalid_csv_quote');
  if(row.length||field||state==='closed')line();
  return rows;
}

function validRecord(record,kind){
  return object(record)&&Object.keys(record).length===4&&SYMBOL.test(record.symbol)&&typeof record.symbol==='string'
    &&typeof record.name==='string'&&record.name.length>0&&record.name.length<=512&&record.name===record.name.trim()
    &&typeof record.isin==='string'&&ISIN.test(record.isin)
    &&(kind==='equities'?typeof record.series==='string'&&/^[A-Z0-9]{1,3}$/.test(record.series):record.series===null);
}

export function parseEquityDirectory(text,kind){
  if(!Object.hasOwn(COLUMNS,kind))fail('invalid_directory_kind');
  const rows=csvRows(text),columns=(rows.shift()||[]).map(value=>value.trim().toLowerCase().replace(/\s/g,''));
  if(columns.length!==COLUMNS[kind].length||new Set(columns).size!==columns.length||COLUMNS[kind].some(column=>!columns.includes(column))||!rows.length)fail('invalid_directory_schema');
  const seen=new Set();
  return rows.map(values=>{
    if(values.length!==columns.length)fail('invalid_directory_row');
    const row=Object.fromEntries(columns.map((column,index)=>[column,values[index].trim()]));
    const record={symbol:row.symbol,name:row[kind==='equities'?'nameofcompany':'securityname'],series:kind==='equities'?row.series:null,isin:row.isinnumber};
    if(!validRecord(record,kind)||!/^\d+$/.test(row.marketlot)||!Number.isSafeInteger(Number(row.marketlot))||Number(row.marketlot)<1)fail('invalid_directory_row');
    if(seen.has(record.symbol))fail('duplicate_directory_symbol');seen.add(record.symbol);
    return record;
  });
}

function verifiedCache(value,now,minimumRows){
  try{
    if(!object(value)||value.version!==VERSION||value.date!==dateIST(now)||!object(value.sources))return null;
    if(Buffer.byteLength(JSON.stringify(value))>MAX_BYTES*2)return null;
    const observed=parseTime(value.observed_at);
    if(!observed||observed>now||dateIST(observed)!==value.date)return null;
    const symbols=new Set(),sources={};
    for(const source of EQUITY_SOURCES){
      const item=value.sources[source.id];
      if(!object(item)||item.url!==source.url||!Array.isArray(item.records)||item.records.length<minimumRows[source.id]||item.records.length>MAX_ROWS||item.row_count!==item.records.length)return null;
      for(const row of item.records){if(!validRecord(row,source.id)||symbols.has(row.symbol))return null;symbols.add(row.symbol);}
      sources[source.id]={url:source.url,row_count:item.records.length,records:structuredClone(item.records)};
    }
    return {version:VERSION,date:value.date,observed_at:value.observed_at,sources};
  }catch{return null;}
}

function brokerMaster(instruments){
  if(!Array.isArray(instruments)||instruments.length>MAX_MASTER)fail('invalid_broker_master');
  const byToken=new Map(),bySymbol=new Map(),rows=[];let duplicates=0,other=0;
  for(const item of instruments){
    if(!object(item))fail('invalid_broker_instrument');
    if(item.exchange!=='NSE'||item.segment!=='NSE'){other++;continue;}
    if(!Number.isSafeInteger(item.instrument_token)||item.instrument_token<=0||typeof item.tradingsymbol!=='string'||!SYMBOL.test(item.tradingsymbol)
      ||typeof item.instrument_type!=='string'||!item.instrument_type
      ||item.tick_size!==undefined&&(!Number.isFinite(item.tick_size)||item.tick_size<=0)
      ||item.lot_size!==undefined&&(!Number.isSafeInteger(item.lot_size)||item.lot_size<1))fail('invalid_broker_instrument');
    const signature=JSON.stringify([item.instrument_token,item.tradingsymbol,item.instrument_type,item.tick_size??null,item.lot_size??null]);
    if(byToken.has(item.instrument_token)||bySymbol.has(item.tradingsymbol)){
      if(byToken.get(item.instrument_token)!==signature||bySymbol.get(item.tradingsymbol)!==signature)fail('conflicting_broker_instrument');
      duplicates++;continue;
    }
    byToken.set(item.instrument_token,signature);bySymbol.set(item.tradingsymbol,signature);rows.push(item);
  }
  return {rows,duplicates,other};
}

export class EquityUniverse{
  constructor(store,{fetch=globalThis.fetch,now=()=>new Date(),minimumRows=MINIMUM_ROWS}={}){
    // Test injection only; production configuration never exposes these floors.
    if(!object(minimumRows)||Object.keys(minimumRows).length!==2||EQUITY_SOURCES.some(source=>!Number.isSafeInteger(minimumRows[source.id])||minimumRows[source.id]<1||minimumRows[source.id]>MAX_ROWS))fail('invalid_directory_minimums');
    this.store=store;this.fetch=fetch;this.now=now;this.minimumRows=Object.freeze({...minimumRows});this.cache=null;this.pending=null;
  }
  async _download(source){
    const controller=new AbortController();let reader,timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('NSE directory timed out'),{code:'request_timeout'}));},TIMEOUT_MS);});
    try{return await Promise.race([timeout,(async()=>{
      const response=await this.fetch(source.url,{signal:controller.signal,redirect:'error',headers:{Accept:'text/csv, text/plain, application/octet-stream'}});
      if(!response?.ok)fail('http_error');
      if(response.redirected||response.url&&response.url!==source.url)fail('unexpected_source_redirect');
      const contentType=response.headers?.get('content-type')||'';
      if(!/^(?:text\/(?:csv|plain)|application\/(?:octet-stream|vnd\.ms-excel))(?:\s*;|$)/i.test(contentType))fail('invalid_content_type');
      const length=response.headers?.get('content-length');
      if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))fail('response_too_large');
      reader=response.body?.getReader?.();if(!reader)fail('invalid_response_body');
      const chunks=[];let bytes=0;
      for(;;){const result=await reader.read();if(result.done)break;bytes+=result.value.byteLength;if(bytes>MAX_BYTES)fail('response_too_large');chunks.push(result.value);}
      let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes));}catch{fail('invalid_csv_size_or_encoding');}
      const records=parseEquityDirectory(text,source.id);
      if(records.length<this.minimumRows[source.id])fail('incomplete_directory');
      return records;
    })()]);}finally{clearTimeout(timer);controller.abort();try{Promise.resolve(reader?.cancel()).catch(()=>{});}catch{}}
  }
  async _directory(){
    const now=this.now();if(!(now instanceof Date)||!Number.isFinite(+now))fail('invalid_current_time');
    let candidate=this.cache;try{candidate??=this.store?.get(EQUITY_CACHE_KEY,null);}catch{}
    const cached=verifiedCache(candidate,now,this.minimumRows);if(cached){this.cache=cached;return {cache:cached,cache_used:true,errors:[]};}
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      const results=await Promise.allSettled(EQUITY_SOURCES.map(source=>this._download(source)));
      const errors=results.flatMap((result,index)=>result.status==='rejected'?[{source:EQUITY_SOURCES[index].id,code:/^(?:http_error|unexpected_source_redirect|invalid_content_type|response_too_large|invalid_response_body|invalid_csv_size_or_encoding|invalid_csv_columns|too_many_directory_rows|invalid_csv_quote|directory_field_too_long|invalid_directory_schema|invalid_directory_row|duplicate_directory_symbol|incomplete_directory|request_timeout)$/.test(result.reason?.code||'')?result.reason.code:'request_failed'}]:[]);
      if(errors.length)return {cache:null,cache_used:false,errors};
      const observed=this.now(),value={version:VERSION,date:dateIST(observed),observed_at:isoIST(observed),sources:Object.fromEntries(EQUITY_SOURCES.map((source,index)=>[source.id,{url:source.url,row_count:results[index].value.length,records:results[index].value}]))};
      const verified=verifiedCache(value,observed,this.minimumRows);
      if(!verified)return {cache:null,cache_used:false,errors:[{source:'combined',code:'conflicting_directory_symbols'}]};
      this.store?.set(EQUITY_CACHE_KEY,verified);this.cache=verified;
      return {cache:verified,cache_used:false,errors:[]};
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
  async resolve(instruments,{managedSymbols=[]}={}){
    const master=brokerMaster(instruments);
    if(!Array.isArray(managedSymbols)||managedSymbols.length>MAX_MASTER||managedSymbols.some(symbol=>typeof symbol!=='string'||!SYMBOL.test(symbol)))fail('invalid_managed_symbols');
    const managed=new Set(managedSymbols),directory=await this._directory(),lookup=new Map();
    if(directory.cache)for(const source of EQUITY_SOURCES)for(const record of directory.cache.sources[source.id].records)lookup.set(record.symbol,{...record,security_kind:source.id==='etfs'?'etf':'equity'});
    const eligible=new Set([...lookup.values()].filter(row=>row.security_kind==='etf'||row.series==='EQ').map(row=>row.symbol));
    const selected=[],matched=new Set(),managedFound=new Set(),excluded={other_exchange_or_segment:master.other,duplicate_broker_rows:master.duplicates,not_in_verified_directory:0,non_eq_series:0,non_eq_instrument_type:0};
    let equities=0,etfs=0,recovery=0;
    for(const item of master.rows){
      const record=lookup.get(item.tradingsymbol),entry=eligible.has(item.tradingsymbol)&&item.instrument_type==='EQ';
      if(entry||managed.has(item.tradingsymbol)){
        selected.push({...item,entry_eligible:entry,security_kind:record?.security_kind||'managed_other',equity_series:record?.series??null,recovery_only:!entry});
        if(managed.has(item.tradingsymbol))managedFound.add(item.tradingsymbol);
        if(entry){matched.add(item.tradingsymbol);if(record.security_kind==='etf')etfs++;else equities++;}else recovery++;
      }else if(!record)excluded.not_in_verified_directory++;
      else if(!eligible.has(item.tradingsymbol))excluded.non_eq_series++;
      else excluded.non_eq_instrument_type++;
    }
    selected.sort((a,b)=>a.tradingsymbol<b.tradingsymbol?-1:a.tradingsymbol>b.tradingsymbol?1:0);
    const missing=[...eligible].filter(symbol=>!matched.has(symbol)).sort(),missingManaged=[...managed].filter(symbol=>!managedFound.has(symbol)).sort();
    return {instruments:selected,summary:{status:directory.cache?'verified':'unavailable',date:directory.cache?.date||dateIST(this.now()),observed_at:directory.cache?.observed_at||null,cache_used:directory.cache_used,
      broker_instrument_count:instruments.length,broker_nse_cash_count:master.rows.length,broker_eq_type_count:master.rows.filter(row=>row.instrument_type==='EQ').length,
      included_count:selected.length,entry_eligible_count:equities+etfs,equity_count:equities,etf_count:etfs,managed_only_count:recovery,excluded_count:instruments.length-selected.length,excluded_counts:excluded,
      directory_candidate_count:eligible.size,sources:EQUITY_SOURCES.map(source=>({...source,status:directory.cache?'verified':'unavailable',row_count:directory.cache?.sources[source.id].row_count||0})),
      missing_matches:{directory_count:missing.length,directory_symbols:missing.slice(0,100),managed_count:missingManaged.length,managed_symbols:missingManaged.slice(0,100)},errors:directory.errors,
      scope:'Current official NSE EQ-series equities and listed ETFs matched exactly to Kite symbols; other explicitly managed NSE instruments are recovery-only. No universe truncation.'}};
  }
}
