import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketContext,INDEX_SOURCES,BENCHMARKS,parseIndexConstituents,parseCorporateEvents,parseNseDate} from '../src/market-context.js';
import {dateIST,parseTime} from '../src/util.js';

const BASE=new Date('2026-09-17T12:10:00+05:30'),DAY=86400000;
const IT=INDEX_SOURCES.find(source=>source.id==='niftyit'),NIFTY=BENCHMARKS.find(item=>item.name==='NIFTY 50'),IT_BENCHMARK=BENCHMARKS.find(item=>item.name==='NIFTY IT');
class MemoryStore{
  constructor(saved){this.values=new Map(saved||[]);this.events=[];}
  get(key,fallback=null){return this.values.has(key)?structuredClone(this.values.get(key)):fallback;}
  set(key,value){assert.doesNotThrow(()=>JSON.stringify(value));this.values.set(key,structuredClone(value));}
  event(...args){this.events.push(args);}
}
function csv(industry='Information Technology'){
  return 'Company Name,Industry,Symbol,Series,ISIN Code\n'+['INFY','TCS','HCLTECH','WIPRO','TECHM','LTIM','PERSISTENT'].map((symbol,index)=>`${symbol} Limited,${industry},${symbol},EQ,INE000A0${String(index).padStart(4,'0')}`).join('\n');
}
function response(body,type='application/json',status=200){return new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':type}});}
function dayBars(){return Array.from({length:65},(_,i)=>({date:new Date(+BASE-(65-i)*DAY),open:100+i,high:102+i,low:99+i,close:101+i,volume:0}));}
function intraday(){return Array.from({length:36},(_,i)=>({date:new Date(+parseTime('2026-09-17T09:15:00+05:30')+i*300000),open:100+i,high:102+i,low:99+i,close:101+i,volume:0}));}
function fixture({settings={},indexes=[IT],benchmarks=[],events={},fetchOverride,brokerOverride,store=new MemoryStore(),timeout_ms=1000}={}){
  let now=new Date(BASE);const requests=[],brokerCalls=[];
  const engine={connected:benchmarks.length>0,universe:{1:{tradingsymbol:'INFY'},2:{tradingsymbol:'UNKNOWN'}}};
  const broker={async call(method,...args){brokerCalls.push({method,args});if(brokerOverride)return brokerOverride(method,...args);
    if(method==='quote')return Object.fromEntries(args[0].map((key,i)=>[key,{instrument_token:100+i,last_price:165,ohlc:{open:160,close:164},timestamp:new Date(now)}]));
    if(method==='historical_data')return args[3]==='day'?dayBars():intraday();
    throw new Error('Market context attempted a broker mutation');
  }};if(engine.connected)engine.broker=broker;
  const fetch=async(url,options)=>{requests.push({url,options});if(fetchOverride)return fetchOverride(url,options);
    if(url===IT.url)return response(csv(),'application/octet-stream');
    if(url.includes('/api/corporate-board-meetings'))return response(events.board||[]);
    if(url.includes('/api/event-calendar'))return response(events.calendar||[]);
    throw new Error('Unexpected public endpoint '+url);
  };
  const service=new MarketContext(store,settings,{fetch,now:()=>now,indexSources:indexes,benchmarks,timeout_ms});
  return {service,engine,store,requests,brokerCalls,broker,advance(ms){now=new Date(+now+ms);},now:()=>now};
}
const board=(symbol='INFY',date='18-Sep-2026',extra={})=>({bm_symbol:symbol,bm_date:date,bm_purpose:'Board Meeting Intimation',bm_desc:'To consider and approve quarterly financial results.',bm_timestamp:'15-Sep-2026 18:30:00',...extra});
const calendar=(symbol='INFY',date='18-Sep-2026')=>({symbol,date,purpose:'Financial Results',bm_desc:'Quarterly results.'});

test('official CSV parser handles quoted names and rejects malformed, duplicate or unclassified constituents',()=>{
  const rows=parseIndexConstituents(csv().replace('INFY Limited','"Infosys, Limited"'));assert.equal(rows[0].name,'Infosys, Limited');assert.equal(rows.length,7);
  for(const bad of ['<html>Blocked</html>',csv().replace('Industry','Sector'),csv()+'\n'+csv().split('\n')[1],csv().replace('Information Technology','-'),csv().replace('INE000A00000','invalid'),csv().replace('INFY,EQ','INFY,XX')])assert.throws(()=>parseIndexConstituents(bad));
});

test('official BE constituents are classified while explicit corporate-action dummy rows are reported and excluded',()=>{
  const source=csv().replace('INFY,EQ','INFY,BE')+'\nDummy HEG Ltd.,Metals & Mining,DUMMYHEG,EQ,DUM545A01024';
  const parsed=parseIndexConstituents(source,{withMetadata:true});assert.equal(parsed.records.length,7);assert.equal(parsed.total_rows,8);assert.equal(parsed.records[0].series,'BE');
  assert.deepEqual(parsed.excluded,[{symbol:'DUMMYHEG',reason:'index_corporate_action_placeholder'}]);
  assert.throws(()=>parseIndexConstituents(source.replace('Dummy HEG Ltd.','HEG Ltd.')));
  for(const isin of ['DU1560A01023','DU2560A01023']){
    const parsed=parseIndexConstituents(csv()+`\nDummy Inox Ltd.,Industrials,DUMMYINGL1,EQ,${isin}`,{withMetadata:true});
    assert.equal(parsed.records.length,7);assert.equal(parsed.excluded.length,1);
    assert.throws(()=>parseIndexConstituents(csv().replace('INE000A00000',isin)),'Invalid real-stock ISIN still fails');
  }
});

test('Total Market membership validates coverage, survives restart and becomes stale without a sector benchmark',async()=>{
  const source=INDEX_SOURCES.find(item=>item.id==='niftytotalmarket');
  assert.equal(source.url,'https://www.niftyindices.com/IndexConstituent/ind_niftytotalmarket_list.csv');
  assert.ok(!BENCHMARKS.some(item=>item.name===source.name));
  const body='Company Name,Industry,Symbol,Series,ISIN Code\n'+Array.from({length:750},(_,i)=>`Stock ${i},Industry ${i%15},STOCK${i},EQ,INE000A0${String(i).padStart(4,'0')}`).join('\n');
  let truncated=false;
  const f=fixture({indexes:[source],fetchOverride:url=>url===source.url?response(truncated?csv():body,'text/csv'):response([])});
  assert.equal(f.service.researchConstituents().status,'unavailable');await f.service.refresh(f.engine);
  const membership=f.service.researchConstituents();assert.equal(membership.records.length,750);assert.equal(membership.status,'fresh');
  assert.equal(f.service.contextForSymbol('STOCK0').sector_index,null,'Broad index cannot stand in for a sector');
  membership.records.pop();assert.equal(f.service.researchConstituents().records.length,750);
  truncated=true;f.advance(DAY);await f.service.refresh(f.engine);
  assert.equal(f.service.researchConstituents().observed_at,membership.observed_at);
  assert.equal(f.service.snapshot().classification.sources[0].last_error,'constituent_coverage_incomplete');
  await f.service.close();
  const restored=fixture({indexes:[source],store:f.store});assert.equal(restored.service.researchConstituents().records.length,750);
  restored.advance(8*DAY);assert.equal(restored.service.researchConstituents().status,'stale');await restored.service.close();
});

test('calendar date and row validation rejects rollover dates, out-of-window data and unexpected wrappers',()=>{
  assert.equal(parseNseDate('17-Sep-2026'),'2026-09-17');assert.equal(parseNseDate('2026-09-17'),'2026-09-17');
  for(const invalid of ['31-Feb-2026','17-Foo-2026','2026-13-01','09/17/2026',null])assert.equal(parseNseDate(invalid),null);
  const options={source:'board',from:'2026-09-01',to:'2026-09-30'},parsed=parseCorporateEvents([board(),board()],options);
  assert.equal(parsed.length,1);assert.equal(parsed[0].kind,'financial_results');assert.equal(parsed[0].announced_at,'2026-09-15T18:30:00+05:30');
  for(const invalid of [{data:[]},[board('INFY','01-Oct-2026')],[{...board(),bm_date:'wrong'}],[{...board(),bm_symbol:'<script>'}],[{...board(),bm_purpose:''}]])assert.throws(()=>parseCorporateEvents(invalid,options));
});

test('fresh official classifications have measured coverage; unclassified symbols are never assigned an invented sector',async()=>{
  const f=fixture();const state=await f.service.refresh(f.engine);
  assert.equal(state.classification.covered_symbols,1);assert.equal(state.classification.universe_symbols,2);assert.equal(state.classification.coverage,.5);
  const info=f.service.forSymbol('INFY');assert.equal(info.industry,'Information Technology');assert.equal(info.classification_status,'fresh');assert.equal(info.index_membership[0].index,'NIFTY IT');
  assert.equal(f.service.forSymbol('UNKNOWN').sector,null);assert.equal(f.service.forSymbol('UNKNOWN').classification_status,'unknown');
  assert.equal(f.requests.length,3);assert.ok(f.requests.every(request=>request.options.redirect==='error'&&request.options.signal));await f.service.close();
});

test('both announced-event feeds create calendar-day blackout without submitting any account operation',async()=>{
  const f=fixture({events:{board:[board()],calendar:[calendar()]}});await f.service.refresh(f.engine);const info=f.service.forSymbol('INFY');
  assert.equal(info.blackout,true);assert.equal(info.entry_blocked,true);assert.equal(info.reason,'announced_corporate_event_blackout');assert.equal(info.event_status,'blackout');
  assert.equal(info.events.length,1);assert.deepEqual(info.events[0].sources,['board','calendar']);assert.equal(info.events[0].days_from_today,1);assert.equal(f.brokerCalls.length,0);
  const unknown=f.service.forSymbol('NOTINUNIVERSE');assert.equal(unknown.event_status,'symbol_unverified');assert.equal(unknown.entry_blocked,true);await f.service.close();
});

test('valid empty feeds mean no announced event, not a promise of no event; disabling the filter preserves status',async()=>{
  const f=fixture();await f.service.refresh(f.engine);const info=f.service.forSymbol('INFY');assert.equal(info.event_status,'no_announced_event');assert.equal(info.entry_blocked,false);assert.match(info.message,/does not exclude unannounced/);
  f.advance(61*60000);assert.equal(f.service.forSymbol('INFY').entry_blocked,true);assert.equal(f.service.forSymbol('INFY').event_status,'stale');
  f.service.settings.event_risk_enabled=false;assert.equal(f.service.forSymbol('INFY').entry_blocked,false);assert.equal(f.service.forSymbol('INFY').event_status,'stale');await f.service.close();
});

test('partial event coverage, access-denied HTML and unavailable feeds remain blocked with bounded backoff',async()=>{
  const f=fixture({fetchOverride:url=>url===IT.url?response(csv(),'text/csv'):url.includes('event-calendar')?response('<html>access denied</html>','text/html',403):response([])});
  await f.service.refresh(f.engine);const state=f.service.snapshot();assert.equal(state.calendar.status,'partial');assert.equal(f.service.forSymbol('INFY').entry_blocked,true);
  assert.equal(state.calendar.sources.find(source=>source.id==='calendar').last_error,'http_403');const count=f.requests.length;
  await f.service.refresh(f.engine,{force:true});assert.equal(f.requests.filter(r=>r.url.includes('event-calendar')).length,1);
  assert.ok(f.requests.length>count);f.advance(60001);await f.service.refresh(f.engine);assert.equal(f.requests.filter(r=>r.url.includes('event-calendar')).length,2);
  assert.equal(f.store.events.filter(event=>event[0]==='market_context.unavailable').length,1);await f.service.close();
});

test('last verified cache survives a failed refresh without its observed timestamp being advanced',async()=>{
  let bad=false;const f=fixture({fetchOverride:url=>url===IT.url?(bad?response('bad csv','text/csv'):response(csv(),'text/csv')):response([])});
  await f.service.refresh(f.engine);const observed=f.service.forSymbol('INFY').classification_observed_at;bad=true;f.advance(DAY);await f.service.refresh(f.engine);
  assert.equal(f.service.forSymbol('INFY').classification_observed_at,observed);assert.equal(f.service.forSymbol('INFY').classification_status,'fresh');
  f.advance(7*DAY);assert.equal(f.service.forSymbol('INFY').classification_status,'stale');assert.equal(f.service.forSymbol('INFY').sector,null);await f.service.close();
});

test('offline restart reloads verified public cache and preserves announcement timestamps',async()=>{
  const f=fixture({events:{board:[board()],calendar:[calendar()]}});await f.service.refresh(f.engine);await f.service.close();
  const second=fixture({store:f.store,fetchOverride(){throw new Error('Offline');}});await second.service.refresh(second.engine);
  assert.equal(second.requests.length,0);assert.equal(second.service.forSymbol('INFY').classification_status,'fresh');assert.equal(second.service.forSymbol('INFY').blackout,true);
  assert.equal(second.service.forSymbol('INFY').events[0].announced_at,'2026-09-15T18:30:00+05:30');await second.service.close();
});

test('truncated Nifty500 CSV is rejected instead of relabelled as complete source coverage',async()=>{
  const source=INDEX_SOURCES.find(item=>item.id==='nifty500'),f=fixture({indexes:[source],fetchOverride:url=>url===source.url?response(csv(),'text/csv'):response([])});
  const state=await f.service.refresh(f.engine);assert.equal(state.classification.sources[0].status,'unavailable');assert.equal(state.classification.sources[0].last_error,'constituent_coverage_incomplete');assert.equal(state.classification.covered_symbols,0);await f.service.close();
});

test('oversized and non-JSON responses cannot become verified calendar data',async()=>{
  const f=fixture({fetchOverride:url=>url===IT.url?response(csv(),'text/csv'):response('x'.repeat(1200),'application/json')});f.service.max_response_bytes=1000;
  const state=await f.service.refresh(f.engine);assert.equal(state.calendar.status,'unavailable');assert.ok(state.calendar.sources.every(source=>source.last_error==='response_too_large'));await f.service.close();
});

test('timeouts terminate refresh and never create an unbounded request retry loop',async()=>{
  const f=fixture({indexes:[],timeout_ms:20,fetchOverride:()=>new Promise(()=>{})});const started=Date.now();await f.service.refresh(f.engine);
  assert.ok(Date.now()-started<1000);assert.equal(f.requests.length,2);assert.equal(f.service.forSymbol('INFY').entry_blocked,true);
  await f.service.refresh(f.engine);assert.equal(f.requests.length,2);await f.service.close();
});

test('concurrent refreshes are single-flight and close aborts in-flight collection promptly',async()=>{
  const f=fixture({indexes:[],timeout_ms:5000,fetchOverride:()=>new Promise(()=>{})}),first=f.service.refresh(f.engine),second=f.service.refresh(f.engine);
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.requests.length,1);const start=Date.now();await f.service.close();await Promise.all([first,second]);assert.ok(Date.now()-start<1000);assert.equal(f.requests.length,1);assert.equal(f.service.snapshot().status,'closed');
});

test('benchmark context uses only quote/history reads, completed bars and daily data ending before today',async()=>{
  const f=fixture({benchmarks:[NIFTY,IT_BENCHMARK]});const state=await f.service.refresh(f.engine),benchmark=state.benchmarks[0];
  assert.equal(benchmark.quote_status,'fresh');assert.equal(benchmark.history_status,'fresh');assert.equal(benchmark.trend,'uptrend');assert.equal(benchmark.bar_count,65);assert.equal(benchmark.intraday_bar_count,35);
  assert.ok(f.brokerCalls.every(call=>['quote','historical_data'].includes(call.method)));assert.equal(f.brokerCalls.filter(call=>call.method==='quote').length,1);
  for(const call of f.brokerCalls.filter(call=>call.method==='historical_data'&&call.args[3]==='day'))assert.ok(call.args[2]<parseTime('2026-09-17T00:00:00+05:30'));
  const info=f.service.contextForSymbol('INFY',new Date('2026-09-17T12:00:00+05:30'));
  assert.equal(info.sector_index,'NIFTY IT');assert.equal(info.benchmark_bars.length,33);assert.equal(info.sector_bars.length,33);assert.ok(info.benchmark_bars.every(bar=>bar.time instanceof Date&&+bar.time+300000<=+parseTime('2026-09-17T12:00:00+05:30')));
  assert.ok(info.benchmark_daily_bars.every(bar=>dateIST(bar.time)<'2026-09-17'));assert.equal(info.benchmark_intraday_status,'fresh');assert.equal(f.service.contextForSymbol('UNKNOWN').sector_bars.length,0);
  await f.service.refresh(f.engine);assert.equal(f.brokerCalls.length,5);await f.service.close();
});

test('stale exchange timestamps never become fresh because a quote response just arrived',async()=>{
  const f=fixture({benchmarks:[NIFTY],brokerOverride:(method,...args)=>method==='quote'?{'NSE:NIFTY 50':{instrument_token:100,last_price:165,ohlc:{open:160,close:164},timestamp:new Date(+BASE-600000)}}:args[3]==='day'?dayBars():intraday()});
  await f.service.refresh(f.engine);assert.equal(f.service.snapshot().benchmarks[0].quote_status,'stale');await f.service.close();
});

test('missing benchmark keys and noncontiguous intraday history remain explicitly unavailable',async()=>{
  const f=fixture({benchmarks:[NIFTY,IT_BENCHMARK],brokerOverride:(method,...args)=>method==='quote'?{'NSE:NIFTY 50':{instrument_token:100,last_price:165,ohlc:{open:160,close:164},timestamp:BASE}}:args[3]==='day'?dayBars():intraday().filter((_,i)=>i!==2)});
  await f.service.refresh(f.engine);const state=f.service.snapshot();assert.equal(state.benchmarks[1].quote_status,'unavailable');assert.equal(f.service.contextForSymbol('INFY').benchmark_intraday_status,'unavailable');await f.service.close();
});

test('reconnect invalidates former-session executable context and discards old in-flight broker results',async()=>{
  const f=fixture({benchmarks:[NIFTY]});await f.service.refresh(f.engine);assert.ok(f.service.contextForSymbol('INFY').benchmark_bars.length);
  let finish;f.advance(60000);f.engine.broker={call:()=>new Promise(resolve=>{finish=resolve;})};const pending=f.service.refresh(f.engine);
  await new Promise(resolve=>setTimeout(resolve,1));assert.equal(f.service.contextForSymbol('INFY').benchmark_bars.length,0);
  const currentBroker={async call(method,...args){return method==='quote'?{'NSE:NIFTY 50':{instrument_token:200,last_price:170,ohlc:{open:160,close:164},timestamp:f.now()}}:args[3]==='day'?dayBars():intraday();}};
  f.engine.broker=currentBroker;finish({'NSE:NIFTY 50':{instrument_token:999,last_price:999,ohlc:{open:990,close:995},timestamp:f.now()}});await pending;
  assert.notEqual(f.service.snapshot().benchmarks[0].price,999);assert.equal(f.service.contextForSymbol('INFY').benchmark_bars.length,0);
  await f.service.refresh(f.engine);assert.equal(f.service.snapshot().benchmarks[0].price,170);assert.ok(f.service.contextForSymbol('INFY').benchmark_bars.length);await f.service.close();
});

test('cached broker context cannot be used after restart before the current session refresh confirms it',async()=>{
  const f=fixture({benchmarks:[NIFTY]});await f.service.refresh(f.engine);await f.service.close();
  const second=fixture({store:f.store,benchmarks:[NIFTY]});assert.notEqual(second.service.snapshot().benchmarks[0].quote_status,'fresh');assert.equal(second.service.contextForSymbol('INFY').benchmark_bars.length,0);
  await second.service.refresh(second.engine);assert.equal(second.service.snapshot().benchmarks[0].quote_status,'fresh');assert.ok(second.service.contextForSymbol('INFY').benchmark_bars.length);await second.service.close();
});
