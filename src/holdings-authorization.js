import { dateIST, isoIST, parseTime } from './util.js';

const KEY='holdings_authorization_requests';
const validSymbol=value=>typeof value==='string'&&/^[A-Z0-9&.-]{1,40}$/.test(value);
const validISIN=value=>typeof value==='string'&&/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value);
function integer(value){const number=Number(value);return Number.isSafeInteger(number)&&number>=0?number:null;}
function available(holding){
  if(!holding||holding.exchange!=='NSE'||(holding.product||'CNC')!=='CNC'||holding.discrepancy)return 0;
  const q=integer(holding.quantity),used=integer(holding.used_quantity??0),pledged=integer(holding.collateral_quantity??0);
  return q===null||used===null||pledged===null?0:Math.max(0,q-used-pledged);
}

// A prior day's permission or an already consumed quantity cannot authorize a
// new sale. This intentionally errs toward another prompt if fields disagree.
export function authorizedQuantity(holding,now=new Date()){
  const raw=holding?.authorised_date;
  if(typeof raw==='string'){
    const parts=/^(\d{4})-(\d{2})-(\d{2})(?:[ T]|$)/.exec(raw);
    if(!parts)return 0;
    const calendar=new Date(Date.UTC(Number(parts[1]),Number(parts[2])-1,Number(parts[3])));
    if(calendar.toISOString().slice(0,10)!==parts[0].slice(0,10))return 0;
  }
  const at=parseTime(holding?.authorised_date);
  if(!at||dateIST(at)!==dateIST(now))return 0;
  const authorized=integer(holding.authorised_quantity),used=integer(holding.used_quantity??0);
  if(authorized===null||used===null)return 0;
  return Math.max(0,Math.min(available(holding),authorized-used));
}

export class HoldingsAuthorization {
  constructor(store,now=()=>new Date()){
    this.store=store;this.now=now;this.items=store.get(KEY,{});this.checked_at=null;
    this.request=null;this.lastAttempt=-Infinity;this.lastError='';
  }
  save(){this.store.set(KEY,this.items);}
  require({symbol,quantity,holding,reason='Holdings sale requires CDSL authorization',broker_rejected=false}){
    if(!validSymbol(symbol)||!Number.isSafeInteger(quantity)||quantity<=0)return;
    const previous=this.items[symbol];
    const row={symbol,quantity,isin:validISIN(holding?.isin)?holding.isin:'',reason,broker_rejected:broker_rejected||previous?.broker_rejected||false,requested_at:previous?.requested_at||isoIST(this.now())};
    this.items[symbol]=row;
    if(!previous||previous.quantity!==quantity||previous.reason!==reason||previous.isin!==row.isin||previous.broker_rejected!==row.broker_rejected){
      this.save();this.store.event('holdings.consent_required',`${symbol}: complete the official Zerodha/CDSL authorization to continue.`,{symbol,quantity},'warning');
    }
  }
  isBlocked(symbol){return this.items[symbol]?.broker_rejected===true;}
  reconcile(holdings,profile,scope,{userConfirmed=false}={}){
    const before=JSON.stringify(this.items),physical=profile?.meta?.demat_consent==='physical';
    for(const [symbol,item] of Object.entries(this.items)){
      const holding=holdings.find(h=>h.exchange==='NSE'&&h.tradingsymbol===symbol);
      const quantity=Math.min(item.quantity,available(holding));
      if(!scope.has(symbol)){delete this.items[symbol];continue;}
      if(quantity<=0){
        // A still-managed CNC position can be absent from settled holdings.
        // Missing usable shares never overturn a definite broker rejection.
        if(!item.broker_rejected)delete this.items[symbol];
        continue;
      }
      if((!item.broker_rejected||userConfirmed)&&(physical||authorizedQuantity(holding,this.now())>=quantity)){delete this.items[symbol];continue;}
      item.quantity=quantity;item.isin=validISIN(holding?.isin)?holding.isin:'';
    }
    this.checked_at=isoIST(this.now());
    if(before!==JSON.stringify(this.items)){
      this.save();this.request=null;this.lastError='';
      this.store.event('holdings.consent_checked','Broker holdings authorization rechecked; any remaining sale still requires current account and price checks.',{remaining_symbols:Object.keys(this.items)});
    }
    return this.snapshot();
  }
  snapshot(){
    const items=Object.values(this.items).map(({symbol,quantity,reason})=>({symbol,quantity,reason}));
    const required=items.length>0;
    const pending=this.request&&this.now().getTime()-this.request.at<60000;
    return {required,status:!required?'verified':this.lastError?'unavailable':pending?'awaiting_user':'required',items,checked_at:this.checked_at,
      message:!required?'No holdings authorization is pending.':this.lastError||'Complete TPIN and OTP verification on the official Zerodha/CDSL page, then return here and select Check authorization. Authorizing does not itself place an order.'};
  }
  async start(broker,apiKey,holdings){
    const items=Object.values(this.items);
    if(!items.length)return {authorization:this.snapshot(),message:'No holdings authorization is pending.'};
    const grouped=new Map();
    for(const item of items){
      const holding=holdings.find(h=>h.exchange==='NSE'&&h.tradingsymbol===item.symbol);
      if(!holding||!validISIN(holding.isin)||available(holding)<item.quantity){
        this.lastError='Current holding identifiers or quantities could not be verified. Open Kite → Holdings → Authorise, then select Check authorization here.';
        throw new Error(this.lastError);
      }
      const quantity=Math.min(Number(holding.quantity),item.quantity+Number(holding.used_quantity||0));
      if(!Number.isSafeInteger(quantity)||quantity<=0)throw new Error('No verified quantity is available for authorization');
      grouped.set(holding.isin,Math.max(grouped.get(holding.isin)||0,quantity));
    }
    const instruments=[...grouped].sort(([a],[b])=>a.localeCompare(b)).slice(0,100).map(([isin,quantity])=>({isin,quantity}));
    const signature=JSON.stringify([dateIST(this.now()),instruments]),now=this.now().getTime();
    if(this.request?.signature===signature&&now-this.request.at<60000)return {...this.request.result,authorization:this.snapshot()};
    if(now-this.lastAttempt<5000)throw new Error('Please wait a few seconds before requesting another authorization page');
    this.lastAttempt=now;
    try{
      const response=await broker.call('authorise_holdings',{instruments});
      const id=response?.request_id;
      if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(id))throw new Error('Invalid broker authorization response');
      this.store.add_secret?.(id);
      const result={authorization_url:`https://kite.zerodha.com/connect/portfolio/authorise/holdings/${encodeURIComponent(apiKey)}/${encodeURIComponent(id)}`,
        request_count:instruments.length,total_count:grouped.size,message:'Complete authorization in the opened Zerodha/CDSL tab, then return here. No sale is submitted by this action.'};
      this.request={signature,at:now,result};this.lastError='';
      this.store.event('holdings.consent_started','Official holdings authorization page requested.',{instruments:instruments.length});
      return {...result,authorization:this.snapshot()};
    }catch{
      this.lastError='Kite could not open the authorization flow. Open Kite → Holdings → Authorise, then select Check authorization here.';
      this.store.event('holdings.consent_unavailable',this.lastError,{},'warning');throw new Error(this.lastError);
    }
  }
}
