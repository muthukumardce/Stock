import {EquityUniverse} from './equity-universe.js';
import {dateIST,parseTime} from './util.js';

/** Apply index membership after security classification. Existing exposure is
 * retained for monitoring, but index exclusion never authorizes a new entry. */
export class NiftyTradingUniverse {
  constructor(store,{marketContext,now=()=>new Date(),directory=new EquityUniverse(store,{now})}={}) {
    this.marketContext=marketContext;this.now=now;this.directory=directory;
  }
  async resolve(master,{managedSymbols=[]}={}) {
    const [classified,index]=await Promise.all([
      this.directory.resolve(master,{managedSymbols}),this.marketContext.tradingConstituents(),
    ]);
    const observed=parseTime(index?.observed_at),now=this.now();
    const fresh=index?.status==='fresh'&&observed&&observed<=now&&dateIST(observed)===dateIST(now)&&index.records?.length>0;
    const verified=classified.summary.status==='verified'&&Boolean(fresh);
    const members=new Set(fresh?index.records.map(row=>row.symbol):[]),managed=new Set(managedSymbols);
    const instruments=classified.instruments.filter(row=>verified&&row.entry_eligible!==false&&members.has(row.tradingsymbol)||managed.has(row.tradingsymbol))
      .map(row=>({...row,holding_eligible:row.entry_eligible!==false,
        entry_eligible:verified&&row.entry_eligible!==false&&members.has(row.tradingsymbol),
        recovery_only:!(verified&&row.entry_eligible!==false&&members.has(row.tradingsymbol))}));
    const eligible=instruments.filter(row=>row.entry_eligible),matched=new Set(eligible.map(row=>row.tradingsymbol));
    const missing=fresh?index.records.filter(row=>!matched.has(row.symbol)).map(row=>row.symbol).sort():[];
    const outside=classified.instruments.filter(row=>row.entry_eligible!==false&&!members.has(row.tradingsymbol)).length;
    return {instruments,summary:{...classified.summary,status:verified?'verified':'unavailable',
      included_count:instruments.length,entry_eligible_count:eligible.length,
      equity_count:eligible.filter(row=>row.security_kind==='equity').length,etf_count:eligible.filter(row=>row.security_kind==='etf').length,
      managed_only_count:instruments.length-eligible.length,excluded_count:master.length-instruments.length,
      excluded_counts:{...classified.summary.excluded_counts,outside_nifty_total_market:fresh?outside:0},
      index:{name:'NIFTY TOTAL MARKET',status:fresh?'fresh':index?.status==='fresh'?'stale':index?.status||'unavailable',
        source:index?.source||null,observed_at:index?.observed_at||null,constituent_count:index?.records?.length||0,
        missing_count:missing.length,missing_symbols:missing,excluded_placeholders:index?.excluded||[]},
      errors:[...(classified.summary.errors||[]),...(!fresh?[{source:'niftytotalmarket',code:'current_membership_unavailable'}]:[])],
      scope:'Current Nifty Total Market constituents matched to verified NSE securities and Kite instruments. Other existing exposure is monitored without new entries. No arbitrary 750-symbol truncation.'}};
  }
}
