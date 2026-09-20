import test from 'node:test';
import assert from 'node:assert/strict';
import {selectResearchSymbols,selectIndexResearchSymbols} from '../src/research-selection.js';

const universe=symbols=>Object.fromEntries(symbols.map((tradingsymbol,index)=>[index+1,{tradingsymbol,entry_eligible:true}]));
const fresh=industry=>({classification_status:'fresh',industry});

test('Nifty Total Market offers a reproducible industry sample and all 750 members without outside replacements',()=>{
  const records=Array.from({length:750},(_,i)=>({symbol:`STOCK${String(i).padStart(3,'0')}`,industry:`Industry ${i%15}`}));
  const index={status:'fresh',records,source:'official fixture',observed_at:'2026-09-17T10:00:00Z'};
  const input=universe([...records.map(row=>row.symbol),'OUTSIDE']);
  for(const row of Object.values(input))Object.defineProperty(row,'last_price',{get(){throw new Error('Price must not select the sample');}});
  const sample=selectIndexResearchSymbols(input,60,index);
  assert.equal(sample.selected.length,60);assert.equal(sample.diversification.industries.length,15);
  assert.ok(sample.diversification.industries.every(group=>group.symbols.length===4));
  assert.deepEqual(selectIndexResearchSymbols(Object.fromEntries(Object.entries(input).reverse()),60,{...index,records:[...records].reverse()}),sample);
  const all=selectIndexResearchSymbols(input,0,index);
  assert.equal(all.scope.mode,'all');assert.equal(all.scope.constituent_count,750);assert.equal(all.scope.eligible_count,750);assert.equal(all.scope.selected_count,750);
  assert.deepEqual(all.selected.map(([,row])=>row.tradingsymbol),records.map(row=>row.symbol));
  assert.match(all.diversification.caveat,/survivorship bias/);
  assert.equal(selectIndexResearchSymbols(input,1000,index).selected.length,750);
  delete input[1];input[2].entry_eligible=false;
  const partial=selectIndexResearchSymbols(input,0,index);
  assert.equal(partial.selected.length,748);
  assert.deepEqual(partial.scope.excluded_symbols,[{symbol:'STOCK000',reason:'broker_instrument_unavailable'},{symbol:'STOCK001',reason:'not_entry_eligible'}]);
  assert.ok(!partial.selected.some(([,row])=>row.tradingsymbol==='OUTSIDE'));
});

test('missing or stale index membership blocks research without falling back to NSE stocks',()=>{
  for(const index of [undefined,{status:'unavailable'},{status:'fresh',records:[]},{status:'stale',records:[{symbol:'A',industry:'Banks'}]}]){
    const result=selectIndexResearchSymbols(universe(['A','B']),20,index);
    assert.equal(result.selected.length,0);assert.match(result.blocked_reason,/fresh Nifty Total Market/);
  }
  for(const limit of [-1,1.5,1001,'20',NaN])assert.throws(()=>selectIndexResearchSymbols({},limit),/stock count/);
});

test('research sampling rotates across verified industries before taking more names from a group',()=>{
  const symbols=['BANKA','BANKB','BANKC','BANKD','ITA','ITB','ITC','ITD','FARMA','FARMB','FARMC','FARMD'];
  const result=selectResearchSymbols(universe(symbols),6,symbol=>fresh(symbol.startsWith('BANK')?'Banks':symbol.startsWith('IT')?'Information Technology':'Agriculture'));
  assert.equal(result.selected.length,6);assert.equal(result.diversification.status,'diversified');assert.equal(result.diversification.available_industries,3);
  assert.deepEqual(result.diversification.industries.map(group=>group.symbols.length),[2,2,2]);
  assert.equal(new Set(result.diversification.members.slice(0,3).map(member=>member.industry)).size,3);
  assert.equal(result.diversification.classified_count,6);assert.deepEqual(result.diversification.unclassified_symbols,[]);
});

test('hashed selection is deterministic across object ordering and ignores prices or returns',()=>{
  const input=universe(['AAA','AAB','AAC','AAD','ZZZ','ZZY','ZZX','ZZW']);
  for(const instrument of Object.values(input))Object.defineProperty(instrument,'last_price',{get(){throw new Error('Sampling must not read prices');}});
  const resolver=symbol=>({...fresh(symbol.startsWith('A')?'Group A':'Group Z'),get returns(){throw new Error('Sampling must not read returns');}});
  const selected=selectResearchSymbols(input,4,resolver);
  assert.deepEqual(selectResearchSymbols(Object.fromEntries(Object.entries(input).reverse()),4,resolver),selected);
  assert.deepEqual(selectResearchSymbols(input,4,resolver),selected);
  assert.notDeepEqual(selected.selected.map(([,instrument])=>instrument.tradingsymbol),['AAA','AAB','AAC','AAD']);
});

test('only fresh industry or sector labels are classified; fallback fills remaining slots honestly',()=>{
  const input=universe(['FRESH','SECTOR','STALE','CONFLICT','UNKNOWN','EMPTY']);
  const source={FRESH:fresh('Banks'),SECTOR:{classification_status:'fresh',sector:'IT'},STALE:{classification_status:'stale',industry:'Banks'},CONFLICT:{classification_status:'conflict',industry:'Energy'},UNKNOWN:{classification_status:'unknown',industry:'Energy'},EMPTY:{classification_status:'fresh',industry:''}};
  const result=selectResearchSymbols(input,6,symbol=>source[symbol]);
  assert.equal(result.diversification.status,'limited');assert.equal(result.diversification.classified_count,2);assert.equal(result.diversification.unclassified_symbols.length,4);
  assert.deepEqual(new Set(result.selected.slice(0,2).map(([,instrument])=>instrument.tradingsymbol)),new Set(['FRESH','SECTOR']));
  assert.equal(result.diversification.members.find(member=>member.symbol==='STALE').classification_status,'stale');
  assert.equal(result.diversification.members.find(member=>member.symbol==='CONFLICT').industry,null);
  assert.equal(result.diversification.members.find(member=>member.symbol==='EMPTY').classification_status,'unknown');
});

test('unclassified names do not displace available fresh classified stocks',()=>{
  const input=universe(['AAUNKNOWN','BBUNKNOWN','CLEAN1','CLEAN2','CLEAN3','CLEAN4']);
  const result=selectResearchSymbols(input,3,symbol=>symbol.startsWith('CLEAN')?fresh(symbol.endsWith('1')||symbol.endsWith('3')?'Banks':'Energy'):{classification_status:'unknown'});
  assert.equal(result.diversification.classified_count,3);assert.equal(result.diversification.status,'diversified');assert.ok(result.selected.every(([,row])=>row.tradingsymbol.startsWith('CLEAN')));
});

test('selection excludes ineligible entries, deduplicates symbols and chooses a stable valid token',()=>{
  const input={9:{tradingsymbol:'DUP'},3:{tradingsymbol:'DUP'},1:{tradingsymbol:'EXCLUDED',entry_eligible:false},2:{tradingsymbol:'OTHER'},invalid:{tradingsymbol:'BADTOKEN'},0:{tradingsymbol:'ZERO'}};
  const result=selectResearchSymbols(input,9,symbol=>fresh(symbol==='DUP'?'Banks':'Energy'));
  assert.equal(result.selected.length,2);assert.deepEqual(result.selected.find(([,row])=>row.tradingsymbol==='DUP'),['3',{tradingsymbol:'DUP'}]);
  assert.equal(result.diversification.status,'limited');assert.equal(result.diversification.requested_count,9);assert.equal(result.diversification.selected_count,2);
});

test('missing resolver preserves alphabetical compatibility and never claims diversification',()=>{
  const result=selectResearchSymbols(universe(['ZZZ','AAA','MMM']),2);
  assert.deepEqual(result.selected.map(([,row])=>row.tradingsymbol),['AAA','MMM']);
  assert.equal(result.diversification.status,'unclassified');assert.equal(result.diversification.available_industries,0);assert.equal(result.diversification.classified_count,0);assert.match(result.diversification.caveat,/alphabetical fallback/);
});

test('limited classifications and resolver outages do not invent sector coverage',()=>{
  const input=universe(['A','B','C']);
  const one=selectResearchSymbols(input,2,()=>fresh('Banks'));assert.equal(one.diversification.status,'limited');assert.equal(one.diversification.available_industries,1);
  const missing=selectResearchSymbols(input,2,()=>{throw new Error('Provider unavailable');});assert.equal(missing.diversification.status,'unclassified');assert.ok(missing.diversification.members.every(member=>member.classification_status==='unavailable'));
  const single=selectResearchSymbols(input,1,symbol=>fresh(symbol));assert.equal(single.diversification.status,'limited');assert.equal(single.selected.length,1);
});

test('normalized industry labels share a group and oversized or control-character labels remain unclassified',()=>{
  const source={A:fresh(' Banks '),B:fresh('BANKS'),C:fresh('Bad\nLabel'),D:fresh('x'.repeat(161))};
  const result=selectResearchSymbols(universe(Object.keys(source)),4,symbol=>source[symbol]);
  assert.equal(result.diversification.available_industries,1);assert.equal(result.diversification.industries[0].symbols.length,2);assert.equal(result.diversification.classified_count,2);
});

test('selection respects exact requested count, empty input and bounded integer limits',()=>{
  const input=universe(['A','B','C']);
  for(const limit of [0,1,2,3,5])assert.equal(selectResearchSymbols(input,limit,()=>fresh('Banks')).selected.length,Math.min(limit,3));
  assert.deepEqual(selectResearchSymbols({},2).selected,[]);
  for(const limit of [-1,1.5,NaN,Infinity,9001,'2'])assert.throws(()=>selectResearchSymbols(input,limit),/integer limit/);
});
