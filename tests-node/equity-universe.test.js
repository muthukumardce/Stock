import test from 'node:test';
import assert from 'node:assert/strict';
import {EquityUniverse,EQUITY_SOURCES,EQUITY_CACHE_KEY,parseEquityDirectory} from '../src/equity-universe.js';

const EQUITY_HEADER='SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE';
const ETF_HEADER='Symbol,Underlying Asset,SecurityName,DateofListing,MarketLot,ISINNumber,FaceValue,ETF Underlying,Underlying Key';
const stock=(symbol,series='EQ')=>`${symbol},${symbol} Limited,${series},06-OCT-2008,5,1,INE144J01027,5`;
const etf=symbol=>`${symbol},Nifty 50,${symbol} ETF,08-Jan-02,1,INF204KB14I2,1,EQUITY,Nifty 50`;
const stockCSV=rows=>EQUITY_HEADER+'\r\n'+rows.join('\r\n')+'\r\n';
const etfCSV=rows=>ETF_HEADER+'\r\n'+rows.join('\r\n')+'\r\n';
const instrument=(symbol,token,extra={})=>({tradingsymbol:symbol,instrument_token:token,exchange:'NSE',segment:'NSE',instrument_type:'EQ',tick_size:.05,lot_size:1,...extra});
const response=(body,headers={})=>new Response(body,{headers:{'content-type':'text/csv',...headers}});
class Store{
  constructor(){this.values=new Map();this.writes=0;}
  get(key,fallback=null){return structuredClone(this.values.has(key)?this.values.get(key):fallback);}
  set(key,value){this.writes++;this.values.set(key,structuredClone(value));}
}
function fixture({store=new Store(),fetchOverride,equities=[stock('INFY'),stock('RELIANCE'),stock('BEONLY','BE'),stock('BZONLY','BZ')],etfs=[etf('NIFTYBEES')],now='2026-09-17T12:00:00+05:30',minimumRows={equities:1,etfs:1}}={}){
  let clock=new Date(now);const calls=[];
  const fetch=async(url,options)=>{calls.push({url,options});return fetchOverride?fetchOverride(url,options):response(url===EQUITY_SOURCES[0].url?stockCSV(equities):etfCSV(etfs));};
  return {store,calls,fetch,advance:ms=>{clock=new Date(+clock+ms);},service:new EquityUniverse(store,{fetch,now:()=>new Date(clock),minimumRows})};
}

test('production completeness floors reject schema-valid truncated sources and undersized restored caches',async()=>{
  const f=fixture();await f.service.resolve([instrument('INFY',1)]);const saved=f.store.get(EQUITY_CACHE_KEY),requests=f.calls.length;
  const production=new EquityUniverse(f.store,{fetch:f.fetch,now:()=>new Date('2026-09-17T12:00:00+05:30')});
  const result=await production.resolve([instrument('INFY',1)],{managedSymbols:['INFY']});
  assert.equal(result.summary.status,'unavailable');assert.equal(result.summary.cache_used,false);
  assert.equal(result.instruments[0].entry_eligible,false);assert.equal(f.calls.length,requests+2);
  assert.deepEqual(result.summary.errors,[{source:'equities',code:'incomplete_directory'},{source:'etfs',code:'incomplete_directory'}]);
  assert.deepEqual(f.store.get(EQUITY_CACHE_KEY),saved);assert.equal(f.store.writes,1);
  const complete=fixture({equities:Array.from({length:1000},(_,i)=>stock('STOCK'+i)),etfs:Array.from({length:50},(_,i)=>etf('ETF'+i))});
  const realDefaults=new EquityUniverse(complete.store,{fetch:complete.fetch,now:()=>new Date('2026-09-17T12:00:00+05:30')});
  const accepted=await realDefaults.resolve([instrument('STOCK0',1),instrument('ETF0',2)]);
  assert.equal(accepted.summary.status,'verified');assert.equal(accepted.summary.entry_eligible_count,2);
});

test('official EQ-series shares and ETFs replace a >9000 mostly-bond Kite EQ universe without truncation',async()=>{
  const f=fixture(),bonds=Array.from({length:10000},(_,i)=>instrument('BOND'+i,i+100));
  const master=[instrument('INFY',1),instrument('NIFTYBEES',2),instrument('BEONLY',3),instrument('BZONLY',4),...bonds,
    instrument('NIFTY 50',20000,{segment:'INDICES',instrument_type:'INDEX'}),instrument('INFY',20001,{exchange:'BSE',segment:'BSE'})];
  const result=await f.service.resolve(master);
  assert.deepEqual(result.instruments.map(i=>i.tradingsymbol),['INFY','NIFTYBEES']);
  assert.deepEqual(result.instruments.map(i=>[i.entry_eligible,i.security_kind,i.equity_series]),[[true,'equity','EQ'],[true,'etf',null]]);
  assert.equal(result.summary.status,'verified');assert.equal(result.summary.broker_eq_type_count,10004);
  assert.equal(result.summary.excluded_counts.not_in_verified_directory,10000);assert.equal(result.summary.excluded_counts.non_eq_series,2);
  assert.equal(result.summary.excluded_counts.other_exchange_or_segment,2);assert.equal(result.summary.entry_eligible_count,2);
  assert.deepEqual(result.summary.missing_matches.directory_symbols,['RELIANCE']);
  assert.equal(master[0].entry_eligible,undefined);assert.equal(f.calls.length,2);assert.equal(f.store.writes,1);
  assert.deepEqual(f.calls.map(c=>c.url),EQUITY_SOURCES.map(s=>s.url));
  for(const call of f.calls){assert.equal(call.options.redirect,'error');assert.deepEqual(Object.keys(call.options.headers),['Accept']);}
});

test('the complete verified selection is returned even if it genuinely exceeds the streaming limit',async()=>{
  const equities=Array.from({length:9001},(_,i)=>stock('STOCK'+i)),f=fixture({equities});
  const result=await f.service.resolve([...equities.map((_,i)=>instrument('STOCK'+i,i+1)),instrument('NIFTYBEES',10000)]);
  assert.equal(result.instruments.length,9002);assert.equal(result.summary.entry_eligible_count,9002);
});

test('managed BE/BZ and unlisted broker securities remain recovery-only and cannot become new entries',async()=>{
  const f=fixture(),result=await f.service.resolve([instrument('INFY',1),instrument('BEONLY',2),instrument('BZONLY',3),instrument('OWNEDBOND',4),instrument('IGNORED',5)],
    {managedSymbols:['INFY','BEONLY','BZONLY','OWNEDBOND','MISSINGOWNED']});
  assert.deepEqual(result.instruments.map(i=>[i.tradingsymbol,i.entry_eligible,i.security_kind,i.equity_series]),[
    ['BEONLY',false,'equity','BE'],['BZONLY',false,'equity','BZ'],['INFY',true,'equity','EQ'],['OWNEDBOND',false,'managed_other',null],
  ]);
  assert.equal(result.summary.managed_only_count,3);assert.deepEqual(result.summary.missing_matches.managed_symbols,['MISSINGOWNED']);
  assert(result.instruments.filter(i=>!i.entry_eligible).every(i=>i.recovery_only));
});

test('broker symbol matching is exact, and a directory match cannot turn a non-EQ instrument into an entry',async()=>{
  const f=fixture(),result=await f.service.resolve([instrument('INFY-BE',1),instrument('INFY',2,{instrument_type:'BOND'}),instrument('NIFTYBEES',3)]);
  assert.deepEqual(result.instruments.map(i=>i.tradingsymbol),['NIFTYBEES']);
  assert.equal(result.summary.excluded_counts.non_eq_instrument_type,1);assert.equal(result.summary.excluded_counts.not_in_verified_directory,1);
});

test('CSV accepts verified source headers, quoted names, BOM, blank lines and ETF two-digit listing dates',()=>{
  const equities='\uFEFF'+stockCSV([stock('INFY').replace('INFY Limited','"INFY, ""Company"""')])+'\r\n';
  assert.equal(parseEquityDirectory(equities,'equities')[0].name,'INFY, "Company"');
  const rows=parseEquityDirectory(etfCSV([etf('NIFTYBEES')]).replace('SecurityName',' SecurityName '),'etfs');
  assert.equal(rows[0].series,null);assert.equal(rows[0].symbol,'NIFTYBEES');
});

test('malformed directory rows, HTML, duplicate symbols, quotes and schema changes fail closed',()=>{
  const bad=[
    '<html>Access denied</html>',EQUITY_HEADER+'\n',stockCSV([stock('INFY'),stock('INFY')]),
    stockCSV([stock('infy')]),stockCSV([stock('INFY').replace('INE144J01027','not-an-isin')]),
    stockCSV([stock('INFY').replace(',1,INE',',0,INE')]),stockCSV([stock('INFY')]).replace(', SERIES,',', SYMBOL,'),
    stockCSV([stock('INFY')])+',truncated,row',stockCSV([stock('INFY')]).replace('INFY Limited','"unterminated'),
    stockCSV([stock('INFY')]).replace('INFY Limited','"INFY"unexpected'),stockCSV([stock('INFY')])+'Disclaimer footer',
    stockCSV([stock('INFY')]).replace('INFY Limited','bad\u0000name'),
  ];
  for(const csv of bad)assert.throws(()=>parseEquityDirectory(csv,'equities'),/NSE equity directory/);
  assert.throws(()=>parseEquityDirectory('x'.repeat(2_000_001),'equities'),/invalid_csv_size/);
});

test('same IST-day schema-verified cache survives restart without downloads',async()=>{
  const f=fixture(),master=[instrument('INFY',1)];await f.service.resolve(master);
  const second=fixture({store:f.store,fetchOverride(){throw new Error('Unexpected network request');}});
  const result=await second.service.resolve(master);
  assert.equal(result.summary.cache_used,true);assert.equal(result.summary.date,'2026-09-17');assert.equal(second.calls.length,0);
  assert.equal(result.summary.sources[0].row_count,4);assert.equal(result.summary.sources[1].row_count,1);
});

test('cache expires at the IST midnight boundary and is replaced only by another verified directory',async()=>{
  const f=fixture({now:'2026-09-17T23:59:59+05:30'}),master=[instrument('INFY',1)];await f.service.resolve(master);
  f.advance(2000);const result=await f.service.resolve(master);
  assert.equal(result.summary.cache_used,false);assert.equal(result.summary.date,'2026-09-18');assert.equal(f.calls.length,4);assert.equal(f.store.writes,2);
});

test('failed stale-directory refresh neither trusts stale rows nor overwrites the last verified cache',async()=>{
  const f=fixture();await f.service.resolve([instrument('INFY',1)]);const before=f.store.get(EQUITY_CACHE_KEY);
  const offline=fixture({store:f.store,now:'2026-09-18T09:00:00+05:30',fetchOverride(){throw new Error('private-network-detail');}});
  const result=await offline.service.resolve([instrument('INFY',1),instrument('OWNEDBOND',2)],{managedSymbols:['OWNEDBOND']});
  assert.deepEqual(result.instruments.map(i=>[i.tradingsymbol,i.entry_eligible]),[['OWNEDBOND',false]]);
  assert.equal(result.summary.status,'unavailable');assert.equal(result.summary.entry_eligible_count,0);
  assert.equal(JSON.stringify(result).includes('private-network-detail'),false);assert.deepEqual(f.store.get(EQUITY_CACHE_KEY),before);
  await offline.service.resolve([instrument('INFY',1)]);assert.equal(offline.calls.length,4);
});

test('invalid, conflicting, oversized and future-dated directory caches are never used',async()=>{
  const f=fixture();await f.service.resolve([instrument('INFY',1)]);const valid=f.store.get(EQUITY_CACHE_KEY);
  const corruptions=[
    cache=>{cache.version=2;},cache=>{cache.observed_at='2026-09-17T18:00:00+05:30';},
    cache=>{cache.sources.equities.url='https://untrusted.example/list.csv';},
    cache=>{cache.sources.equities.records[0].symbol='invalid symbol';},
    cache=>{cache.sources.equities.records[1]={...cache.sources.equities.records[0]};},
    cache=>{cache.sources.etfs.records[0].series='EQ';},cache=>{cache.sources.etfs.row_count=100;},
    cache=>{cache.sources.equities.records[0].name=42;},cache=>{cache.extra='x'.repeat(4_000_001);},
  ];
  for(const corrupt of corruptions){
    const store=new Store(),cache=structuredClone(valid);corrupt(cache);store.set(EQUITY_CACHE_KEY,cache);
    const offline=fixture({store,fetchOverride(){throw new Error('Offline');}}),result=await offline.service.resolve([instrument('INFY',1)]);
    assert.equal(result.summary.status,'unavailable');assert.equal(result.instruments.length,0);assert.equal(offline.calls.length,2);assert.equal(store.writes,1);
  }
});

test('a failed source or cross-directory conflict never creates a partial trusted cache',async()=>{
  for(const invalid of [response('<html>blocked</html>',{'content-type':'text/html'}),response(stockCSV([stock('INFY')]))]){
    const f=fixture({fetchOverride:url=>url===EQUITY_SOURCES[0].url?response(stockCSV([stock('INFY')])):invalid});
    const result=await f.service.resolve([instrument('INFY',1)]);assert.equal(result.summary.status,'unavailable');assert.equal(f.store.writes,0);
  }
  const conflict=fixture({etfs:[etf('INFY')]}),result=await conflict.service.resolve([instrument('INFY',1)]);
  assert.equal(result.summary.status,'unavailable');assert.equal(result.summary.errors[0].code,'conflicting_directory_symbols');assert.equal(conflict.store.writes,0);
});

test('exact duplicate broker identities deduplicate, while token/symbol conflicts reject before downloads',async()=>{
  const f=fixture(),one=instrument('INFY',1),result=await f.service.resolve([one,{...one}]);
  assert.equal(result.instruments.length,1);assert.equal(result.summary.excluded_counts.duplicate_broker_rows,1);
  for(const rows of [[one,instrument('RELIANCE',1)],[one,instrument('INFY',2)],[one,{...one,tick_size:.01}],
    [instrument('INFY',0)],[instrument('bad symbol',1)],[null]]){
    const invalid=fixture();await assert.rejects(invalid.service.resolve(rows),/broker_instrument/);assert.equal(invalid.calls.length,0);
  }
});

test('response byte limits, malformed UTF-8, redirects and HTTP failures produce safe unavailable results',async()=>{
  const factories=[
    ()=>response('x',{'content-length':'2000001'}),()=>response('x'.repeat(2_000_001)),
    ()=>response(new Uint8Array([0xc3,0x28])),()=>new Response('<html>Forbidden</html>',{status:403}),
    ()=>Object.defineProperty(response(stockCSV([stock('INFY')])),'redirected',{value:true}),
  ];
  for(const factory of factories){
    const f=fixture({fetchOverride:()=>factory()}),result=await f.service.resolve([instrument('INFY',1)]);
    assert.equal(result.summary.status,'unavailable');assert.equal(result.instruments.length,0);assert.equal(f.store.writes,0);
  }
});

test('directory download and stalled body read deadlines settle even when a transport ignores cancellation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const bodyStalls of [false,true]){
    const f=fixture({fetchOverride:()=>bodyStalls?{ok:true,headers:new Headers({'content-type':'text/csv'}),body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})})}}:new Promise(()=>{})});
    const pending=f.service.resolve([instrument('INFY',1)]);await Promise.resolve();t.mock.timers.tick(10_000);
    const result=await pending;assert.equal(result.summary.status,'unavailable');assert(result.summary.errors.every(error=>error.code==='request_timeout'));
    assert(f.calls.every(call=>call.options.signal.aborted));assert.equal(f.store.writes,0);
  }
});

test('concurrent classification shares downloads but preserves separate managed selections',async()=>{
  const f=fixture(),master=[instrument('INFY',1),instrument('OWNEDBOND',2)];
  const [ordinary,recovery]=await Promise.all([f.service.resolve(master),f.service.resolve(master,{managedSymbols:['OWNEDBOND']})]);
  assert.equal(f.calls.length,2);assert.equal(f.store.writes,1);assert.equal(ordinary.instruments.length,1);assert.equal(recovery.instruments.length,2);
});
