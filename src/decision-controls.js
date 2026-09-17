import {dateIST, parseTime} from './util.js';
import {directionOf,plannedRisk} from './direction.js';

const positive=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):0;
const sum=values=>values.reduce((total,value)=>total+value,0);
const round=value=>Math.round(value*10000)/10000;
const TERMINAL_ORDERS=new Set(['COMPLETE','CANCELLED','REJECTED']);
const PENDING_INTENTS=new Set(['submitting','unknown','pending','conflict','unprotected','exit_unknown','exit_pending']);
const orderIdentifier=value=>typeof value==='string'&&value.length>0&&value.length<=128?value:Number.isSafeInteger(value)&&value>0?String(value):null;
const numberLike=value=>typeof value==='number'||typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value));

export function pendingDeliveryQuantity(position,delivery){
  if(position.source!=='swing'||position.status==='closed')return 0;
  const intent=delivery.intents?.[position.entry_intent];
  if(intent&&(['terminal','aborted','rejected'].includes(intent.state)||['COMPLETE','CANCELLED','REJECTED'].includes(intent.order?.status)))return 0;
  return Math.max(0,positive(position.requested_quantity)-positive(position.quantity));
}

/** Breadth is a live liquid-stock sample, not an exchange index or a forecast. */
export function marketBreadth(universe,quotes,settings,clock){
  const tokens=Object.keys(universe).filter(t=>universe[t].entry_eligible!==false),fresh=tokens.filter(t=>clock-Number(quotes[t]?.received_at??-Infinity)<=10);
  let advancing=0,declining=0,unchanged=0;
  for(const token of fresh){
    const q=quotes[token],price=positive(q.last_price),open=positive(q.ohlc?.open);
    if(!price||!open||positive(q.volume_traded)*price<settings.min_daily_turnover)continue;
    if(price>open)advancing++;else if(price<open)declining++;else unchanged++;
  }
  const total=advancing+declining+unchanged,coverage=tokens.length?fresh.length/tokens.length:0,breadth=total?advancing/total:null;
  const enabled=settings.market_regime_filter===true;
  const enough=total>=settings.min_market_samples&&coverage>=settings.min_market_coverage;
  const status=!enabled?'disabled':!enough?'warming_up':breadth>=settings.min_market_breadth?'eligible':'defensive';
  const permitted_sides=!enabled?['BUY',...(settings.intraday_short_enabled?['SELL']:[])]:!enough?[]:[...(breadth>=settings.min_market_breadth?['BUY']:[]),...(settings.intraday_short_enabled&&declining/total>=settings.min_market_breadth?['SELL']:[])];
  return {status,advancing,declining,unchanged,total,coverage:round(coverage),breadth:breadth===null?null:round(breadth),declining_fraction:total?round(declining/total):null,permitted_sides,
    message:!enabled?'Market breadth gate disabled.':!enough?'Waiting for enough fresh liquid stocks and universe coverage.':permitted_sides.length?`Breadth permits ${permitted_sides.map(s=>s==='BUY'?'long':'short').join(' and ')} setups; individual checks still apply.`:'Breadth does not support an enabled entry direction; exits remain active.'};
}

/** Align actual trading dates before correlating returns; never pair row numbers. */
export function returnCorrelation(left,right,minimum=20){
  function returns(bars){const rows=new Map();for(let i=1;i<bars.length;i++){
    const a=bars[i-1],b=bars[i],at=parseTime(a.time??a.date),bt=parseTime(b.time??b.date);
    if(at&&bt&&bt>at&&positive(a.close)&&positive(b.close)&&Math.abs(b.close/a.close-1)<=0.2)rows.set(dateIST(at)+'/'+dateIST(bt),b.close/a.close-1);
  }return rows;}
  const a=returns(left),b=returns(right),pairs=[...a].filter(([key])=>b.has(key)).map(([key,value])=>[value,b.get(key)]).slice(-60);
  if(pairs.length<minimum)return null;
  const x=sum(pairs.map(p=>p[0]))/pairs.length,y=sum(pairs.map(p=>p[1]))/pairs.length;
  const xx=sum(pairs.map(p=>(p[0]-x)**2)),yy=sum(pairs.map(p=>(p[1]-y)**2));
  if(xx<=1e-20||yy<=1e-20)return null;
  return Math.max(-1,Math.min(1,sum(pairs.map(p=>(p[0]-x)*(p[1]-y)))/Math.sqrt(xx*yy)));
}

/** Conservative equity exposure estimate; this is not a broker NAV statement.
 * Existing/manual/pledged/T1 shares count even when the bot may not sell them.
 * Holdings and product positions are separate; bot journals fill missing broker
 * exposure with max(), not a duplicate addition. Pending unowned orders reserve
 * full remaining notional; their intent is not assumed to be an exit. Confirmed
 * managed entry reservations and position-reducing exits are deduplicated.
 * Derivatives/MTF and unverified pending orders block new risk.
 */
export function portfolioExposure({account,positions={},intents={},delivery={},quotes={},universe={},cash=0,capital=0,mode='live',settings,clock=Infinity}){
  const bySymbol=new Map(),unknown=new Set(),unsupported=new Set(),soldHoldings=new Map();
  const tokens=Object.fromEntries(Object.entries(universe).map(([token,i])=>[i.tradingsymbol,token]));
  function row(symbol){if(!bySymbol.has(symbol))bySymbol.set(symbol,{symbol,holding:0,broker:0,owned:0,pending:0,price:0,stop:0,verified:false});return bySymbol.get(symbol);}
  function currentPrice(p){const quote=quotes[tokens[p.tradingsymbol??p.symbol]];return (clock-Number(quote?.received_at??-Infinity)<=10?positive(quote?.last_price):0)||positive(p.last_price);}
  function price(p){return currentPrice(p)||positive(p.last)||positive(p.average_price)||positive(p.entry)||positive(p.entry_price);}
  for(const h of account.holdings||[]){
    if(['quantity','t1_quantity','used_quantity','collateral_quantity'].some(k=>h[k]!==undefined&&(!Number.isSafeInteger(Number(h[k]))||Number(h[k])<0)))unsupported.add(h.tradingsymbol);
    const quantity=Math.max(positive(h.collateral_quantity),positive(h.quantity)+positive(h.t1_quantity)-positive(h.used_quantity));
    soldHoldings.set(h.tradingsymbol,(soldHoldings.get(h.tradingsymbol)||0)+positive(h.used_quantity));
    if(positive(h.mtf?.quantity)||!['NSE','BSE',undefined].includes(h.exchange))unsupported.add(h.tradingsymbol);
    if(!quantity)continue;const r=row(h.tradingsymbol),p=price(h);if(!p)unknown.add(h.tradingsymbol);r.holding+=quantity*p;r.price=p||r.price;r.verified||=currentPrice(h)>0;
  }
  for(const p of account.positions?.net||[]){
    let quantity=Math.abs(Number(p.quantity||0));if(!quantity)continue;
    if(!Number.isSafeInteger(quantity)||!['NSE','BSE'].includes(p.exchange)||!['CNC','MIS','CO'].includes(p.product))unsupported.add(p.tradingsymbol);
    if(!Number.isFinite(quantity))continue;
    if(p.product==='CNC'&&Number(p.quantity)<0){
      // Kite also reports sold holdings as negative CNC day positions. Their
      // used_quantity was already deducted above; only unmatched shorts remain.
      const matched=Math.min(quantity,soldHoldings.get(p.tradingsymbol)||0);
      soldHoldings.set(p.tradingsymbol,(soldHoldings.get(p.tradingsymbol)||0)-matched);quantity-=matched;
      if(!quantity)continue;
    }
    const r=row(p.tradingsymbol),mark=price(p);if(!mark)unknown.add(p.tradingsymbol);r.broker+=quantity*mark;r.price=mark||r.price;r.verified||=currentPrice(p)>0;
  }
  for(const p of Object.values(positions)){
    const r=row(p.symbol),mark=price(p);if(!mark)unknown.add(p.symbol);r.owned+=positive(p.quantity)*mark;r.price=mark||r.price;r.verified||=currentPrice(p)>0;
    if(positive(p.stop)&&['simulated','broker_cover'].includes(p.protection)){r.stop=positive(p.stop);r.direction=directionOf(p);}
  }
  for(const p of Object.values(delivery.positions||{})){
    if(p.status==='closed')continue;const r=row(p.symbol),mark=price(p);
    if(!mark&&positive(p.remaining_quantity))unknown.add(p.symbol);
    r.owned=Math.max(r.owned,positive(p.remaining_quantity)*mark);r.price=mark||r.price;r.verified||=currentPrice(p)>0;
    if(p.status==='protected')r.stop=positive(p.stop);
    r.pending+=pendingDeliveryQuantity(p,delivery)*mark;
  }
  for(const i of Object.values(intents))if(PENDING_INTENTS.has(i.state))row(i.symbol).pending+=Math.max(0,positive(i.quantity)-positive(i.filled))*positive(i.entry);
  // Match only journal-associated orders with the same instrument, direction,
  // product, variety, original quantity and parent. A confirmed broker ID must
  // match; tag recovery is only for intents awaiting an acknowledgement.
  const claims=new Map();
  function register(claim){
    for(const key of [claim.id&&'id:'+claim.id,claim.tag&&'tag:'+claim.tag].filter(Boolean)){
      if(!claims.has(key))claims.set(key,[]);claims.get(key).push(claim);
    }
  }
  if(mode==='live'){
    for(const [tag,i] of Object.entries(intents)){
      const side=i.side??'BUY',id=orderIdentifier(i.order_id),common={symbol:i.symbol,exchange:'NSE',products:['MIS','CO'],variety:'co'};
      if(PENDING_INTENTS.has(i.state))register({...common,id,tag:i.tag||tag,side,quantity:i.quantity,parent:null,type:'entry',
        reserved:Math.max(0,positive(i.quantity)-positive(i.filled))*positive(i.entry)});
      const p=positions[i.symbol];
      if(!['closed','rejected'].includes(i.state)&&id&&p?.tag===(i.tag||tag)&&(p.side??'BUY')===side){
        const budget={remaining:positive(p.quantity)};
        for(const child of i.broker_children||[])register({...common,id:orderIdentifier(child.order_id),parent:id,side:side==='SELL'?'BUY':'SELL',quantity:child.quantity,type:'exit',budget});
      }
    }
    for(const p of Object.values(delivery.positions||{})){
      if(p.status==='closed')continue;
      const common={symbol:p.symbol,exchange:'NSE',products:['CNC'],variety:'regular',parent:null},entry=delivery.intents?.[p.entry_intent];
      if(p.source==='swing'&&pendingDeliveryQuantity(p,delivery)>0&&entry)register({...common,id:orderIdentifier(entry.order_id),tag:entry.id||p.entry_intent,
        side:'BUY',quantity:entry.payload?.quantity??p.requested_quantity,type:'entry',reserved:pendingDeliveryQuantity(p,delivery)*price(p)});
      const budget={remaining:positive(p.remaining_quantity)};
      for(const iid of p.exit_intents||[]){
        const exit=delivery.intents?.[iid];if(!exit||['terminal','aborted','rejected'].includes(exit.state))continue;
        register({...common,id:orderIdentifier(exit.order_id),tag:exit.id||iid,side:'SELL',quantity:exit.payload?.quantity,type:'exit',budget});
      }
      for(const id of p.gtt_order_ids||[]){const order=p.gtt_orders?.[id];if(order)register({...common,id:orderIdentifier(id),side:'SELL',quantity:order.quantity,type:'exit',budget});}
    }
  }
  const orderList=account.orders===undefined?[]:account.orders,seenOrders=new Set();let manualPending=0;
  if(!Array.isArray(orderList))unsupported.add('unverified_order_book');
  for(const order of Array.isArray(orderList)?orderList:[]){
    if(order&&TERMINAL_ORDERS.has(order.status))continue;
    const symbol=typeof order?.tradingsymbol==='string'&&/^[A-Z0-9&.-]{1,40}$/.test(order.tradingsymbol)?order.tradingsymbol:'unverified_order';
    const id=orderIdentifier(order?.order_id),quantity=Number(order?.quantity),filled=Number(order?.filled_quantity),pending=Number(order?.pending_quantity);
    if(!order||Array.isArray(order)||!id||seenOrders.has(id)||symbol==='unverified_order'||typeof order.status!=='string'||!order.status.trim()||
       !['NSE','BSE'].includes(order.exchange)||!['CNC','MIS','CO'].includes(order.product)||!['BUY','SELL'].includes(order.transaction_type)||
       !['LIMIT','MARKET','SL','SL-M'].includes(order.order_type)||!numberLike(order.quantity)||!Number.isSafeInteger(quantity)||quantity<=0||!numberLike(order.filled_quantity)||!Number.isSafeInteger(filled)||filled<0||filled>quantity||
       !numberLike(order.pending_quantity)||!Number.isSafeInteger(pending)||pending<0||pending>quantity-filled||
       ['SL','SL-M'].includes(order.order_type)&&(!numberLike(order.trigger_price)||!positive(order.trigger_price))){unsupported.add(symbol);continue;}
    seenOrders.add(id);
    // Nonterminal cancellation/modify notifications may report pending=0 before
    // the remainder is resolved. Quantity minus confirmed fills stays reserved.
    const remaining=quantity-filled;if(!remaining)continue;
    const keys=['id:'+id,...[order.tag,...(Array.isArray(order.tags)?order.tags:[])].filter(tag=>typeof tag==='string').map(tag=>'tag:'+tag)];
    const matching=[...new Set(keys.flatMap(key=>claims.get(key)||[]))].filter(c=>(!c.id||c.id===id)&&c.symbol===symbol&&c.exchange===order.exchange&&c.products.includes(order.product)&&
      c.variety===order.variety&&c.side===order.transaction_type&&Number(c.quantity)===quantity&&(orderIdentifier(order.parent_order_id)||null)===c.parent);
    if(matching.length>1){unsupported.add(symbol);continue;}
    const claim=matching[0];
    if(claim?.type==='exit'){
      if(remaining>claim.budget.remaining){unsupported.add(symbol);continue;}
      claim.budget.remaining-=remaining;continue;
    }
    if(claim?.matched){unsupported.add(symbol);continue;}
    const r=row(symbol),limit=['LIMIT','SL'].includes(order.order_type)&&numberLike(order.price)?positive(order.price):0;
    const observed=Math.max(currentPrice(order),r.verified?r.price:0);
    // A buy limit bounds entry cost. A sell limit is only a minimum sale price,
    // so it cannot establish short notional without a current observed mark.
    const mark=order.transaction_type==='SELL'&&!observed?0:Math.max(limit,observed);
    if(!mark){unknown.add(symbol);continue;}
    if(['LIMIT','SL'].includes(order.order_type)&&!limit){unsupported.add(symbol);continue;}
    const notional=remaining*mark;
    if(!Number.isFinite(notional)){unsupported.add(symbol);continue;}
    if(claim){claim.matched=true;r.pending+=Math.max(0,notional-claim.reserved);}
    else{r.pending+=notional;manualPending+=notional;}
  }
  const holdingValue=sum([...bySymbol.values()].map(r=>r.holding));
  const deliveryValue=sum((account.positions?.net||[]).filter(p=>p.product==='CNC'&&p.quantity>0).map(p=>p.quantity*price(p)));
  // The trading allocation baseline can outlive a withdrawal. It is never a
  // floor for live account capacity; use currently reported assets only.
  const assets=mode==='live'?positive(cash)+holdingValue+deliveryValue:positive(capital)+holdingValue;
  const rows=[...bySymbol.values()].map(r=>{
    const broker=r.holding+r.broker,exposure=(mode==='paper'?broker+r.owned:Math.max(broker,r.owned))+r.pending;
    if((broker+r.owned)>0&&!r.verified)unknown.add(r.symbol);
    const protectedValue=r.stop&&r.price?Math.min(r.owned,exposure):0;
    // Stops are a planned loss estimate. Stress the remainder; gap risk remains.
    const protectedStress=protectedValue>0?protectedValue*Math.max(0,(r.direction??1)*(1-r.stop/r.price)):0;
    const stress=protectedStress+(exposure-protectedValue)*(settings.unprotected_stress_pct??0.05);
    return {symbol:r.symbol,exposure:round(exposure),weight:assets?round(exposure/assets):null,stress:round(stress)};
  }).filter(r=>r.exposure>0).sort((a,b)=>b.exposure-a.exposure||a.symbol.localeCompare(b.symbol));
  return {reference_assets:round(assets),gross_exposure:round(sum(rows.map(r=>r.exposure))),estimated_stress_loss:round(sum(rows.map(r=>r.stress))),
    gross_fraction:assets?round(sum(rows.map(r=>r.exposure))/assets):null,rows,unpriced_symbols:[...unknown],unsupported_symbols:[...unsupported],
    message:'Estimated exposure includes manual and existing holdings and pending orders.'+(manualPending>0?' Unowned pending orders reserve full remaining notional, including orders that may have been intended as exits.':'')+' Stress limits do not guarantee maximum loss.'};
}

export function portfolioEntryGate(portfolio,{symbol,entry,stop,quantity,side='BUY'},settings){
  if(settings.portfolio_risk_enabled!==true)return null;
  if(portfolio.unpriced_symbols.length||portfolio.unsupported_symbols.length||portfolio.reference_assets<=0)return 'account_exposure_unverified';
  const notional=entry*quantity,assets=portfolio.reference_assets,existing=portfolio.rows.find(r=>r.symbol===symbol)?.exposure||0;
  if((existing+notional)/assets>settings.max_account_stock_pct)return 'account_stock_concentration';
  if((portfolio.gross_exposure+notional)/assets>settings.max_account_gross_pct)return 'account_gross_exposure';
  if((portfolio.estimated_stress_loss+plannedRisk({entry,stop,quantity,side})+notional*0.002)/assets>settings.max_account_risk_pct)return 'account_stress_budget';
  return null;
}
