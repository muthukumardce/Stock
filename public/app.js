'use strict';
const $ = id => document.getElementById(id);
const money = (n, digits=2) => Number.isFinite(Number(n)) && n !== null && n !== undefined ? new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:digits}).format(Number(n)) : '—';
const number = n => new Intl.NumberFormat('en-IN').format(Number(n) || 0);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = value => {if(!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value).slice(-8) : d.toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});};
const positive = n => Number(n) < 0 ? 'negative' : Number(n) > 0 ? 'positive' : '';
const empty = (n,text) => `<tr><td colspan="${n}" class="empty-cell">${escape(text)}</td></tr>`;
let csrf='', state={}, events=[], eventCursor=null, equityHistory=[], liveView=null, liveAllowed=true, activePage='overview', settingsLoaded=false, settingsDirty=false, busy=false, lastChartAt=0, toastTimer;
let configLoaded=false, configLoading=null, configDirty=false, configFields=[];
let paperModeDirty=false, savedExecution=null, configSaving=false, configRestartRequired=false;
let authorizationBusy=false, authorizationPending=false, authorizationWasRequired=false, authorizationLastCheck=0;
let researchState=null,researchLoading=null,researchBusy=false,researchTimer=null,researchRequest=null;
let selectedResearchInterval='';
const numeric=value=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))?null:Number(value);
const decimal=(value,digits=2)=>numeric(value)===null?'—':new Intl.NumberFormat('en-IN',{maximumFractionDigits:digits}).format(Number(value));
const percentage=value=>numeric(value)===null?'—':`${decimal(Number(value)*100)}%`;
const dateLabel=value=>{if(!value)return '—';const date=new Date(value);return Number.isFinite(+date)?date.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',year:'numeric'}):String(value);};

function officialHoldingsAuthorizationURL(value){
  let url;
  try{url=new URL(value);}catch{throw new Error('Zerodha did not return a valid authorization address. Please try again.');}
  const prefix='/connect/portfolio/authorise/holdings/';
  if(url.protocol!=='https:'||url.hostname!=='kite.zerodha.com'||url.port||url.username||url.password||!url.pathname.startsWith(prefix)||url.pathname.length<=prefix.length){
    throw new Error('The authorization address is not an official Zerodha holdings page. No page was opened.');
  }
  return url.href;
}
function authorizationFeedback(message,error=false){
  $('holdings-authorization-feedback').textContent=message;
  $('holdings-authorization-feedback').classList.toggle('negative',error);
}
function renderHoldingsAuthorization(){
  const authorization=state.holdings_authorization||{}, required=authorization.required===true;
  $('holdings-authorization').hidden=!required;
  if(!required){
    if(authorizationWasRequired&&authorization.status==='verified')toast('Holdings authorization verified with Zerodha.');
    authorizationWasRequired=false;authorizationPending=false;
    $('holdings-authorization-link').hidden=true;$('holdings-authorization-link').removeAttribute('href');
    authorizationFeedback('');return;
  }
  authorizationWasRequired=true;
  const unavailable=authorization.status==='unavailable';
  $('holdings-authorization-title').textContent=unavailable?'Holdings authorization unavailable':authorization.status==='awaiting_user'?'Complete holdings authorization':'Zerodha holdings authorization needed';
  $('holdings-authorization-message').textContent=authorization.message||'Authorize the selected shares before the program can sell them.';
  $('holdings-authorization-items').innerHTML=(authorization.items||[]).map(item=>`<li><strong>${escape(item.symbol)}</strong><span>${number(item.quantity)} shares</span>${item.reason?`<small>${escape(item.reason)}</small>`:''}</li>`).join('');
  $('holdings-authorization-start').disabled=authorizationBusy||!state.connected;
  $('holdings-authorization-check').disabled=authorizationBusy||!state.connected;
  $('holdings-authorization-start').textContent=authorizationBusy?'Please wait…':'Authorize holdings';
  $('holdings-authorization-checked').textContent=authorization.checked_at?`Last checked ${clock(authorization.checked_at)} IST`:'';
}
async function startHoldingsAuthorization(){
  if(authorizationBusy||!csrf||!state.connected||!state.holdings_authorization?.required)return;
  // Create a browsing context during the click gesture, then immediately sever
  // its opener before the asynchronous request or any external navigation.
  let popup=null;
  try{popup=window.open('about:blank','_blank');if(popup)popup.opener=null;}catch{try{popup?.close();}catch{}popup=null;}
  authorizationBusy=true;authorizationFeedback('Preparing the official Zerodha authorization page…');
  $('holdings-authorization-link').hidden=true;$('holdings-authorization-link').removeAttribute('href');
  renderHoldingsAuthorization();
  try{
    const result=await api('/api/holdings/authorization/start','POST',{});
    if(!result.authorization_url&&result.authorization?.required===false){
      try{popup?.close();}catch{}
      state.holdings_authorization=result.authorization;renderHoldingsAuthorization();
      await refresh();return;
    }
    const url=officialHoldingsAuthorizationURL(result.authorization_url),link=$('holdings-authorization-link');
    link.href=url;link.hidden=false;authorizationPending=true;
    state.holdings_authorization={...state.holdings_authorization,status:'awaiting_user'};
    let opened=false;
    if(popup&&!popup.closed){try{popup.location.replace(url);opened=true;}catch{try{popup.close();}catch{}}}
    const batch=Number.isFinite(result.request_count)&&Number.isFinite(result.total_count)&&result.total_count>result.request_count?` This request includes ${number(result.request_count)} of ${number(result.total_count)} holdings. Check authorization after completing it to continue.`:'';
    authorizationFeedback((opened?'Zerodha opened in a new tab. Complete authorization there, then return here.':'Your browser did not open the tab. Use “Open Zerodha authorization page” below to continue.')+batch);
  }catch(error){try{popup?.close();}catch{}authorizationFeedback(error.message,true);}
  finally{authorizationBusy=false;renderHoldingsAuthorization();}
}
async function checkHoldingsAuthorization({automatic=false}={}){
  if(authorizationBusy||!csrf||!liveAllowed||!state.connected||automatic&&!authorizationPending&&!state.holdings_authorization?.required)return;
  if(automatic&&Date.now()-authorizationLastCheck<3000)return;
  authorizationLastCheck=Date.now();authorizationBusy=true;
  authorizationFeedback('Checking current authorization with Zerodha…');renderHoldingsAuthorization();
  try{
    const result=await api('/api/holdings/authorization/refresh','POST',automatic?{}:{user_confirmed:true});
    if(result.authorization){state.holdings_authorization=result.authorization;renderHoldingsAuthorization();}
    if(result.authorization?.required)authorizationFeedback(result.authorization.message||'Authorization is still needed. Complete it on Zerodha, then check again.');
    await refresh();
  }catch(error){authorizationFeedback(error.message,true);}
  finally{authorizationBusy=false;renderHoldingsAuthorization();}
}
$('holdings-authorization-start').addEventListener('click',startHoldingsAuthorization);
$('holdings-authorization-check').addEventListener('click',()=>checkHoldingsAuthorization());
window.addEventListener('focus',()=>{if(document.visibilityState!=='hidden')checkHoldingsAuthorization({automatic:true});});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){checkHoldingsAuthorization({automatic:true});if(activePage==='research'&&csrf)loadResearch().catch(()=>{});}else stopResearchPolling();});

async function api(path, method='GET', body, options={}) {
  const response = await fetch(path,{method,cache:'no-store',signal:options.signal,headers:{'Content-Type':'application/json',...(method==='GET'?{}:{'X-CSRF-Token':csrf})},...(body === undefined?{}:{body:JSON.stringify(body)})});
  if(response.status===401){liveAllowed=false;liveView?.stop();stopResearchPolling();researchRequest?.abort();location.assign('/login');const error=new Error('Your session expired.');error.status=401;throw error;}
  const data = await response.json();
  if(!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Please check your settings and try again.');
  return data;
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function showPage(name){
  if(!['overview','holdings','orders','research','activity','settings'].includes(name)) name='overview';
  activePage=name;
  document.querySelectorAll('.page').forEach(p=>p.hidden=p.id!==`page-${name}`);
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===name));
  $('breadcrumb').textContent={overview:'Overview',holdings:'Holdings',orders:'Orders & trades',research:'Strategy research',activity:'Activity log',settings:'Settings'}[name];
  history.replaceState(null,'',name==='settings'?'/settings':`/#${name}`);
  renderTables();
  if(name==='settings'&&csrf)loadConfig().catch(showConfigError);
  if(name==='research'&&csrf)loadResearch().catch(()=>{});else stopResearchPolling();
}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));

function addEvents(rows){
  const known = new Set(events.map(e=>e.id));
  for(const row of rows||[]) if(!known.has(row.id)){events.push(row);known.add(row.id);}
  events.sort((a,b)=>a.id-b.id);events=events.slice(-500);
  if(events.length)eventCursor=Math.max(eventCursor??0,events.at(-1).id);
  renderActivity();
}
function badge(text, color=''){return `<span class="badge ${color}">${escape(text)}</span>`;}
function entrySide(row){const side=row.side??'BUY';return side==='BUY'?badge('BUY · Long','blue'):side==='SELL'?badge('SELL · Short','amber'):badge('Unknown side','red');}
function contextStatus(status){return ({fresh:'Fresh',stale:'Stale',partial:'Partial coverage',unavailable:'Unavailable',ready:'Sources ready',refreshing:'Refreshing',degraded:'Needs attention',closed:'Stopped'})[status]||String(status||'Unavailable').replaceAll('_',' ');}
function sourceBadge(status){return badge(contextStatus(status),status==='fresh'||status==='ready'?'green':['stale','partial','degraded'].includes(status)?'amber':'');}
function renderReadiness(){
  const readiness=state.readiness||{},checks=readiness.checks||[],labels={broker_session:'Broker session',system_clock:'System clock',equity_universe:'Stock & ETF eligibility',account_snapshot:'Account snapshot',reconciliation:'Account recovery',trading_cash:'Trading funds',market_session:'Market session',live_feed:'Live market feed',machine_capacity:'Machine capacity',maintenance:'Maintenance lock',entry_armed:'Trading armed'};
  const health=state.broker_clock;
  $('clock-status').hidden=!health||health.status==='aligned'&&!health.stale&&!health.blocked;
  if(health){
    const lower=numeric(health.offset_lower_ms),upper=numeric(health.offset_upper_ms),offset=lower===null||upper===null?null:(lower+upper)/2000;
    $('clock-status').textContent=health.blocked?`System clock needs synchronization${offset===null?'':`: approximately ${Math.round(Math.abs(offset))} seconds ${offset>0?'behind':'ahead of'} the broker`}. New entries wait. Synchronize this machine's operating-system clock; the program does not change it.`:'Waiting for a recent broker clock check. New entries wait; existing account monitoring continues.';
  }
  $('readiness-status').textContent=!checks.length?'Waiting for checks':readiness.ready?'Operational checks passed':'Entry prerequisites pending';
  $('readiness-status').className=`badge ${readiness.ready?'green':checks.length?'amber':''}`;
  $('readiness-scope').textContent=readiness.scope||'These checks describe operational readiness. Each trade still needs its own signal, liquidity, event and risk checks.';
  $('readiness-checks').innerHTML=checks.map(check=>`<div class="readiness-item"><span class="dot ${check.ok?'green':'amber'}"></span><div><strong>${escape(labels[check.key]||String(check.key).replaceAll('_',' '))}</strong><small>${check.ok?'Verified':'Required'}: ${escape(check.detail||'Waiting for the current check.')}</small></div><span class="readiness-result">${check.ok?'Pass':'Waiting'}</span></div>`).join('')||'<p class="empty-copy">Current operational checks have not arrived.</p>';
}
function renderMarketContext(){
  const context=state.decision_controls?.market_context||state.readiness?.market_context||{},calendar=context.calendar||{},classification=context.classification||{};
  $('context-status').textContent=contextStatus(context.status);$('context-status').className=`badge ${context.status==='ready'?'green':context.status==='partial'||context.status==='degraded'?'amber':''}`;
  $('calendar-status').textContent=contextStatus(calendar.status);$('calendar-status').className=`badge ${calendar.status==='fresh'?'green':['partial','stale'].includes(calendar.status)?'amber':''}`;
  $('calendar-message').textContent=calendar.risk_filter_enabled&&calendar.status!=='fresh'?'New entries wait for current corporate-event coverage. Managed exits remain active.':calendar.risk_filter_enabled===false?'The event entry filter is disabled. Source coverage is still shown for review.':calendar.message||'Waiting for current NSE announced-event coverage.';
  $('calendar-window').textContent=numeric(calendar.blackout_before_days)!==null?`Blackout: ${decimal(calendar.blackout_before_days,0)} calendar day(s) before and ${decimal(calendar.blackout_after_days,0)} after a meeting.`:'';
  $('classification-coverage').textContent=percentage(classification.coverage);
  $('classification-count').textContent=numeric(classification.universe_symbols)!==null?`${decimal(classification.covered_symbols,0)} of ${decimal(classification.universe_symbols,0)} universe symbols classified from current index files.`:'';
  $('classification-message').textContent=classification.message||'Missing industry or index membership stays unknown; coverage is not assumed for every NSE stock.';
  const blackouts=calendar.blackout_symbols||[];
  $('calendar-blackout-panel').hidden=!blackouts.length;
  $('calendar-blackout-title').textContent=`Announced-event windows · ${decimal(calendar.blackout_count??blackouts.length,0)} stock(s)${calendar.risk_filter_enabled===false?' · entry filter disabled':''}`;
  $('calendar-blackouts').innerHTML=blackouts.map(item=>`<li><strong>${escape(typeof item==='string'?item:item.symbol)}</strong><span>${escape((item.dates||[]).map(dateLabel).join(', '))}</span><small>${escape((item.kinds||[]).map(kind=>String(kind).replaceAll('_',' ')).join(', '))}</small></li>`).join('');
  $('context-benchmarks').innerHTML=(context.benchmarks||[]).map(item=>`<tr><td>${escape(item.name)}</td><td>${decimal(item.price)}</td><td>${percentage(item.change_from_open)}</td><td>${escape(String(item.trend||'unknown').replaceAll('_',' '))}</td><td>${sourceBadge(item.quote_status)}</td><td>${sourceBadge(item.history_status)} <small>${decimal(item.bar_count,0)} bars</small></td><td>${escape(clock(item.observed_at))}</td></tr>`).join('')||empty(7,'Benchmark quotes and completed history load through the authenticated broker session.');
  const sources=[...(classification.sources||[]).map(source=>({...source,label:source.index,records:source.symbol_count})),...(calendar.sources||[]).map(source=>({...source,label:source.id==='board'?'NSE board meetings':source.id==='calendar'?'NSE event calendar':source.id,records:source.event_count}))];
  $('context-sources').innerHTML=sources.map(source=>`<tr><td>${escape(source.label)}</td><td>${sourceBadge(source.status)}</td><td>${decimal(source.records,0)}</td><td>${source.observed_at?escape(`${dateLabel(source.observed_at)} · ${clock(source.observed_at)} IST`):'—'}</td><td>${escape(source.last_error?String(source.last_error).replaceAll('_',' '):source.excluded?.length?`${source.excluded.length} index placeholder(s) excluded`:'—')}</td></tr>`).join('')||empty(5,'Official source status will appear after the first refresh.');
}
function renderDecisionControls(){
  const controls=state.decision_controls||{},regime=controls.regime||{},portfolio=controls.portfolio||{},cooldown=controls.cooldown||{};
  const regimeLabels={eligible:'Broad participation',defensive:'Weak participation',warming_up:'Waiting for coverage',risk_on:'Broad participation',risk_off:'Weak participation',neutral:'Mixed participation',unknown:'Waiting for data',insufficient_data:'Insufficient data',disabled:'Filter disabled'};
  const status=regime.status||'unknown';
  $('decision-version').textContent=controls.strategy_version?String(controls.strategy_version):'STRATEGY';
  $('decision-summary').textContent=state.connected?'Current market and account checks inform each new entry. Existing positions continue through their own exit and protection rules.':'Connect Zerodha to evaluate market conditions and account exposure.';
  $('regime-status').textContent=regimeLabels[status]||String(status).replaceAll('_',' ');
  $('regime-status').className=`badge ${['eligible','risk_on'].includes(status)?'green':['defensive','risk_off'].includes(status)?'amber':''}`;
  $('regime-message').textContent=regime.message||'Waiting for enough current market data to assess participation.';
  $('regime-advancing').textContent=decimal(regime.advancing,0);$('regime-total').textContent=decimal(regime.total,0);
  $('regime-coverage').textContent=percentage(regime.coverage);$('regime-breadth').textContent=percentage(regime.breadth);
  const issues=[...(portfolio.unpriced_symbols||[]),...(portfolio.unsupported_symbols||[])];
  $('portfolio-status').textContent=!state.connected?'Waiting for account':issues.length?'Review account exposure':numeric(portfolio.reference_assets)===null?'Waiting for checks':'Exposure assessed';
  $('portfolio-status').className=`badge ${issues.length?'amber':''}`;
  $('portfolio-message').textContent=portfolio.message||'Risk, existing positions and concentration are checked before each new order.';
  $('portfolio-metrics').innerHTML=[['Reference assets',money(portfolio.reference_assets)],['Gross exposure',money(portfolio.gross_exposure)],['Gross / assets',percentage(portfolio.gross_fraction)],['Estimated stress loss',money(portfolio.estimated_stress_loss)]].map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('');
  $('portfolio-exposures').innerHTML=(portfolio.rows||[]).map(row=>`<tr><td>${escape(row.symbol)}</td><td>${money(row.exposure)}</td><td>${percentage(row.weight)}</td><td>${money(row.stress)}</td></tr>`).join('')||empty(4,'No priced account exposure is available.');
  const reasons=[...(controls.blocked_reasons||[])];
  if(!state.connected)reasons.unshift('Connect Zerodha to evaluate entries.');
  else if(state.status!=='running')reasons.unshift(state.status==='paused'?'New entries are paused. Resume trading to allow new entries.':'Trading has not started.');
  if(state.recovery?.blocked&&state.recovery.message)reasons.push(state.recovery.message);
  if(cooldown.until)reasons.push(`${cooldown.message||'New entries are cooling down.'} Until ${clock(cooldown.until)} IST.`);
  const calendar=controls.market_context?.calendar;
  if(calendar?.risk_filter_enabled&&calendar.status!=='fresh')reasons.push('Corporate-event calendar coverage is not current. New entries wait; managed exits continue.');
  if(portfolio.unpriced_symbols?.length)reasons.push(`Current prices unavailable: ${portfolio.unpriced_symbols.join(', ')}.`);
  if(portfolio.unsupported_symbols?.length)reasons.push(`Exposure needs review: ${portfolio.unsupported_symbols.join(', ')}.`);
  const unique=[...new Set(reasons.filter(value=>typeof value==='string'&&value.trim()))];
  $('decision-blockers').hidden=!unique.length;
  $('decision-blockers').innerHTML=unique.length?`<strong>Entry checks</strong><ul>${unique.map(reason=>`<li>${escape(reason)}</li>`).join('')}</ul>`:'';
  const candidates=controls.ranked_candidates||[];
  $('ranked-count').textContent=numeric(controls.candidate_count)===null?'':`(${decimal(controls.candidate_count,0)})`;
  $('ranked-candidates').innerHTML=candidates.slice(0,30).map(row=>`<tr><td>${escape(row.symbol)}</td><td>${escape(row.strategy)}<div class="entry-side">${entrySide(row)}</div></td><td>${decimal(row.score,1)}</td><td>${escape(row.reason||'')}</td></tr>`).join('')||empty(4,'No ranked candidates in the latest completed analysis.');
}
function signalMetrics(signal,opened=new Set()){
  const metrics=signal.analytics||signal.metrics||{},key=`${signal.symbol||''}:${signal.strategy||''}:${signal.timestamp||signal.time||''}`;
  const labels=[['ema9','EMA 9'],['ema21','EMA 21'],['rsi14','RSI 14'],['macd','MACD'],['macd_signal','MACD signal'],['macd_histogram','MACD histogram'],['adx14','ADX 14'],['plus_di14','+DI 14'],['minus_di14','−DI 14'],['atr_wilder14','Wilder ATR 14'],['atr14','ATR 14'],['bollinger_middle20','Bollinger middle'],['bollinger_upper20','Bollinger upper'],['bollinger_lower20','Bollinger lower'],['bollinger_width20','Bollinger width',percentage],['session_vwap','Session VWAP'],['window_vwap','Window VWAP'],['relative_volume20','Relative volume'],['atr_extension','ATR extension'],['return_volatility','Return volatility',percentage],['trend_slope_pct','Trend slope',value=>`${decimal(value,3)}%`],['trend_r_squared','Trend fit R²'],['efficiency_ratio','Efficiency ratio'],['candle_body_ratio','Candle body',percentage],['upper_wick_ratio','Upper wick',percentage]];
  const rows=labels.filter(([name])=>Object.hasOwn(metrics,name)).map(([name,label,format=decimal])=>`<div><dt>${escape(label)}</dt><dd>${escape(format(metrics[name]))}</dd></div>`);
  const patterns=(metrics.patterns||[]).map(pattern=>typeof pattern==='string'?pattern:`${pattern.name||pattern.id||'Pattern'}${pattern.direction?` · ${pattern.direction}`:''}${pattern.context?` · ${pattern.context}`:''}`);
  const evidence=signal.evidence||[],opposition=signal.opposition||[];
  if(!rows.length&&!patterns.length&&!evidence.length&&!opposition.length&&!signal.setup)return '';
  return `<details class="signal-details" data-signal="${escape(key)}" ${opened.has(key)?'open':''}><summary>Indicators &amp; evidence${numeric(signal.score)!==null?` · score ${decimal(signal.score,1)}${signal.score_components?'/100':''}`:''}</summary>${signal.setup?`<p>Setup: ${escape(signal.setup.replaceAll('_',' '))}</p>`:''}<dl>${rows.join('')}</dl>${metrics.vwap_scope?`<p>VWAP scope: ${escape(metrics.vwap_scope.replaceAll('_',' '))}${metrics.session_vwap_complete===false&&metrics.vwap_scope==='window'?' · partial session':''}</p>`:''}${patterns.length?`<p><strong>Candle patterns:</strong> ${patterns.map(escape).join('; ')}</p>`:''}${evidence.length?`<p><strong>Supporting evidence</strong></p><ul>${evidence.map(item=>`<li>${escape(item)}</li>`).join('')}</ul>`:''}${opposition.length?`<p><strong>Opposing evidence</strong></p><ul>${opposition.map(item=>`<li>${escape(item)}</li>`).join('')}</ul>`:''}<p class="muted">${signal.score_components?'The score measures rule agreement':'The baseline score measures relative volume'}; it is not a probability of profit.</p></details>`;
}
function renderResearchStatus(){
  const research=researchState||{},status=research.status||'idle',running=['collecting','running'].includes(status);
  $('research-status').textContent=researchState?({idle:'Ready',collecting:'Collecting data',running:'Simulating',complete:'Complete',failed:'Failed',cancelled:'Cancelled'})[status]||status:'Not loaded';
  $('research-status').className=`badge ${status==='complete'?'green':status==='failed'?'red':running?'blue':''}`;
  $('research-message').textContent=research.message||(running?'Historical analysis is in progress.':status==='complete'?'Historical analysis completed.':status==='failed'?'Research could not complete. Review the error and retry.':status==='cancelled'?'Research was cancelled.':state.connected?'Ready to collect historical data from the connected Zerodha account.':'Connect Zerodha to collect historical data.');
  const automation=research.automation;
  $('research-auto-note').textContent=automation?`${automation.reason||'Automatic research checks the connected account and available data.'}${automation.next_retry_at?` Next automatic check: ${dateLabel(automation.next_retry_at)}, ${clock(automation.next_retry_at)} IST.`:''}`:'When enabled in Settings, automatic research waits for account funds and market data, then retries temporary failures. No symbols or capital amounts need to be entered here.';
  const progress=numeric(research.progress);
  if(progress===null&&running)$('research-progress').removeAttribute('value');
  else $('research-progress').value=Math.max(0,Math.min(100,progress??0));
  $('research-progress-label').textContent=progress===null?'—':`${decimal(Math.max(0,Math.min(100,progress)),0)}%`;
  $('research-started').textContent=research.started_at?`Started ${dateLabel(research.started_at)} · ${clock(research.started_at)} IST`:'Not started';
  const completed=research.completed_at||research.finished_at;
  $('research-completed').textContent=completed?`Finished ${dateLabel(completed)} · ${clock(completed)} IST`:'';
  $('research-start').disabled=researchBusy||running||!state.connected;
  $('research-start').textContent=researchBusy?'Please wait…':research.report||research.result?'Run again':'Run analysis';
  const pendingRetry=['failed','cancelled'].includes(status)&&automation?.enabled&&['ready','waiting','retry_wait'].includes(automation.status);
  $('research-cancel').disabled=researchBusy||!(running||pendingRetry);
  $('research-refresh').disabled=researchBusy||!!researchLoading;
}
function renderResearchReport(){
  const primary=researchState?.report||researchState?.result;
  $('research-report').hidden=!primary;$('research-empty').hidden=!!primary;
  if(!primary)return;
  const choices=new Map([[primary.dataset?.interval||'primary',primary]]);
  for(const [key,report] of Object.entries(primary.alternate_reports||{}))if(report?.baseline&&report?.enhanced)choices.set(report.dataset?.interval||key,report);
  if(!choices.has(selectedResearchInterval))selectedResearchInterval=choices.keys().next().value;
  const report=choices.get(selectedResearchInterval);
  $('research-interval').innerHTML=[...choices.keys()].map(key=>`<option value="${escape(key)}" ${key===selectedResearchInterval?'selected':''}>${escape(key==='5minute'?'Intraday · 5-minute candles':key==='day'?'Swing · daily candles':key)}</option>`).join('');
  $('research-interval').value=selectedResearchInterval;$('research-interval').disabled=choices.size===1;
  $('research-interval-note').textContent=choices.size===1?'One strategy interval is included in this report.':'Each interval has its own sample, simulation and assumptions.';
  const metrics=[['initial_capital','Starting capital',money],['ending_equity','Ending equity',money],['net_pnl','Net P&L',money],['net_return_pct','Net return',value=>numeric(value)===null?'—':`${decimal(value)}%`],['trade_count','Closed trades',value=>decimal(value,0)],['win_rate_pct','Win rate',value=>numeric(value)===null?'—':`${decimal(value)}%`],['expectancy','Expectancy / trade',money],['profit_factor','Profit factor',decimal],['max_drawdown_pct','Maximum drawdown',value=>numeric(value)===null?'—':`${decimal(value)}%`],['costs_paid','Estimated costs',money],['open_positions','Open positions at end',value=>decimal(value,0)]];
  $('research-metrics-head').innerHTML='<tr><th>Metric</th><th>Baseline</th><th>Enhanced</th></tr>';
  $('research-metrics-body').innerHTML=metrics.map(([key,label,format])=>`<tr><td>${escape(label)}</td><td>${escape(format(report.baseline?.metrics?.[key]))}</td><td>${escape(format(report.enhanced?.metrics?.[key]))}</td></tr>`).join('');
  $('research-comparison-note').textContent=`${report.strategy_version?`${report.strategy_version} · `:''}${report.completed_at?`Report from ${dateLabel(report.completed_at)}, ${clock(report.completed_at)} IST. `:''}${['collecting','running'].includes(researchState?.status)?'Previous completed report shown while new research runs. ':''}Metrics describe this historical sample only. A higher return alone does not establish a safer or better strategy.`;
  const splits=[];
  for(const [strategy,label] of [['baseline','Baseline'],['enhanced','Enhanced']])for(const split of report[strategy]?.period_metrics||[]){
    const values=split.metrics||{};
    splits.push({name:split.name||'Period',from:split.from,to:split.to,label,values});
  }
  const order={train:0,validation:1,test:2};splits.sort((a,b)=>(order[a.name]??3)-(order[b.name]??3));
  const points=value=>numeric(value)===null?'—':`${decimal(value)}%`;
  $('research-splits').innerHTML=splits.map(row=>`<tr><td>${escape(row.name)}</td><td>${escape(dateLabel(row.from))} – ${escape(dateLabel(row.to))}</td><td>${row.label}</td><td>${decimal(row.values.trade_count,0)}</td><td>${points(row.values.net_return_pct)}</td><td>${points(row.values.max_drawdown_pct)}</td><td>${points(row.values.win_rate_pct)}</td></tr>`).join('')||empty(7,'No separate chronological periods were included in this report.');
  const dataset=report.dataset||{},metadata=report.metadata||{},range=`${dateLabel(dataset.from)} – ${dateLabel(dataset.to)}`;
  $('research-scope').innerHTML=[['Candle interval',dataset.interval??'—'],['Instruments',decimal(dataset.symbol_count,0)],['Candles',decimal(dataset.bar_count,0)],['Actual candle range',range],...(dataset.requested_from||dataset.requested_to?[['Requested range',`${dateLabel(dataset.requested_from)} – ${dateLabel(dataset.requested_to)}`]]:[]),...(numeric(dataset.session_count)!==null?[['Sessions',decimal(dataset.session_count,0)]]:[]),...(numeric(dataset.excluded_intraday_symbol_sessions)!==null?[['Excluded incomplete symbol-sessions',decimal(dataset.excluded_intraday_symbol_sessions,0)]]:[]),...(metadata.scope||dataset.strategy?[['Strategy scope',metadata.scope||dataset.strategy]]:[]),...(dataset.source||metadata.source?[['Source',dataset.source||metadata.source]]:[])].map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('');
  const symbols=dataset.symbols||dataset.instruments||[];
  $('research-symbols').innerHTML=symbols.length?symbols.map(item=>`<span class="badge">${escape(typeof item==='string'?item:item.symbol||item.tradingsymbol||'Unnamed instrument')}</span>`).join(''):'<p class="muted">The report does not list individual instruments.</p>';
  const assumptions=[metadata.selection,metadata.live_controls,'Profit factor is unavailable when there are no losing trades or no closed trades. Costs paid counts estimated fees; slippage is reflected in fill prices.',...(report.caveats||[]),...(report.baseline?.caveats||[]),...(report.enhanced?.caveats||[])].filter(Boolean);
  for(const [key,label] of [['baseline','Baseline'],['enhanced','Enhanced']]){
    const model=report[key]?.cost_model||{},options=report[key]?.options||{};
    if(numeric(model.fee_rate)!==null||numeric(model.slippage_rate)!==null)assumptions.push(`${label} execution assumptions: estimated fee ${percentage(model.fee_rate)} per fill; adverse slippage ${percentage(model.slippage_rate)} per fill.`);
    if(numeric(options.risk_per_trade_pct)!==null)assumptions.push(`${label} planned risk per trade: ${percentage(options.risk_per_trade_pct)}.`);
  }
  const notes=[...new Set(assumptions.map(item=>typeof item==='string'?item:JSON.stringify(item)).filter(Boolean))];
  $('research-assumptions').innerHTML=(notes.length?notes:['No additional assumptions were supplied in this report.']).map(item=>`<li>${escape(item)}</li>`).join('');
  const errors=[...(dataset.errors||[]),...(report.errors||[])];
  $('research-errors-panel').hidden=!errors.length;
  $('research-errors').innerHTML=errors.map(item=>`<li>${escape(typeof item==='string'?item:`${item.symbol||item.tradingsymbol||'Data'}: ${item.message||item.error||item.reason||JSON.stringify(item)}`)}</li>`).join('');
  const tradeRows=[],openRows=[],gapNotes=[];
  for(const [key,label] of [['baseline','Baseline'],['enhanced','Enhanced']]){
    const run=report[key]||{},trades=run.trades||[];
    for(const trade of trades.slice(-100))tradeRows.push(`<tr><td>${label}</td><td>${escape(trade.symbol)}</td><td>${entrySide(trade)}</td><td>${escape(String(trade.setup||'breakout').replaceAll('_',' '))}</td><td>${escape(`${dateLabel(trade.entry_time)} · ${clock(trade.entry_time)}`)}</td><td>${escape(`${dateLabel(trade.exit_time)} · ${clock(trade.exit_time)}`)}</td><td>${decimal(trade.quantity,0)}</td><td>${money(trade.entry)}</td><td>${money(trade.exit)}</td><td class="${positive(trade.pnl)}">${money(trade.pnl)}</td><td>${escape(String(trade.reason||'').replaceAll('_',' '))}</td></tr>`);
    for(const position of run.open_positions||[])openRows.push(`<tr><td>${label}</td><td>${escape(position.symbol)}</td><td>${entrySide(position)}</td><td>${decimal(position.quantity,0)}</td><td>${money(position.entry)}</td><td>${money(position.last)}</td><td>${money(position.stop)}</td><td>${money(position.target)}</td><td class="${positive(position.unrealised_pnl)}">${money(position.unrealised_pnl)}</td></tr>`);
    for(const [reason,count] of Object.entries(run.decisions||{}))if(/gap|ambiguous/i.test(reason)&&numeric(count)!==null&&count>0)gapNotes.push(`${label}: ${String(reason).replaceAll('_',' ')} — ${decimal(count,0)} recorded decision(s).`);
    const gapTrades=trades.filter(trade=>/gap|ambiguous/i.test(trade.reason||''));if(gapTrades.length)gapNotes.push(`${label}: ${gapTrades.length} retained exit(s) involve a price gap or ambiguous stop/target ordering. See their exit reasons above.`);
  }
  $('research-trades').innerHTML=tradeRows.join('')||empty(11,'No closed simulation trades are retained in this report.');
  $('research-open-positions').innerHTML=openRows.join('')||empty(9,'No open simulation positions are reported.');
  $('research-gap-notes').innerHTML=[...gapNotes,...(report.caveats||[]).filter(note=>/gap|missing|halt|suspension|intrabar/i.test(note)),...(gapNotes.length?[]:['No gap-related decision counts are supplied here. This does not establish that real execution would be gap-free.'])].map(note=>`<li>${escape(note)}</li>`).join('');
}
$('research-interval').addEventListener('change',()=>{selectedResearchInterval=$('research-interval').value;renderResearchReport();});
function stopResearchPolling(){clearTimeout(researchTimer);researchTimer=null;}
function scheduleResearchPolling(){
  stopResearchPolling();
  if(activePage==='research'&&document.visibilityState!=='hidden'&&csrf&&liveAllowed&&!researchBusy)researchTimer=setTimeout(()=>{researchTimer=null;loadResearch().catch(()=>{});},5000);
}
async function loadResearch(){
  if(researchLoading)return researchLoading;
  if(!csrf||!liveAllowed)return;
  stopResearchPolling();researchRequest=new AbortController();const request=researchRequest,timer=setTimeout(()=>request.abort(),10000);
  researchLoading=(async()=>{try{
    researchState=await api('/api/research','GET',undefined,{signal:request.signal});
    $('research-error').textContent=researchState.error||'';renderResearchReport();
  }catch(error){if(liveAllowed)$('research-error').textContent=error.name==='AbortError'?'Research status took too long to load. It will be checked again.':error.message;throw error;}
  finally{clearTimeout(timer);researchRequest=null;}})();
  renderResearchStatus();
  try{await researchLoading;}finally{researchLoading=null;renderResearchStatus();scheduleResearchPolling();}
}
async function researchAction(action){
  if(researchBusy||!csrf||!liveAllowed)return;
  if(action==='start'&&(!state.connected||['collecting','running'].includes(researchState?.status)))return;
  researchBusy=true;$('research-error').textContent='';stopResearchPolling();renderResearchStatus();
  try{
    // Finish the current status request before mutation so an older response
    // cannot replace the new run's state.
    if(researchLoading)await researchLoading.catch(()=>{});
    const result=await api(`/api/research/${action}`,'POST',{});
    if(result.status){researchState=result;renderResearchReport();}
    await loadResearch();
  }catch(error){$('research-error').textContent=error.message;}
  finally{researchBusy=false;renderResearchStatus();scheduleResearchPolling();}
}
$('research-refresh').addEventListener('click',()=>loadResearch().catch(()=>{}));
$('research-start').addEventListener('click',()=>researchAction('start'));
$('research-cancel').addEventListener('click',()=>researchAction('cancel'));
function renderActivity(){
  $('recent-activity').innerHTML=events.slice(-4).reverse().map(e=>`<div class="timeline-item"><span class="dot ${e.level==='error'?'red':e.level==='warning'?'amber':'green'}"></span><div><p>${escape(e.message)}</p></div><time>${escape(clock(e.timestamp))}</time></div>`).join('') || '<p class="empty-copy">Waiting for activity.</p>';
  if(activePage!=='activity') return;
  const search=$('event-search').value.toLowerCase(),level=$('event-level').value;
  const filtered=events.filter(e=>(!level||e.level===level)&&(!search||JSON.stringify(e).toLowerCase().includes(search)));
  $('activity-list').innerHTML=filtered.slice().reverse().map(e=>`<div class="audit-row"><div class="audit-heading"><time>${escape(new Date(e.timestamp).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short'}))} · ${escape(clock(e.timestamp))}</time>${badge(e.level,e.level==='error'?'red':e.level==='warning'?'amber':'blue')}<span class="audit-kind">${escape(e.kind)}</span></div><p>${escape(e.message)}</p>${Object.keys(e.data||{}).length?`<details><summary>View event details</summary><pre>${escape(JSON.stringify(e.data,null,2))}</pre></details>`:''}</div>`).join('')||'<div class="empty-cell">No events match this filter.</div>';
}
$('event-search').addEventListener('input',renderActivity);$('event-level').addEventListener('change',renderActivity);

function render(next){
  state=next;
  renderHoldingsAuthorization();
  renderReadiness();
  renderMarketContext();
  renderDecisionControls();
  renderResearchStatus();
  const paper=state.mode!=='live', connected=state.connected, running=state.status==='running', recovering=running&&state.recovery?.blocked,waitingFunds=running&&state.waiting_for_funds,waitingClock=running&&state.broker_clock&&(state.broker_clock.status!=='aligned'||state.broker_clock.stale||state.broker_clock.blocked);
  $('mode-pill').textContent=paper?'Paper trading':'Live trading';$('mode-pill').classList.toggle('live',!paper);
  if(state.restart_required)configRestartRequired=true;
  renderPaperTrading();
  $('equity-mode').textContent=paper?'PAPER':'LIVE';
  $('engine-status').textContent=waitingClock?'Waiting for clock verification':recovering?'Recovering account':waitingFunds?'Waiting for funds':({disconnected:'Disconnected',monitoring:'Monitoring',running:'Trading active',paused:'Entries paused',error:'Attention needed'})[state.status]||state.status||'Disconnected';
  $('engine-dot').className=`dot ${state.status==='error'?'red':recovering||waitingFunds||waitingClock?'amber':running?'green':connected?'amber':''}`;
  $('broker-dot').className=`dot ${connected?'green':''}`;$('broker-sidebar').textContent=connected?(state.user_id||'Connected'):'Not connected';
  $('market-state').textContent=state.market_open?(state.feed_fresh?'Market open':'Awaiting fresh market data'):'Outside market hours';
  $('account-ref').textContent=`Zerodha account · ${state.user_id||'—'}`;
  $('session-message').textContent=state.message || (connected?'Your account is connected. Monitoring continues when you close this page.':'Connect your Zerodha account to start monitoring.');
  $('start').disabled=busy||running||state.maintenance;
  $('start').innerHTML=waitingClock?'Checking system clock':recovering?'Checking account':waitingFunds?'Waiting for funds':running?'Trading active':`<span aria-hidden="true">▶</span> ${connected?'Resume trading':'Start Trading'}`;
  $('pause').disabled=busy||!connected||!running;
  $('flatten').disabled=busy||!connected||!(state.positions?.length||state.pending_orders?.length||state.delivery?.positions?.length);
  $('metric-equity').textContent=money(state.equity??state.capital,0);
  const pnl=Number(state.realised_pnl||0)+Number(state.unrealised_pnl||0);
  $('metric-pnl').textContent=money(pnl);$('metric-pnl').className=positive(pnl);
  $('pnl-detail').textContent=`Realised ${money(state.realised_pnl||0)}${state.pnl_fees_estimated?' · estimated costs':''}`;
  const margins=state.account?.margins||{};const funds=margins.equity||margins;
  const cash=funds.available?.live_balance??funds.available?.cash;
  $('metric-cash').textContent=connected||cash!==undefined?money(cash,0):'—';
  $('metric-positions').innerHTML=`${number(state.positions?.length)} <em>positions</em>`;
  $('positions-detail').textContent=`Planned stop risk ${money(state.risk_used||0,0)}`;
  $('scanner-total').textContent=number(state.universe_count);$('scanner-subs').textContent=number(state.subscribed_count);
  $('scanner-warm').textContent=number(state.warmed_count);$('scanner-swing').textContent=number(state.swing_warmed_count);
  $('scanner-heartbeat').textContent=clock(state.heartbeat);$('scanner-progress').style.width=`${Math.min(100,100*(state.subscribed_count||0)/Math.max(1,state.universe_count||0))}%`;
  const resources=state.resources||{},performance=state.performance||{};
  $('resource-cpu').textContent=`${Number(resources.cpu_percent||0).toFixed(1)}%`;
  $('resource-cores').textContent=`${number(resources.logical_cpus)} logical processors${resources.cpu_sampled_cpus<resources.logical_cpus?` · usage sample: ${number(resources.cpu_sampled_cpus)}`:''}`;
  $('resource-workers').title=resources.capacity_scope||'';
  $('resource-memory').textContent=`${Number(resources.memory_used_gib||0).toFixed(1)} GB`;
  $('resource-total').textContent=`of ${number(resources.memory_total_gib)} GB system memory`;
  $('resource-workers').textContent=`${number(performance.worker_limit)} workers`;
  $('resource-queue').textContent=`${number(performance.active_jobs)} active · ${number(performance.queue_depth)} queued`;
  $('resource-completed').textContent=number(performance.completed_jobs);
  $('resource-latency').textContent=performance.completed_jobs?`Latest batch ${Number(performance.analysis_ms||0).toFixed(1)} ms`:'Workers activate as data is ready';
  $('resource-disk-free').textContent=numeric(resources.disk_free_mib)===null?'—':`${decimal(resources.disk_free_mib/1024,1)} GiB`;
  $('resource-memory-free').textContent=numeric(resources.memory_free_mib)===null?'—':`${decimal(resources.memory_free_mib/1024,1)} GiB`;
  $('resource-loop-delay').textContent=numeric(resources.event_loop_delay_ms)===null?'—':`${decimal(resources.event_loop_delay_ms,1)} ms`;
  $('server-clock').textContent=`${clock(state.server_time)} IST`;$('footer-updated').textContent=`Updated ${clock(state.server_time)}`;
  const config=state.strategy_settings||{};
  $('strategy-cards').innerHTML=[['Intraday','intraday','Positions close during the trading day'],['Swing','swing','Positions may stay open overnight']].map(([name,key,desc])=>`<div class="strategy-item"><div><strong>${name}</strong><small>${escape(desc)}</small></div><div><strong>${money(config[`${key}_capital`]||0,0)}</strong><small>${badge(config[`${key}_enabled`]?'Enabled':'Disabled',config[`${key}_enabled`]?'green':'')}</small></div></div>`).join('');
  const warning=state.error||(state.maintenance?'Server maintenance is in progress. New entries are blocked.':!state.configured?'Setup needed: configure your Kite API credentials and Zerodha client ID on the server.':connected&&!state.account_fresh?'Account reconciliation is delayed. Check the activity log.':'');
  $('notice').textContent=warning;$('notice').hidden=!warning;$('notice').className=`notice ${state.error?'error':''}`;
  const recovery=state.recovery||{};
  $('recovery-status').textContent=recovery.message?`Account recovery: ${recovery.message}`:'';
  $('recovery-status').hidden=!recovery.message;
  $('recovery-status').className=`notice ${recovery.phase==='blocked'?'error':'subtle'}`;
  if(!settingsLoaded&&!settingsDirty&&state.strategy_settings){loadSettings();settingsLoaded=true;}
  const capital=state.capital??state.limits?.capital;
  $('allocation-limit').textContent=`Trading capital: ${money(capital,0)} · allocations follow available account funds`;
  $('position-subtitle').textContent=paper?'Simulated positions · real Zerodha holdings are shown separately':'Positions managed by StockPilot · broker fills are reconciled';
  if(connected&&Number.isFinite(Number(state.equity))&&Date.now()-lastChartAt>=30000){equityHistory.push({timestamp:state.server_time,equity:Number(state.equity)});equityHistory=equityHistory.slice(-180);lastChartAt=Date.now();drawChart();}
  renderTables();
}
function renderTables(){
  const positions=state.positions||[];
  $('positions-body').innerHTML=positions.map(p=>`<tr><td>${escape(p.symbol||p.tradingsymbol)}</td><td>${badge(p.strategy||'intraday','blue')}<div class="entry-side">${entrySide(p)}</div></td><td>${number(p.quantity)}</td><td>${money(p.entry)}</td><td>${money(p.last??p.last_price)}</td><td>${money(p.stop)}${p.protection_status?` ${badge(p.protection_status)}`:''}</td><td class="align-right ${positive(p.unrealised??p.unrealised_pnl)}">${money(p.unrealised??p.unrealised_pnl)}</td></tr>`).join('')||empty(7,state.connected?'No managed positions. The scanner waits for qualifying signals.':'Connect to Zerodha to begin monitoring.');
  const openedSignals=new Set([...document.querySelectorAll('#signals-body details[open]')].map(row=>row.dataset.signal));
  $('signals-body').innerHTML=(state.signals||[]).slice(0,8).map(s=>`<tr><td>${escape(clock(s.timestamp||s.time))}</td><td>${escape(s.symbol)}</td><td>${badge(s.strategy,'blue')}<div class="entry-side">${entrySide(s)}</div></td><td>${badge(String(s.status||'analysed').replaceAll('_',' '),s.status==='candidate'?'green':'')}</td><td class="signal-explanation"><span>${escape(s.reason)}</span>${signalMetrics(s,openedSignals)}</td></tr>`).join('')||empty(5,'Signals appear after complete candles pass the strategy checks. All decisions are recorded in the activity log.');
  if(activePage==='holdings'){
    const holdings=state.account?.holdings||[],analysis=state.holdings_signals||[];
    $('holdings-count').textContent=number(holdings.length);$('account-updated').textContent=`Account updated ${clock(state.account?.updated_at)}`;
    $('holdings-body').innerHTML=holdings.map(h=>{
      const q=Number(h.quantity||0)+Number(h.t1_quantity||0),pnl=(Number(h.last_price||0)-Number(h.average_price||0))*q;
      const signal=Array.isArray(analysis)?analysis.find(x=>x.symbol===h.tradingsymbol&&(!x.exchange||x.exchange===h.exchange)):analysis[h.tradingsymbol];
      const labels={exit_candidate:'Exit candidate',hold:'Hold',unsupported:'Unsupported',universe_unavailable:'Eligibility unavailable',history_unavailable:'No usable history',awaiting_market_data:'Waiting for market data',warming_up:'Waiting for daily history',analysing:'Analysing'};
      const managed=signal?.managed,label=signal?.action==='simulated_sell'?'Paper exit recorded':labels[signal?.status]||'Awaiting status';
      const reason=signal?.reason||(!state.connected?'Connect Zerodha to refresh holding analysis.':'Holding analysis status is not available yet.');
      return `<tr><td>${escape(h.tradingsymbol)}<small> · ${escape(h.exchange)}</small></td><td>${number(q)}</td><td>${money(h.average_price)}</td><td>${money(h.last_price)}</td><td>${money(q*Number(h.last_price||0),0)}</td><td class="${positive(pnl)}">${money(pnl)}</td><td class="signal-explanation">${badge(managed?'Managed':'Observe only',managed?'blue':'')} ${signal?.scope==='recovery_only'?badge('Exit only','amber')+' ':''}${badge(label,['exit_candidate','unsupported','history_unavailable','universe_unavailable'].includes(signal?.status)?'amber':'')}<div><small>${escape(reason)}${signal?.scope_reason?' '+escape(signal.scope_reason):''}</small></div></td></tr>`;
    }).join('')||empty(7,'No delivery holdings available. Connect to refresh your account.');
    const accountPositions=state.account?.positions?.net||[];
    $('account-positions-body').innerHTML=accountPositions.map(p=>`<tr><td>${escape(p.tradingsymbol)}</td><td>${badge(p.product)}</td><td>${number(p.quantity)}</td><td>${money(p.average_price)}</td><td>${money(p.last_price)}</td><td class="${positive(p.pnl)}">${money(p.pnl)}</td></tr>`).join('')||empty(6,'No account positions to display.');
  }
  if(activePage==='orders'){
    $('orders-body').innerHTML=(state.account?.orders||[]).slice().reverse().map(o=>`<tr><td>${escape(clock(o.order_timestamp))}</td><td>${escape(o.tradingsymbol)}</td><td>${badge(o.transaction_type,o.transaction_type==='BUY'?'green':'red')}</td><td>${escape(o.product)}</td><td>${number(o.filled_quantity)} / ${number(o.quantity)}</td><td>${money(o.average_price||o.price)}</td><td title="${escape(o.status_message||'')}">${badge(o.status,o.status==='COMPLETE'?'green':o.status==='REJECTED'?'red':'')}</td><td>${escape(o.order_id)}</td></tr>`).join('')||empty(8,'No Zerodha orders available for today. Paper orders appear in the activity log.');
    $('trades-body').innerHTML=(state.account?.trades||[]).slice().reverse().map(t=>`<tr><td>${escape(clock(t.fill_timestamp||t.exchange_timestamp))}</td><td>${escape(t.tradingsymbol)}</td><td>${badge(t.transaction_type,t.transaction_type==='BUY'?'green':'red')}</td><td>${number(t.quantity)}</td><td>${money(t.average_price)}</td><td>${escape(t.trade_id)}</td></tr>`).join('')||empty(6,'No executed Zerodha trades available for today.');
  }
  if(activePage==='activity')renderActivity();
}
function drawChart(){
  const points=equityHistory.filter(p=>Number.isFinite(Number(p.equity)));
  $('chart-empty').hidden=points.length>=2;
  if(points.length<2)return;
  let low=Math.min(...points.map(p=>p.equity)),high=Math.max(...points.map(p=>p.equity));
  const pad=Math.max((high-low)*.15,Math.max(Math.abs(high)*.0001,1));low-=pad;high+=pad;
  const coords=points.map((p,i)=>[i/(points.length-1)*800,200-(p.equity-low)/(high-low)*180]);
  const line=coords.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  $('chart-line').setAttribute('d',line);$('chart-area').setAttribute('d',`${line} L800,220 L0,220 Z`);
  $('chart-start').textContent=clock(points[0].timestamp);$('chart-end').textContent=clock(points.at(-1).timestamp);
  $('equity-chart').setAttribute('aria-label',`Trading equity from ${money(points[0].equity)} to ${money(points.at(-1).equity)}`);
}
function loadSettings(){
  const form=$('settings-form'),values=state.strategy_settings||{};
  for(const key of ['intraday_enabled','swing_enabled'])form.elements[key].checked=!!values[key];
  for(const [key,fallback] of [['intraday_allocation_pct',1],['swing_allocation_pct',0]])form.elements[key].value=Number(((values[key]??fallback)*100).toFixed(6));
  form.elements.manage_existing_holdings.value=values.manage_existing_holdings||'selected';
  form.elements.managed_symbols.value=(values.managed_symbols||[]).join(', ');
}
$('settings-form').addEventListener('input',()=>settingsDirty=true);
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;$('settings-error').textContent='';
  const values={intraday_enabled:form.elements.intraday_enabled.checked,swing_enabled:form.elements.swing_enabled.checked,intraday_allocation_pct:Number(form.elements.intraday_allocation_pct.value)/100,swing_allocation_pct:Number(form.elements.swing_allocation_pct.value)/100,manage_existing_holdings:form.elements.manage_existing_holdings.value,managed_symbols:form.elements.managed_symbols.value.toUpperCase().split(/[\s,]+/).filter(Boolean)};
  try{await api('/api/settings','PUT',values);settingsDirty=false;settingsLoaded=false;toast('Settings saved. They apply when trading starts.');await refresh();}catch(e){$('settings-error').textContent=e.message;}finally{button.disabled=false;}
});

// Configuration is deliberately separate from the live account render. Polls
// and SSE updates must never overwrite an administrator's unsaved edits.
function renderPaperTrading(){
  const paper=$('paper-trading').checked,disabledLive=!paper&&!paperModeDirty&&!savedExecution?.live_trading_enabled;
  $('paper-trading-current').textContent=state.mode?`Current mode: ${state.mode==='paper'?'Paper trading':'Live trading'}`:'Checking current mode.';
  $('paper-trading-description').textContent=paper?'Use live market data with simulated buys and sells.':disabledLive?'Paper trading is off. Real order execution is also disabled in your saved settings.':'Off selects live trading. Real buy and sell orders use your Zerodha funds.';
  $('paper-trading-state').textContent=configRestartRequired?(paperModeDirty?'Settings changed · restart required':'Saved · restart required'):paperModeDirty?`Unsaved · ${paper?'paper':'live'} trading`:disabledLive?'Live execution disabled':paper?'On · simulated orders':'Off · real orders';
  $('paper-trading-state').className='badge '+(paper?'blue':'amber');
  $('paper-trading-note').textContent=configRestartRequired?(paperModeDirty?'Your unsaved selection has not been saved. Restart the program to load the saved settings.':'Settings saved. Restart the program to apply the saved trading mode.'):disabledLive?'Your saved live mode has real execution disabled. Turn paper trading on to use simulation.':paperModeDirty?'Unsaved change. Save settings and restart the program to apply it.':'Save and restart to apply changes. Pause trading and resolve managed positions first.';
  const disabled=!configLoaded||configSaving||configRestartRequired;
  $('paper-trading').disabled=disabled;$('paper-trading-save').disabled=disabled;$('config-submit').disabled=disabled;
  for(const field of configFields){const input=$('config-form').elements[field.key];if(input)input.disabled=configSaving||configRestartRequired;}
}
function renderConfig(data){
  const automatic=new Set(['public_url','app_env','paper_capital','live_capital','admin_username','trading_mode','live_trading_enabled']);
  configFields=(data.fields||[]).filter(field=>!automatic.has(field.key));
  const values=data.values||{};
  savedExecution={trading_mode:values.trading_mode,live_trading_enabled:values.live_trading_enabled===true};
  $('paper-trading').checked=values.trading_mode==='paper';paperModeDirty=false;configRestartRequired=configRestartRequired||data.restart_required===true;
  $('config-fields').innerHTML=configFields.map(field=>{
    const id=`config-${field.key}`, value=values[field.key], label=escape(field.label||field.key);
    if(field.type==='checkbox')return `<div class="config-field config-checkbox"><label for="${escape(id)}">${label}</label><label class="switch"><input id="${escape(id)}" name="${escape(field.key)}" type="checkbox" ${value?'checked':''} aria-label="${label}"><span></span></label></div>`;
    if(field.type==='select')return `<div class="config-field"><label for="${escape(id)}">${label}</label><select id="${escape(id)}" name="${escape(field.key)}">${(field.choices||[]).map(choice=>`<option value="${escape(choice)}" ${choice===value?'selected':''}>${escape(choice)}</option>`).join('')}</select></div>`;
    const type=['number','time','url'].includes(field.type)?field.type:'text';
    const numeric=type==='number'?' step="any"':'';
    return `<div class="config-field"><label for="${escape(id)}">${label}</label><input id="${escape(id)}" name="${escape(field.key)}" type="${type}" value="${escape(value??'')}"${numeric} required></div>`;
  }).join('');
  for(const key of ['dashboard','redirect','postback'])$(`broker-url-${key}`).value=data.urls?.[key]||'';
  const admin=$('admin-form');
  if(!admin.dataset.dirty)admin.elements.username.value=data.admin_username||values.admin_username||'admin';
  configLoaded=true;$('paper-trading-error').textContent='';$('config-error').textContent='';
  renderPaperTrading();
}
function showConfigError(error){$('config-error').textContent=error.message;$('paper-trading-error').textContent=error.message;}
async function loadConfig(force=false){
  if(configLoading)return configLoading;
  if(configDirty||configLoaded&&!force)return;
  configLoading=(async()=>{const data=await api('/api/config');if(!configDirty)renderConfig(data);})();
  try{await configLoading;}finally{configLoading=null;}
}
$('config-form').addEventListener('input',()=>configDirty=true);
$('paper-trading').addEventListener('change',()=>{paperModeDirty=true;configDirty=true;$('paper-trading-error').textContent='';renderPaperTrading();});
$('config-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!configLoaded||configSaving||configRestartRequired)return;
  const form=event.currentTarget;configSaving=true;renderPaperTrading();$('config-error').textContent='';$('paper-trading-error').textContent='';$('config-message').textContent='';
  const values=Object.fromEntries(configFields.map(field=>{const input=form.elements[field.key];return [field.key,field.type==='checkbox'?input.checked:field.type==='number'?Number(input.value):input.value];}));
  // Unrelated edits must preserve an existing live-but-disabled configuration.
  if(paperModeDirty){const paper=$('paper-trading').checked;values.trading_mode=paper?'paper':'live';values.live_trading_enabled=!paper;}
  try{
    const result=await api('/api/config','PUT',values);configDirty=false;configRestartRequired=result.restart_required===true;
    $('config-message').textContent=result.message||'Application settings saved. Restart the program to apply them.';
    toast('Application settings saved. Restart the program to apply them.');
    await loadConfig(true);
  }catch(e){showConfigError(e);}finally{configSaving=false;renderPaperTrading();}
});
$('admin-form').addEventListener('input',event=>event.currentTarget.dataset.dirty='true');
$('admin-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;$('admin-error').textContent='';
  const values={current_password:form.elements.current_password.value,username:form.elements.username.value,password:form.elements.password.value,rotate_keys:form.elements.rotate_keys.checked};
  try{
    await api('/api/admin','PUT',values);liveAllowed=false;liveView?.stop();
    form.elements.current_password.value='';form.elements.password.value='';
    location.assign('/login?updated=1');
  }catch(e){$('admin-error').textContent=e.message;}finally{button.disabled=false;}
});
document.querySelectorAll('[data-copy-url]').forEach(button=>button.addEventListener('click',async()=>{
  const input=$(`broker-url-${button.dataset.copyUrl}`);
  if(!input.value)return;
  try{await navigator.clipboard.writeText(input.value);toast('URL copied.');}
  catch{input.focus();input.select();toast('URL selected. Copy it using your device’s copy command.');}
}));
function updateView(data){equityHistory=data.equity_history||equityHistory;render(data.state);addEvents(data.events);if(Number.isSafeInteger(data.event_cursor)&&data.event_cursor>=0)eventCursor=Math.max(eventCursor??0,data.event_cursor);if(data.equity_history)drawChart();}
function statePath(){return eventCursor===null?'/api/state':`/api/state?after=${eventCursor}`;}
async function refresh(){const request=new AbortController(),timer=setTimeout(()=>request.abort(),10000);try{updateView(await api(statePath(),'GET',undefined,{signal:request.signal}));}finally{clearTimeout(timer);}}
async function action(path){
  busy=true;render(state);
  try{const result=await api(path,'POST',{});if(result.redirect_url){location.assign(result.redirect_url);return;}await refresh();}catch(e){toast(e.message);}finally{busy=false;render(state);}
}
$('start').addEventListener('click',()=>action('/api/trading/start'));
$('pause').addEventListener('click',()=>action('/api/trading/pause'));
$('flatten').addEventListener('click',()=>{
  $('close-dialog').returnValue='cancel';
  $('close-description').textContent=`This pauses new entries and requests ${state.mode==='live'?'real':'simulated'} exits for positions managed by StockPilot. Unselected existing holdings are not included. Confirm execution in the activity log.`;
  $('close-dialog').showModal();
});
$('close-dialog').addEventListener('close',()=>{if($('close-dialog').returnValue==='confirm')action('/api/trading/flatten');});
$('logout').addEventListener('click',async()=>{liveAllowed=false;liveView?.stop();stopResearchPolling();researchRequest?.abort();try{await api('/api/logout','POST',{});location.assign('/login');}catch(e){toast(e.message);if(e.status!==401){liveAllowed=true;liveView?.start();scheduleResearchPolling();}}});
liveView=createLiveView({
  hostname:location.hostname,
  EventSource:globalThis.EventSource,
  after:()=>eventCursor??0,
  fetchState:options=>api(statePath(),'GET',undefined,options),
  onUpdate:updateView,
  onStatus:({text,color})=>{$('feed-state').innerHTML=`<span class="dot ${escape(color)}"></span> ${escape(text)}`;},
  onExpired:()=>{liveAllowed=false;stopResearchPolling();researchRequest?.abort();location.assign('/login?error=expired');},
});
window.addEventListener('pagehide',()=>{liveAllowed=false;liveView.stop();stopResearchPolling();researchRequest?.abort();});
window.addEventListener('pageshow',event=>{liveAllowed=true;if(event.persisted&&csrf){liveView.start();if(activePage==='research')loadResearch().catch(()=>{});}});
(async()=>{
  try{
    const session=await api('/api/session');csrf=session.csrf;
    loadConfig().catch(showConfigError);
    const error=new URLSearchParams(location.search).get('error');
    showPage(location.pathname==='/settings'?'settings':location.hash.slice(1)||'overview');
    try{await refresh();}finally{if(liveAllowed)liveView.start();}
    if(error)toast(({callback:'The Zerodha sign-in expired or failed its security check. Please try Start Trading again.',wrong_account:'The Zerodha client ID does not match the account configured on this server.',kite_login:'Zerodha sign-in was not completed.',start:'Your session could not start trading. Check the status and activity log.'})[error]||'Please reconnect to Zerodha.');
  }catch(e){toast(e.message);}
})();
