import {createHash} from 'node:crypto';

const compare=(left,right)=>left<right?-1:left>right?1:0;
const digest=value=>createHash('sha256').update(value).digest('hex');
const statuses=new Set(['fresh','stale','conflict','unknown','unavailable']);
const label=value=>typeof value==='string'&&value.trim()&&value.length<=160&&!/[\u0000-\u001f\u007f]/.test(value)?value.trim().replace(/\s+/g,' '):null;

/** Use the verified current index only. Zero selects every eligible constituent.
 * Missing/stale membership must never fall back to the wider trading universe. */
export function selectIndexResearchSymbols(universe,limit,index){
  if(!Number.isSafeInteger(limit)||limit<0||limit>1000)throw new RangeError('Research stock count must be between 0 (all constituents) and 1000');
  const scope={name:'NIFTY TOTAL MARKET',status:index?.status||'unavailable',source:index?.source||null,observed_at:index?.observed_at||null,
    mode:limit===0?'all':'sample',constituent_count:index?.records?.length||0,eligible_count:0,selected_count:0,
    excluded_symbols:[],excluded_placeholders:index?.excluded||[]};
  const empty=selectResearchSymbols({},0);
  if(index?.status!=='fresh'||!index.records?.length)return {...empty,scope,blocked_reason:'Waiting for a fresh Nifty Total Market constituent list. Connect Zerodha and check Overview → Market context; research will not substitute other NSE stocks.'};
  const records=new Map(index.records.map(row=>[row.symbol,row]));
  const candidates=Object.fromEntries(Object.entries(universe||{}).filter(([,row])=>records.has(row?.tradingsymbol)));
  const classified=symbol=>({classification_status:'fresh',industry:records.get(symbol)?.industry});
  const eligible=selectResearchSymbols(candidates,records.size,classified),available=new Set(eligible.selected.map(([,row])=>row.tradingsymbol));
  for(const symbol of records.keys())if(!available.has(symbol))scope.excluded_symbols.push({symbol,reason:Object.values(candidates).some(row=>row.tradingsymbol===symbol)?'not_entry_eligible':'broker_instrument_unavailable'});
  scope.excluded_symbols.sort((a,b)=>compare(a.symbol,b.symbol));scope.eligible_count=available.size;
  const selected=limit===0?eligible:selectResearchSymbols(candidates,limit,classified);
  selected.selected.sort((a,b)=>compare(a[1].tradingsymbol,b[1].tradingsymbol));
  scope.selected_count=selected.selected.length;
  Object.assign(selected.diversification,{policy:limit===0?'nifty_total_market_all_v1':'nifty_total_market_industry_sample_v1',
    caveat:'Current Nifty Total Market constituents only. Industry sampling uses a stable order without prices or returns. Missing instruments or history are reported, never replaced by stocks outside the index. Current membership introduces survivorship bias; historical membership is not reconstructed.'});
  return {...selected,scope,blocked_reason:available.size?null:'Waiting for verified tradable NSE instruments matching Nifty Total Market. Check Background → NSE security universe.'};
}

/** Pure, deterministic sampling of the supplied verified NSE universe.
 * Only current industry labels influence representation; prices and returns
 * never influence selection. The caller owns classification retrieval/cache.
 */
export function selectResearchSymbols(universe,limit,forSymbol){
  if(!Number.isSafeInteger(limit)||limit<0||limit>9000)throw new RangeError('Research selection requires an integer limit between 0 and 9000');
  const resolver=typeof forSymbol==='function',unique=new Map();
  for(const [token,instrument] of Object.entries(universe||{})){
    if(!instrument||instrument.entry_eligible===false||typeof instrument.tradingsymbol!=='string'||!instrument.tradingsymbol.trim()||instrument.tradingsymbol.length>40)continue;
    const number=Number(token);if(!Number.isSafeInteger(number)||number<=0)continue;
    const symbol=instrument.tradingsymbol,previous=unique.get(symbol);
    if(!previous||number<Number(previous.token)||number===Number(previous.token)&&compare(token,previous.token)<0)unique.set(symbol,{token,symbol});
  }
  const candidates=[...unique.values()].sort((left,right)=>compare(left.symbol,right.symbol));
  const groups=new Map(),unclassified=[];
  for(const candidate of candidates){
    let info;try{info=resolver?forSymbol(candidate.symbol):null;}catch{info={classification_status:'unavailable'};}
    const status=statuses.has(info?.classification_status)?info.classification_status:resolver?'unknown':'unavailable';
    const industry=status==='fresh'?(label(info.industry)||label(info.sector)):null;
    const member={...candidate,industry,classification_status:industry?'fresh':status==='fresh'?'unknown':status,rank:digest('symbol:'+candidate.symbol)};
    if(!industry){unclassified.push(member);continue;}
    const key=industry.toUpperCase();
    if(!groups.has(key))groups.set(key,{key,industry,rank:digest('industry:'+key),members:[]});
    const group=groups.get(key);if(compare(industry,group.industry)<0)group.industry=industry;
    group.members.push(member);
  }
  const orderedGroups=[...groups.values()].sort((left,right)=>compare(left.rank,right.rank)||compare(left.key,right.key));
  for(const group of orderedGroups)group.members.sort((left,right)=>compare(left.rank,right.rank)||compare(left.symbol,right.symbol));
  const chosen=[];
  for(let round=0;chosen.length<limit;round++){
    let added=false;
    for(const group of orderedGroups){
      const member=group.members[round];if(!member)continue;
      chosen.push({...member,industry:group.industry});added=true;if(chosen.length===limit)break;
    }
    if(!added)break;
  }
  // Synthetic/older engines without a resolver retain their alphabetical sample.
  unclassified.sort(resolver?(left,right)=>compare(left.rank,right.rank)||compare(left.symbol,right.symbol):(left,right)=>compare(left.symbol,right.symbol));
  chosen.push(...unclassified.slice(0,Math.max(0,limit-chosen.length)));
  const industries=orderedGroups.map(group=>({industry:group.industry,symbols:chosen.filter(member=>member.industry===group.industry).map(member=>member.symbol)})).filter(group=>group.symbols.length);
  const unclassifiedSymbols=chosen.filter(member=>!member.industry).map(member=>member.symbol),classified=chosen.length-unclassifiedSymbols.length;
  const status=!classified?'unclassified':industries.length<2||unclassifiedSymbols.length||chosen.length<limit?'limited':'diversified';
  return {
    selected:chosen.map(member=>[member.token,{tradingsymbol:member.symbol}]),
    diversification:{policy:'industry_round_robin_v1',status,requested_count:limit,selected_count:chosen.length,classified_count:classified,
      unclassified_symbols:unclassifiedSymbols,available_industries:orderedGroups.length,industries,
      members:chosen.map(({symbol,industry,classification_status})=>({symbol,industry,classification_status})),
      caveat:resolver?'Current fresh NSE industry classifications determine this sample. Coverage can be incomplete; current membership and survivorship bias remain, and this is not a historical or complete NSE sector taxonomy.':'Industry classifications are unavailable. This alphabetical fallback is not an industry-diversified or representative sample of NSE.',
    },
  };
}
