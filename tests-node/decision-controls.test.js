import test from 'node:test';
import assert from 'node:assert/strict';
import {marketBreadth,portfolioExposure,portfolioEntryGate,returnCorrelation,pendingDeliveryQuantity} from '../src/decision-controls.js';
import {DEFAULTS} from '../src/config.js';

test('breadth excludes stale and illiquid data and fails closed on insufficient coverage',()=>{
  const settings={...DEFAULTS,market_regime_filter:true,min_market_samples:2,min_market_coverage:.5,min_daily_turnover:1000},universe={1:{},2:{},3:{},4:{}},quotes={
    1:{received_at:99,last_price:110,ohlc:{open:100},volume_traded:100},2:{received_at:99,last_price:90,ohlc:{open:100},volume_traded:100},
    3:{received_at:0,last_price:120,ohlc:{open:100},volume_traded:100},4:{received_at:99,last_price:150,ohlc:{open:100},volume_traded:0}};
  const result=marketBreadth(universe,quotes,settings,100);assert.equal(result.total,2);assert.equal(result.advancing,1);assert.equal(result.breadth,.5);assert.equal(result.status,'eligible');
  quotes[1].received_at=0;assert.equal(marketBreadth(universe,quotes,settings,100).status,'warming_up');
  quotes[1].received_at=99;quotes[1].last_price=80;assert.equal(marketBreadth(universe,quotes,settings,100).status,'defensive');
});

test('exit-only recovered instruments neither contribute to equity breadth nor dilute its coverage',()=>{
  const settings={...DEFAULTS,market_regime_filter:true,min_market_samples:1,min_market_coverage:1,min_daily_turnover:0};
  const universe={1:{entry_eligible:true},2:{entry_eligible:false},3:{entry_eligible:false}};
  const quotes={1:{received_at:99,last_price:90,ohlc:{open:100},volume_traded:100},2:{received_at:99,last_price:150,ohlc:{open:100},volume_traded:100}};
  const report=marketBreadth(universe,quotes,settings,100);
  assert.equal(report.coverage,1);assert.equal(report.total,1);assert.equal(report.advancing,0);assert.equal(report.breadth,0);assert.equal(report.status,'defensive');
  universe[1].entry_eligible=false;const empty=marketBreadth(universe,quotes,settings,100);
  assert.equal(empty.coverage,0);assert.equal(empty.total,0);assert.equal(empty.status,'warming_up');
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

function pendingOrder(overrides={}){return {order_id:'manual-one',exchange:'NSE',tradingsymbol:'MANUAL',product:'MIS',variety:'regular',
  transaction_type:'BUY',order_type:'LIMIT',status:'OPEN',quantity:1000,filled_quantity:0,pending_quantity:1000,price:100,...overrides};}
function pendingPortfolio(orders,overrides={}){return portfolioExposure({settings:DEFAULTS,cash:80000,capital:100000,mode:'live',
  account:{holdings:[],positions:{net:[]},orders},...overrides});}

test('pending manual buys and shorts reserve full unleveraged notional before another symbol can enter',()=>{
  for(const transaction_type of ['BUY','SELL']){
    const report=pendingPortfolio([pendingOrder({transaction_type})],{clock:100,universe:{1:{tradingsymbol:'MANUAL'}},quotes:{1:{last_price:100,received_at:99}}});
    assert.equal(report.gross_exposure,100000);assert.equal(report.rows[0].symbol,'MANUAL');
    assert.equal(report.estimated_stress_loss,5000);assert.equal(report.reference_assets,80000);
    assert.equal(portfolioEntryGate(report,{symbol:'OTHER',entry:100,stop:98,quantity:80},DEFAULTS),'account_gross_exposure');
    assert.match(report.message,/pending orders/);
  }
});

test('pending partial fills add only remaining quantity to the current broker position',()=>{
  const order=pendingOrder({quantity:10,filled_quantity:4,pending_quantity:6});
  const report=pendingPortfolio([order],{account:{orders:[order],holdings:[],positions:{net:[{exchange:'NSE',tradingsymbol:'MANUAL',product:'MIS',quantity:4,last_price:100}]}}});
  assert.equal(report.gross_exposure,1000);assert.equal(report.rows[0].exposure,1000);
  assert.equal(report.estimated_stress_loss,50);
  for(const status of ['CANCEL PENDING','MODIFY PENDING'])assert.equal(pendingPortfolio([{...order,status,pending_quantity:0}]).gross_exposure,600,'Unconfirmed cancellation does not release the remainder');
  for(const status of ['CANCELLED','REJECTED','COMPLETE'])assert.equal(pendingPortfolio([{...order,status}]).gross_exposure,0,'Terminal orders have no outstanding reservation');
});

test('manual market orders need a current price and malformed order risk fails closed',()=>{
  const market=pendingOrder({order_type:'MARKET',price:0});
  let report=pendingPortfolio([market]);assert.deepEqual(report.unpriced_symbols,['MANUAL']);
  assert.equal(portfolioEntryGate(report,{symbol:'OTHER',entry:100,stop:98,quantity:1},DEFAULTS),'account_exposure_unverified');
  const context={clock:100,universe:{1:{tradingsymbol:'MANUAL'}},quotes:{1:{last_price:101,received_at:99}}};
  assert.equal(pendingPortfolio([market],context).gross_exposure,101000);
  assert.deepEqual(pendingPortfolio([pendingOrder({transaction_type:'SELL'})]).unpriced_symbols,['MANUAL'],'A sell limit is not an upper bound on short notional');
  assert.deepEqual(pendingPortfolio([market],{...context,quotes:{1:{last_price:101,received_at:0}}}).unpriced_symbols,['MANUAL']);
  const bad=[null,{},pendingOrder({order_id:''}),pendingOrder({transaction_type:'UNKNOWN'}),pendingOrder({product:'NRML'}),pendingOrder({exchange:'NFO'}),
    pendingOrder({filled_quantity:null}),pendingOrder({pending_quantity:null}),pendingOrder({quantity:true}),pendingOrder({quantity:[1000]}),pendingOrder({quantity:NaN}),pendingOrder({quantity:1.5}),
    pendingOrder({filled_quantity:1001}),pendingOrder({pending_quantity:1001}),pendingOrder({price:-100}),pendingOrder({order_type:'SL-M',trigger_price:0})];
  for(const order of bad){report=pendingPortfolio([order]);assert.equal(portfolioEntryGate(report,{symbol:'OTHER',entry:100,stop:98,quantity:1},DEFAULTS),'account_exposure_unverified',JSON.stringify(order));}
  assert.equal(portfolioEntryGate(pendingPortfolio({unexpected:true}),{symbol:'OTHER',entry:100,stop:98,quantity:1},DEFAULTS),'account_exposure_unverified');
  assert.equal(portfolioEntryGate(pendingPortfolio([pendingOrder(),pendingOrder()]),{symbol:'OTHER',entry:100,stop:98,quantity:1},DEFAULTS),'account_exposure_unverified');
});

test('a pending-only journal reservation has finite stress before any position exists',()=>{
  const report=pendingPortfolio([],{intents:{queued:{symbol:'BOT',quantity:10,filled:0,entry:100,state:'submitting'}}});
  assert.equal(report.gross_exposure,1000);assert.equal(report.estimated_stress_loss,50);
});

test('managed pending cover entries and recognized protective children are not counted twice',()=>{
  for(const side of ['BUY','SELL']){
    const parent=pendingOrder({order_id:'owned-parent',tag:'owned-tag',tradingsymbol:'OWNED',variety:'co',transaction_type:side,quantity:10,filled_quantity:4,pending_quantity:6});
    const child=pendingOrder({order_id:'owned-stop',parent_order_id:'owned-parent',tradingsymbol:'OWNED',variety:'co',transaction_type:side==='BUY'?'SELL':'BUY',
      order_type:'SL-M',price:0,trigger_price:side==='BUY'?98:102,status:'TRIGGER PENDING',quantity:4,filled_quantity:0,pending_quantity:4});
    const intents={['owned-tag']:{tag:'owned-tag',symbol:'OWNED',side,order_id:'owned-parent',quantity:10,filled:4,entry:100,state:'pending',broker_children:[child]}};
    const positions={OWNED:{symbol:'OWNED',side,tag:'owned-tag',quantity:4,entry:100,last:100,stop:side==='BUY'?98:102,protection:'broker_cover'}};
    const input={intents,positions,account:{holdings:[],orders:[parent,child],positions:{net:[{exchange:'NSE',tradingsymbol:'OWNED',product:'MIS',quantity:side==='BUY'?4:-4,last_price:100}]}}};
    const report=pendingPortfolio([],input);assert.equal(report.gross_exposure,1000);assert.deepEqual(report.unsupported_symbols,[]);assert.deepEqual(report.unpriced_symbols,[]);
    assert.equal(report.estimated_stress_loss,38);
    const changed={...parent,price:110};assert.equal(pendingPortfolio([],{...input,account:{...input.account,orders:[changed,child]}}).gross_exposure,1060,'A higher broker limit increases the existing reservation');
    const unrelated={...parent,order_id:'unowned',tag:'unowned-tag'};
    assert.equal(pendingPortfolio([],{...input,account:{...input.account,orders:[parent,child,unrelated]}}).gross_exposure,1600,'Same symbol does not establish journal ownership');
    const excessive={...child,order_id:'other-stop'};intents['owned-tag'].broker_children.push(excessive);
    const tooMany=pendingPortfolio([],{...input,account:{...input.account,orders:[parent,child,excessive]}});
    assert.equal(portfolioEntryGate(tooMany,{symbol:'OTHER',entry:100,stop:98,quantity:1},DEFAULTS),'account_exposure_unverified','Two independently executable exits cannot both consume the same owned shares');
  }
});

test('a confirmed broker order ID cannot be replaced by a matching tag on another order',()=>{
  for(const side of ['BUY','SELL']){
    const order=pendingOrder({order_id:'different-order',tag:'owned-tag',tradingsymbol:'OWNED',variety:'co',transaction_type:side,quantity:10,pending_quantity:10});
    const intent={tag:'owned-tag',symbol:'OWNED',side,order_id:'confirmed-order',quantity:10,filled:0,entry:100,state:'pending'};
    const input={intents:{'owned-tag':intent},clock:100,universe:{1:{tradingsymbol:'OWNED'}},quotes:{1:{last_price:100,received_at:99}}};
    assert.equal(pendingPortfolio([order],input).gross_exposure,2000,'A distinct order retains its own exposure even when the confirmed order is absent from the snapshot');
    assert.equal(pendingPortfolio([{...order,order_id:'confirmed-order'}],input).gross_exposure,1000,'The confirmed order is deduplicated');
    delete intent.order_id;intent.state='unknown';
    assert.equal(pendingPortfolio([order],input).gross_exposure,1000,'Tag recovery remains available before acknowledgement');
  }
  const entry=pendingOrder({order_id:'different-entry',tag:'entry-tag',tradingsymbol:'DELIVERY',product:'CNC',quantity:10,pending_quantity:10});
  const p={symbol:'DELIVERY',source:'swing',status:'entry_pending',requested_quantity:10,quantity:0,remaining_quantity:0,entry_price:100,entry_intent:'entry-tag'};
  const delivery={positions:{DELIVERY:p},intents:{'entry-tag':{id:'entry-tag',order_id:'confirmed-entry',state:'acknowledged',payload:{quantity:10}}}};
  assert.equal(pendingPortfolio([entry],{delivery}).gross_exposure,2000,'CNC reservations also require the confirmed ID');
  delete delivery.intents['entry-tag'].order_id;delivery.intents['entry-tag'].state='unknown';
  assert.equal(pendingPortfolio([entry],{delivery}).gross_exposure,1000);
  delivery.intents['entry-tag'].state='terminal';Object.assign(p,{status:'exit_pending',quantity:4,remaining_quantity:4,exit_intents:['exit-tag']});
  delivery.intents['exit-tag']={id:'exit-tag',order_id:'confirmed-exit',state:'acknowledged',payload:{quantity:4}};
  const exit=pendingOrder({order_id:'different-exit',tag:'exit-tag',tradingsymbol:'DELIVERY',product:'CNC',transaction_type:'SELL',quantity:4,pending_quantity:4});
  const account={holdings:[],orders:[exit],positions:{net:[{exchange:'NSE',tradingsymbol:'DELIVERY',product:'CNC',quantity:4,last_price:100}]}};
  assert.equal(pendingPortfolio([],{account,delivery}).gross_exposure,800,'A distinct tagged exit cannot consume the managed exit exemption');
  exit.order_id='confirmed-exit';assert.equal(pendingPortfolio([],{account,delivery}).gross_exposure,400);
  exit.order_id='different-exit';delete delivery.intents['exit-tag'].order_id;delivery.intents['exit-tag'].state='unknown';
  assert.equal(pendingPortfolio([],{account,delivery}).gross_exposure,400,'An unacknowledged exit retains tag recovery');
});

test('managed CNC entry reservations and associated IOC/GTT exits preserve their existing exposure',()=>{
  const entry=pendingOrder({order_id:'cnc-entry',tag:'entry-tag',tradingsymbol:'DELIVERY',product:'CNC',quantity:10,filled_quantity:4,pending_quantity:6});
  const p={symbol:'DELIVERY',source:'swing',status:'entry_pending',requested_quantity:10,quantity:4,remaining_quantity:4,entry_price:100,entry_intent:'entry-tag'};
  const delivery={positions:{DELIVERY:p},intents:{'entry-tag':{id:'entry-tag',order_id:'cnc-entry',state:'acknowledged',payload:{quantity:10}}}};
  const account={orders:[entry],holdings:[],positions:{net:[{exchange:'NSE',tradingsymbol:'DELIVERY',product:'CNC',quantity:4,last_price:100}]}};
  assert.equal(pendingPortfolio([],{account,delivery}).gross_exposure,1000);
  Object.assign(delivery.intents['entry-tag'],{state:'terminal',order:{status:'CANCELLED'}});account.orders=[];p.status='exit_pending';
  const exit=pendingOrder({order_id:'cnc-exit',tag:'exit-tag',tradingsymbol:'DELIVERY',product:'CNC',transaction_type:'SELL',quantity:4,pending_quantity:4});
  p.exit_intents=['exit-tag'];delivery.intents['exit-tag']={id:'exit-tag',order_id:'cnc-exit',state:'acknowledged',payload:{quantity:4}};account.orders=[exit];
  assert.equal(pendingPortfolio([],{account,delivery}).gross_exposure,400);
  p.exit_intents=[];p.gtt_order_ids=['cnc-exit'];p.gtt_orders={'cnc-exit':exit};assert.equal(pendingPortfolio([],{account,delivery}).gross_exposure,400);
  p.gtt_order_ids=[];p.gtt_orders={};assert.equal(pendingPortfolio([],{account,delivery}).gross_exposure,800,'Unassociated manual sells are conservatively treated as potential additional exposure');
});
