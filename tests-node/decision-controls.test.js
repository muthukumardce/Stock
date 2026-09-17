import test from 'node:test';
import assert from 'node:assert/strict';
import {marketBreadth,portfolioExposure,portfolioEntryGate,returnCorrelation,pendingDeliveryQuantity} from '../src/decision-controls.js';
import {DEFAULTS} from '../src/config.js';

test('breadth excludes stale and illiquid data and fails closed on insufficient coverage',()=>{
  const settings={...DEFAULTS,min_market_samples:2,min_market_coverage:.5,min_daily_turnover:1000},universe={1:{},2:{},3:{},4:{}},quotes={
    1:{received_at:99,last_price:110,ohlc:{open:100},volume_traded:100},2:{received_at:99,last_price:90,ohlc:{open:100},volume_traded:100},
    3:{received_at:0,last_price:120,ohlc:{open:100},volume_traded:100},4:{received_at:99,last_price:150,ohlc:{open:100},volume_traded:0}};
  const result=marketBreadth(universe,quotes,settings,100);assert.equal(result.total,2);assert.equal(result.advancing,1);assert.equal(result.breadth,.5);assert.equal(result.status,'eligible');
  quotes[1].received_at=0;assert.equal(marketBreadth(universe,quotes,settings,100).status,'warming_up');
  quotes[1].received_at=99;quotes[1].last_price=80;assert.equal(marketBreadth(universe,quotes,settings,100).status,'defensive');
});

test('portfolio accounts for manual, pledged, T1 and journal risk without duplicating broker cover exposure',()=>{
  const result=portfolioExposure({settings:DEFAULTS,cash:10000,capital:10000,
    account:{holdings:[{tradingsymbol:'MANUAL',exchange:'NSE',quantity:50,t1_quantity:10,collateral_quantity:40,used_quantity:5,last_price:100}],positions:{net:[{tradingsymbol:'BOT',exchange:'NSE',product:'MIS',quantity:10,last_price:100}]}},
    positions:{BOT:{symbol:'BOT',quantity:10,entry:100,last:100,stop:98,protection:'broker_cover'}},intents:{pending:{symbol:'BOT',quantity:20,filled:10,entry:100,state:'pending'}}});
  assert.equal(result.reference_assets,15500);assert.equal(result.gross_exposure,7500);
  assert.equal(result.rows.find(r=>r.symbol==='MANUAL').exposure,5500);assert.equal(result.rows.find(r=>r.symbol==='BOT').exposure,2000);
  assert.equal(result.estimated_stress_loss,345);
});

test('unconfirmed stops, unknown prices, derivatives and MTF never create fictitious safe capacity',()=>{
  const base={settings:DEFAULTS,cash:10000,capital:10000,account:{holdings:[],positions:{net:[]}},positions:{BOT:{symbol:'BOT',quantity:10,entry:100,stop:99,protection:'unconfirmed'}}};
  assert.equal(portfolioExposure(base).estimated_stress_loss,50);
  for(const holding of [{quantity:10},{quantity:-1,last_price:100},{quantity:10,last_price:100,mtf:{quantity:10}}]){
    const report=portfolioExposure({...base,account:{holdings:[{tradingsymbol:'MANUAL',exchange:'NSE',...holding}]}});
    assert.equal(portfolioEntryGate(report,{symbol:'NEW',quantity:1,entry:100,stop:99},DEFAULTS),'account_exposure_unverified');
  }
});

test('candidate controls enforce account concentration, gross exposure and stressed holdings risk separately',()=>{
  const p={reference_assets:10000,gross_exposure:7000,estimated_stress_loss:200,rows:[{symbol:'A',exposure:2000}],unpriced_symbols:[],unsupported_symbols:[]};
  assert.equal(portfolioEntryGate(p,{symbol:'A',quantity:10,entry:100,stop:99},DEFAULTS),'account_stock_concentration');
  assert.equal(portfolioEntryGate({...p,gross_exposure:8500},{symbol:'B',quantity:10,entry:100,stop:99},DEFAULTS),'account_gross_exposure');
  assert.equal(portfolioEntryGate({...p,estimated_stress_loss:295},{symbol:'B',quantity:10,entry:100,stop:99},DEFAULTS),'account_stress_budget');
  assert.equal(portfolioEntryGate(p,{symbol:'B',quantity:10,entry:100,stop:99},DEFAULTS),null);
});

test('return correlation aligns actual date pairs and rejects unavailable or flat histories',()=>{
  const rows=Array.from({length:26},(_,i)=>({time:new Date(Date.UTC(2026,7,i+1)),close:100+i+Math.sin(i)*2}));
  assert.ok(returnCorrelation(rows,rows)>.9999);
  const doubled=rows.map(r=>({...r,close:r.close*2}));assert.ok(returnCorrelation(rows,doubled)>.9999);
  assert.equal(returnCorrelation(rows,rows.slice(10)),null);
  assert.equal(returnCorrelation(rows,rows.map(r=>({...r,close:100}))),null);
  assert.equal(returnCorrelation(rows,rows.map(r=>({...r,time:new Date(+r.time+100*86400000)}))),null);
});

test('a separately reported pledged quantity remains part of observed stock exposure',()=>{
  const result=portfolioExposure({settings:DEFAULTS,cash:10000,account:{holdings:[{tradingsymbol:'PLEDGED',exchange:'NSE',quantity:0,collateral_quantity:10,last_price:100}]}});
  assert.equal(result.gross_exposure,1000);assert.equal(result.estimated_stress_loss,50);
});

test('old acquisition cost or a stale quote cannot substitute for a current account valuation',()=>{
  const input={settings:DEFAULTS,cash:10000,clock:100,universe:{1:{tradingsymbol:'HELD'}},quotes:{1:{last_price:500,received_at:0}},account:{holdings:[{tradingsymbol:'HELD',exchange:'NSE',quantity:10,average_price:500}]}};
  assert.deepEqual(portfolioExposure(input).unpriced_symbols,['HELD']);
  input.account.holdings[0].last_price=100;assert.equal(portfolioExposure(input).gross_exposure,1000);assert.deepEqual(portfolioExposure(input).unpriced_symbols,[]);
});

test('live account concentration uses current cash after a withdrawal rather than a stored capital floor',()=>{
  const report=portfolioExposure({settings:DEFAULTS,mode:'live',cash:10000,capital:100000,
    account:{holdings:[],positions:{net:[]}}});
  assert.equal(report.reference_assets,10000);
  assert.equal(portfolioEntryGate(report,{symbol:'NEW',entry:100,stop:99,quantity:90},DEFAULTS),'account_stock_concentration');
  assert.equal(portfolioEntryGate(report,{symbol:'NEW',entry:100,stop:99,quantity:20},DEFAULTS),null);
});

test('used holdings offset delivery sales once while unmatched CNC shorts remain exposed',()=>{
  const account={holdings:[{tradingsymbol:'SOLD',exchange:'NSE',quantity:100,t1_quantity:0,used_quantity:100,last_price:100}],
    positions:{net:[{tradingsymbol:'SOLD',exchange:'NSE',product:'CNC',quantity:-100,last_price:100}]}};
  const args={settings:DEFAULTS,mode:'live',cash:10000,capital:10000,account};
  const flat=portfolioExposure(args);
  assert.equal(flat.gross_exposure,0); assert.equal(flat.estimated_stress_loss,0); assert.deepEqual(flat.rows,[]);
  account.positions.net[0].quantity=-150;
  const residual=portfolioExposure(args);
  assert.equal(residual.gross_exposure,5000); assert.equal(residual.rows[0].exposure,5000);
  assert.equal(residual.estimated_stress_loss,250);
  account.holdings=[];
  assert.equal(portfolioExposure(args).gross_exposure,15000,'An unmatched short must never disappear when holdings are absent');
});

test('terminal delivery IOC entries release canceled quantity while unresolved entry quantity stays reserved',()=>{
  const position={symbol:'PARTIAL',source:'swing',status:'protected',requested_quantity:10,quantity:4,remaining_quantity:4,
    entry_price:100,stop:95,entry_intent:'entry-one'};
  const args={settings:DEFAULTS,mode:'live',cash:10000,capital:10000,account:{holdings:[],positions:{net:[]}}};
  for(const intent of [
    {state:'terminal',order:{status:'CANCELLED',filled_quantity:4}},
    {state:'aborted'}, {state:'rejected'},
    {state:'acknowledged',order:{status:'CANCELLED',filled_quantity:4}},
    {state:'acknowledged',order:{status:'COMPLETE',filled_quantity:4}},
    {state:'acknowledged',order:{status:'REJECTED',filled_quantity:4}},
  ]){
    const delivery={positions:{PARTIAL:position},intents:{'entry-one':intent}};
    assert.equal(pendingDeliveryQuantity(position,delivery),0,JSON.stringify(intent));
    assert.equal(portfolioExposure({...args,delivery}).gross_exposure,400,JSON.stringify(intent));
  }
  for(const intent of [undefined,{state:'submitting'},{state:'unknown'},{state:'acknowledged'},
    {state:'acknowledged',order:{status:'OPEN',filled_quantity:4,pending_quantity:6}}]){
    const delivery={positions:{PARTIAL:position},intents:intent?{'entry-one':intent}:{}};
    assert.equal(pendingDeliveryQuantity(position,delivery),6,JSON.stringify(intent));
    assert.equal(portfolioExposure({...args,delivery}).gross_exposure,1000,JSON.stringify(intent));
  }
});
