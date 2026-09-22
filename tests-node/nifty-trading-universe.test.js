import test from 'node:test';
import assert from 'node:assert/strict';
import {EquityUniverse,EQUITY_SOURCES} from '../src/equity-universe.js';
import {NiftyTradingUniverse} from '../src/nifty-trading-universe.js';
import {MarketContext,INDEX_SOURCES} from '../src/market-context.js';

const BASE=new Date('2026-09-22T09:30:00+05:30');
const source=INDEX_SOURCES.find(row=>row.id==='niftytotalmarket');
const stock=(symbol,token)=>({tradingsymbol:symbol,instrument_token:token,exchange:'NSE',segment:'NSE',instrument_type:'EQ',tick_size:.05});
const csv=symbols=>'Company Name,Industry,Symbol,Series,ISIN Code\n'+symbols.map(symbol=>`${symbol} Ltd,Technology,${symbol},EQ,INE144J01027`).join('\n');
function fixture(t){
  let now=new Date(BASE),available=true;const requests=[],cache=new Map();
  const store={get:(key,fallback)=>structuredClone(cache.get(key)??fallback),set:(key,value)=>cache.set(key,structuredClone(value)),event:()=>{}};
  const members=Array.from({length:750},(_,i)=>'STOCK'+i),equities=[...members,'OUTSIDE','LATER'];
  const fetch=async url=>{
    requests.push(url);
    if(url===source.url){if(!available)throw new Error('unavailable');return new Response(csv(members),{headers:{'content-type':'text/csv'}});}
    const body=url===EQUITY_SOURCES[0].url?'SYMBOL,NAME OF COMPANY,SERIES,DATE OF LISTING,PAID UP VALUE,MARKET LOT,ISIN NUMBER,FACE VALUE\n'+equities.map(symbol=>`${symbol},${symbol} Ltd,EQ,06-OCT-2008,5,1,INE144J01027,5`).join('\n'):
      'Symbol,Underlying Asset,SecurityName,DateofListing,MarketLot,ISINNumber,FaceValue,ETF Underlying,Underlying Key\nETF,Nifty 50,ETF,08-Jan-02,1,INF204KB14I2,1,EQUITY,Nifty 50';
    return new Response(body,{headers:{'content-type':'text/csv'}});
  };
  const context=new MarketContext(store,{}, {fetch,now:()=>now,indexSources:[source],benchmarks:[]});
  t.after(()=>context.close());
  const directory=new EquityUniverse(store,{fetch,now:()=>now,minimumRows:{equities:1,etfs:1}});
  const universe=new NiftyTradingUniverse(store,{marketContext:context,directory,now:()=>now});
  const master=[...equities.map((symbol,i)=>stock(symbol,i+1)),stock('ETF',800),stock('BOND',801)];
  return {universe,context,master,requests,members,advance:ms=>{now=new Date(+now+ms);},outage:()=>{available=false;},recover:()=>{available=true;}};
}

test('trading subscribes to official constituents and existing exposure, excluding the rest of NSE',async t=>{
  const f=fixture(t),result=await f.universe.resolve(f.master,{managedSymbols:['OUTSIDE','ETF','BOND']});
  assert.equal(result.summary.entry_eligible_count,750);assert.equal(result.instruments.length,753);
  assert.equal(result.summary.managed_only_count,3);assert.equal(result.summary.index.constituent_count,750);
  assert.equal(result.instruments.some(row=>row.tradingsymbol==='LATER'),false);
  for(const symbol of ['OUTSIDE','ETF','BOND'])assert.equal(result.instruments.find(row=>row.tradingsymbol===symbol).entry_eligible,false);
  assert.equal(result.instruments.find(row=>row.tradingsymbol==='OUTSIDE').holding_eligible,true);
  assert.equal(result.instruments.find(row=>row.tradingsymbol==='ETF').holding_eligible,true);
  assert.equal(result.instruments.find(row=>row.tradingsymbol==='BOND').holding_eligible,false);
  assert.equal(f.master[0].entry_eligible,undefined);
  assert.deepEqual(f.requests.sort(),[source.url,...EQUITY_SOURCES.map(row=>row.url)].sort());
  await f.universe.resolve(f.master);assert.equal(f.requests.length,3,'same-day membership and security cache are reused');
});

test('missing instruments are reported without substituting other stocks or truncating index membership',async t=>{
  const f=fixture(t);f.members.push('OUTSIDE');
  const result=await f.universe.resolve(f.master.filter(row=>row.tradingsymbol!=='STOCK10'));
  assert.equal(result.summary.index.constituent_count,751);assert.equal(result.summary.entry_eligible_count,750);
  assert.deepEqual(result.summary.index.missing_symbols,['STOCK10']);
  assert.ok(result.instruments.find(row=>row.tradingsymbol==='OUTSIDE').entry_eligible);
  assert.equal(result.instruments.some(row=>row.tradingsymbol==='LATER'),false);
});

test('missing membership never falls back to all NSE stocks and retains existing exposure',async t=>{
  const f=fixture(t);f.outage();
  const result=await f.universe.resolve(f.master,{managedSymbols:['OUTSIDE']});
  assert.equal(result.summary.status,'unavailable');assert.equal(result.summary.entry_eligible_count,0);
  assert.deepEqual(result.instruments.map(row=>row.tradingsymbol),['OUTSIDE']);
  assert.equal(result.instruments[0].entry_eligible,false);assert.equal(result.instruments[0].holding_eligible,true);
  const calls=f.requests.length;await f.universe.resolve(f.master);assert.equal(f.requests.length,calls,'index retry backoff is respected');
  f.recover();f.advance(60001);assert.equal((await f.universe.resolve(f.master)).summary.entry_eligible_count,750);
});

test('the next IST day refreshes membership even within 24 hours and rejects stale research membership',async t=>{
  const f=fixture(t);await f.universe.resolve(f.master);
  f.outage();f.advance(15*3600000);
  const result=await f.universe.resolve(f.master,{managedSymbols:['STOCK0']});
  assert.equal(f.context.researchConstituents().status,'fresh','research classification has a separate age policy');
  assert.equal(result.summary.index.status,'stale');assert.equal(result.summary.entry_eligible_count,0);
  assert.equal(result.instruments[0].entry_eligible,false);
  assert.equal(f.requests.filter(url=>url===source.url).length,2);
  f.recover();f.advance(60001);f.members.splice(0,1,'OUTSIDE');
  const restored=await f.universe.resolve(f.master,{managedSymbols:['STOCK0']});
  assert.equal(restored.summary.status,'verified');assert.equal(restored.summary.entry_eligible_count,750);
  assert.equal(restored.instruments.find(row=>row.tradingsymbol==='STOCK0').entry_eligible,false);
  assert.equal(restored.instruments.find(row=>row.tradingsymbol==='OUTSIDE').entry_eligible,true);
});

test('incomplete membership is rejected by the production constituent completeness check',async t=>{
  const f=fixture(t);f.members.length=699;
  const result=await f.universe.resolve(f.master);
  assert.equal(result.summary.status,'unavailable');assert.equal(result.instruments.length,0);
});
