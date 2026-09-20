'use strict';
const $ = id => document.getElementById(id);
const money = (n, digits=2) => Number.isFinite(Number(n)) && n !== null && n !== undefined ? new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:digits}).format(Number(n)) : '—';
const number = n => new Intl.NumberFormat('en-IN').format(Number(n) || 0);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = value => {if(!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value).slice(-8) : d.toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});};
const positive = n => Number(n) < 0 ? 'negative' : Number(n) > 0 ? 'positive' : '';
const empty = (n,text) => `<tr><td colspan="${n}" class="empty-cell">${escape(text)}</td></tr>`;
let csrf='', state={}, events=[], eventCursor=null, equityHistory=[], liveView=null, liveAllowed=true, activePage='overview', settingsLoaded=false, settingsDirty=false, busy=false, lastChartAt=0, toastTimer;
let eventFloor=0,clearingActivity=false;
let configLoaded=false, configLoading=null, configDirty=false, configFields=[];
let paperModeDirty=false, savedExecution=null, configSaving=false, configRestartRequired=false;
let authorizationBusy=false, authorizationPending=false, authorizationWasRequired=false, authorizationLastCheck=0;
let researchState=null,researchLoading=null,researchBusy=false,researchTimer=null,researchRequest=null,researchRetryUnverified=false;
let selectedResearchInterval='';
const tuningApplicationsSeen=new Set();
const researchMarkup=new WeakMap(),tuningActiveRows=new Map();
let tuningApplyError='',tuningApplyErrorReportId=null;
let researchSettingsLoaded=false,researchSettingsLoading=null,researchSettingsDirty=false,researchSettingsBusy=false;
let startupLocal=null,startupLatest=null,startupRequestPending=false,startupRequestVersion=0,startupBaseline=null;
let startupDismissal=null;
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
  if(!response.ok){const error=new Error(typeof data.detail === 'string' ? data.detail : 'Please check your settings and try again.');error.status=response.status;throw error;}
  return data;
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function showPage(name){
  if(!['overview','holdings','orders','background','research','activity','settings'].includes(name)) name='overview';
  activePage=name;
  document.querySelectorAll('.page').forEach(p=>p.hidden=p.id!==`page-${name}`);
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===name));
  $('breadcrumb').textContent={overview:'Overview',holdings:'Holdings',orders:'Orders & trades',background:'Background work',research:'Strategy research',activity:'Activity log',settings:'Settings'}[name];
  history.replaceState(null,'',name==='settings'?'/settings':`/#${name}`);
  renderTables();
  if(name==='background')renderBackground();
  if(name==='settings'&&csrf)loadConfig().catch(showConfigError);
  if(name==='research'&&csrf){loadResearch().catch(()=>{});loadResearchSettings(true).catch(()=>{});}else stopResearchPolling();
}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));

function addEvents(rows){
  const known = new Set(events.map(e=>e.id));
  for(const row of rows||[]) if(Number.isSafeInteger(row.id)&&row.id>eventFloor&&!known.has(row.id)){events.push(row);known.add(row.id);}
  events.sort((a,b)=>a.id-b.id);events=events.slice(-500);
  if(events.length)eventCursor=Math.max(eventCursor??0,events.at(-1).id);
  renderActivity();
}
function badge(text, color=''){return `<span class="badge ${color}">${escape(text)}</span>`;}
function entrySide(row){const side=row.side??'BUY';return side==='BUY'?badge('BUY · Long','blue'):side==='SELL'?badge('SELL · Short','amber'):badge('Unknown side','red');}
function contextStatus(status){return ({fresh:'Fresh',stale:'Stale',partial:'Partial coverage',unavailable:'Unavailable',ready:'Sources ready',refreshing:'Refreshing',degraded:'Needs attention',closed:'Stopped'})[status]||String(status||'Unavailable').replaceAll('_',' ');}
function sourceBadge(status){return badge(contextStatus(status),status==='fresh'||status==='ready'?'green':['stale','partial','degraded'].includes(status)?'amber':'');}
function progressCounts(completed,total){
  completed=numeric(completed);total=numeric(total);
  return Number.isSafeInteger(completed)&&Number.isSafeInteger(total)&&completed>=0&&total>0&&completed<=total?{completed,total,percent:Math.floor(100*completed/total)}:null;
}
function startupState(){return startupLocal||startupLatest||state.startup||{status:'idle'};}
function startupAtLeastAsNew(candidate,previous){
  if(!previous)return true;
  if(candidate.lifecycle_id&&previous.lifecycle_id&&candidate.lifecycle_id!==previous.lifecycle_id)return true;
  if(Number.isSafeInteger(candidate.revision)&&Number.isSafeInteger(previous.revision))return candidate.revision>=previous.revision;
  if(candidate.started_at&&candidate.started_at!==previous.started_at)return true;
  const next=Date.parse(candidate.updated_at),before=Date.parse(previous.updated_at);
  return !Number.isFinite(next)||!Number.isFinite(before)||next>=before;
}
function updateStartupVisibility(startup){
  if(startup.status!=='complete'){
    clearTimeout(startupDismissal?.timer);startupDismissal=null;
    $('startup-card').hidden=!startup.status||startup.status==='idle';
    return;
  }
  const key=JSON.stringify([startup.lifecycle_id,startup.operation_id||startup.started_at||startup.finished_at||startup.updated_at]);
  if(startupDismissal?.key!==key){
    clearTimeout(startupDismissal?.timer);
    // Compare server timestamps so a different browser clock cannot keep old success messages visible.
    const age=Date.parse(state.server_time)-Date.parse(startup.finished_at),delay=Number.isFinite(age)?Math.max(0,5000-Math.max(0,age)):5000;
    const dismissal=startupDismissal={key,hidden:delay===0,timer:null};
    if(delay>0)dismissal.timer=setTimeout(()=>{
      if(startupDismissal!==dismissal)return;
      dismissal.hidden=true;$('startup-card').hidden=true;
    },delay);
  }
  $('startup-card').hidden=startupDismissal.hidden;
}
function renderStartup(){
  const incoming=state.startup;
  if(incoming&&startupAtLeastAsNew(incoming,startupLatest)){
    startupLatest=incoming;
    if(['requesting','start_request'].includes(startupLocal?.phase)&&(incoming.operation_id||incoming.started_at)&&(incoming.operation_id||incoming.started_at)!==startupBaseline&&incoming.status!=='idle')startupLocal=null;
    else if(startupLocal?.updated_at&&startupAtLeastAsNew(incoming,startupLocal))startupLocal=null;
  }
  const startup=startupState(),counts=progressCounts(startup.completed,startup.total),active=startup.status==='running';
  updateStartupVisibility(startup);
  $('startup-title').textContent=({running:'Starting trading session',complete:'Startup checks finished',failed:'Startup needs attention',cancelled:'Startup cancelled'})[startup.status]||'Trading startup';
  $('startup-status').textContent=({running:'In progress',complete:'Setup finished',failed:'Failed',cancelled:'Cancelled'})[startup.status]||'Waiting';
  $('startup-status').className=`badge ${startup.status==='failed'?'red':active?'blue':startup.status==='complete'?'green':''}`;
  $('startup-phase').textContent=({requesting:'Sending start request',cancelling:'Stopping startup',profile:'Checking broker identity',account:'Refreshing account',universe:'Verifying stock universe',stream:'Connecting live market data',recovery:'Reconciling account',start:'Checking trading setup'})[startup.phase]||String(startup.phase||'Waiting for the next step').replaceAll('_',' ');
  $('startup-message').textContent=startup.message||'Waiting for the server to report startup progress.';
  $('startup-progress').hidden=!counts;
  if(counts){$('startup-progress').max=counts.total;$('startup-progress').value=counts.completed;}
  $('startup-count').textContent=counts?`${number(counts.completed)} of ${number(counts.total)} steps · ${counts.percent}%`:active?'Waiting for reported step totals':'';
  $('startup-updated').textContent=startup.updated_at?`Updated ${clock(startup.updated_at)} IST`:'';
  $('startup-note').textContent='Startup progress describes connection and setup. History downloads continue in Background; clock, account recovery, funds and trade checks still apply.';
}
function renderBackground(){
  const background=state.background||{},tasks=Array.isArray(background.tasks)?background.tasks:[],performance=state.performance||{},resources=state.resources||{};
  $('background-tasks').innerHTML=tasks.map(task=>{
    const counts=progressCounts(task.completed,task.total),status=({running:'Running',waiting:'Waiting',idle:'Idle',failed:'Failed',stopped:'Stopped'})[task.status]||'Status unavailable';
    const progressLabel=task.progress_kind==='session_warmup'?'warmed up this session':'completed';
    const countText=counts?`${number(counts.completed)} of ${number(counts.total)} ${progressLabel} · ${counts.percent}%`:numeric(task.completed)!==null?`${number(task.completed)} ${progressLabel}`:'Progress totals not reported';
    return `<article class="background-task"><div class="background-task-heading"><h3>${escape(task.label||task.id||'Background task')}</h3>${badge(status,task.status==='failed'?'red':task.status==='running'?'blue':task.status==='waiting'?'amber':'')}</div><p>${escape(task.message||'No current task detail reported.')}</p>${task.current_item?`<div class="background-current">Current: <strong>${escape(task.current_item)}</strong></div>`:''}${counts?`<progress max="${counts.total}" value="${counts.completed}" aria-label="${escape(task.label||task.id||'Task')} progress"></progress>`:''}<div class="background-task-meta"><span>${escape(countText)}${numeric(task.failed)>0?` · ${number(task.failed)} failed`:''}</span>${task.updated_at?`<span>Updated ${escape(clock(task.updated_at))} IST</span>`:''}</div>${task.progress_kind==='session_warmup'?`<small>${number(task.ready)} currently loaded; ${number(Math.max(0,Number(task.total)-Number(task.ready)))} awaiting load or refresh. Successful warmups stay counted after feed gaps. Resets for a new trading day or changed stock universe.</small>`:''}${task.next_retry_at?`<small>Next retry ${escape(dateLabel(task.next_retry_at))} · ${escape(clock(task.next_retry_at))} IST</small>`:''}</article>`;
  }).join('')||'<p class="empty-copy">Background task details have not been reported yet. Connect and start to see each job as it runs.</p>';
  $('background-cpu').textContent=numeric(resources.cpu_percent)===null?'Not reported':`${decimal(resources.cpu_percent,1)}%`;
  $('background-workers').textContent=numeric(performance.worker_limit)===null?'Not reported':`${numeric(performance.live_workers)===null?'':`${number(performance.live_workers)} live / `}${number(performance.worker_limit)} capacity`;
  $('background-queue').textContent=numeric(performance.queue_depth)===null?'Not reported':`${number(performance.queue_depth)} queued analyses`;
  const activeBatches=performance.active_batch_count??performance.active_jobs;
  $('background-active').textContent=numeric(activeBatches)===null?'Not reported':`${number(activeBatches)} active batches`;
  $('background-completed').textContent=numeric(performance.completed_symbols)===null?'Not reported':`${number(performance.completed_symbols)} analyses completed`;
  const batches=Array.isArray(performance.active_batches)?performance.active_batches:[];
  $('background-batches').innerHTML=batches.map(batch=>`<li><strong>${escape((batch.symbols||[]).join(', ')||'Symbols not reported')}</strong><span>${escape((batch.strategies||[]).map(strategy=>String(strategy).replaceAll('_',' ')).join(', ')||'Strategy not reported')}${numeric(batch.symbol_count)!==null?` · ${number(batch.symbol_count)} analyses`:''}${batch.started_at?` · started ${escape(clock(batch.started_at))} IST`:''}</span></li>`).join('')||`<li class="muted">${numeric(activeBatches)>0?'Workers are active; batch symbols have not been reported.':'No active analytics batches reported. Workers wait for usable completed candles.'}</li>`;
  const research=background.research;
  observeTuningApplication(research?.tuning?.application).catch(showConfigError);
  const failure=researchFailure(research),retry=researchRetry(research),researchRunning=['running','collecting'].includes(research?.status);
  $('background-research-status').textContent=retry.waiting&&!researchRunning?(retry.rateLimited&&research?.automation?.status!=='retry_wait'?'API cooldown':'Waiting for retry'):research?String(research.status||'idle').replaceAll('_',' '):'Not reported';
  $('background-research-message').textContent=failure?.message||(!researchRunning&&research?.automation?.reason)||research?.message||'Open Research to view historical analysis and reports.';
  $('background-research-error').textContent=failure?researchIssueText(failure):'';
  const researchProgress=numeric(research?.progress),known=researchProgress!==null&&researchProgress>=0&&researchProgress<=100;
  $('background-research-progress').hidden=!known;
  if(known)$('background-research-progress').value=researchProgress;
  $('background-research-detail').textContent=[known?`${decimal(researchProgress,0)}% reported`:null,research?.started_at?`Started ${clock(research.started_at)} IST`:null,research?.completed_at?`Finished ${clock(research.completed_at)} IST`:null,retry.at?`Next retry ${dateLabel(retry.at)} · ${clock(retry.at)} IST`:null,research?.automation?.reason].filter(Boolean).join(' · ');
  const limits=state.api_limits,categories=Array.isArray(limits?.categories)?limits.categories:[],limited=categories.filter(category=>category.status==='cooldown'||numeric(category.rate_limited_responses)>0);
  $('background-api').hidden=!limited.length;
  $('background-api-title').textContent=limits?.status==='cooldown'?'Broker requests are cooling down':'Broker rate-limit history';
  $('background-api-message').textContent=limits?.status==='cooldown'?'Zerodha returned a request limit. The affected request category waits before trying again.':'No broker request cooldown is active. Counts below cover this broker session.';
  $('background-api-categories').innerHTML=limited.map(category=>`<li><strong>${escape(({historical:'Historical data',quote:'Quotes',orders:'Orders',other:'Other requests'})[category.category]||category.category)}</strong><span>${category.status==='cooldown'?`Waiting${category.retry_at?` until ${escape(clock(category.retry_at))} IST`:''}${numeric(category.retry_after_seconds)!==null?` · ${decimal(category.retry_after_seconds,0)} seconds remaining`:''}`:'Ready'} · ${number(category.rate_limited_responses)} rate-limit responses · ${number(category.blocked_requests)} requests deferred locally</span></li>`).join('');
}
function renderReadiness(){
  const readiness=state.readiness||{},checks=readiness.checks||[],labels={broker_session:'Broker session',system_clock:'System clock',equity_universe:'Stock & ETF eligibility',account_snapshot:'Account snapshot',reconciliation:'Account recovery',trading_cash:'Trading funds',market_session:'Market session',live_feed:'Live market feed',machine_capacity:'Machine capacity',maintenance:'Maintenance lock',entry_armed:'Trading armed'};
  const health=state.broker_clock;
  $('clock-status').hidden=!health||health.status==='aligned'&&!health.stale&&!health.blocked;
  if(health){
    const lower=numeric(health.offset_lower_ms),upper=numeric(health.offset_upper_ms),offset=lower===null||upper===null?null:(lower+upper)/2000;
    $('clock-status').textContent=health.blocked?`System clock needs synchronization${offset===null?'':`: approximately ${Math.round(Math.abs(offset))} seconds ${offset>0?'behind':'ahead of'} the broker`}. New entries wait. Synchronize this machine's operating-system clock; the program rechecks automatically after synchronization. Paused trading stays paused.`:'Waiting for a recent broker clock check. The program rechecks automatically. New entries wait; existing account monitoring continues.';
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
function researchFailure(research){return research?.error&&typeof research.error==='object'&&!Array.isArray(research.error)?research.error:null;}
function researchRetry(research){
  const category=(state.api_limits?.categories||[]).find(item=>item.category==='historical'),now=Date.parse(state.server_time)||Date.now();
  const times=[research?.cooldown?.next_retry_at,researchFailure(research)?.next_retry_at,research?.automation?.next_retry_at,category?.status==='cooldown'?category.retry_at:null].filter(value=>Number.isFinite(Date.parse(value))).sort((a,b)=>Date.parse(b)-Date.parse(a));
  return {at:times[0]||null,rateLimited:researchRetryUnverified||!!research?.cooldown||researchFailure(research)?.http_status===429||researchFailure(research)?.code==='rate_limit'||category?.status==='cooldown',waiting:researchRetryUnverified||!!(times.length&&Date.parse(times[0])>now)||category?.status==='cooldown'&&numeric(category.retry_after_seconds)>0};
}
function researchIssueText(issue){
  if(typeof issue==='string')return issue;
  return [issue?.symbol||issue?.tradingsymbol,issue?.message||issue?.reason||issue?.error,issue?.http_status?`HTTP ${issue.http_status}`:null,issue?.phase?`Phase: ${String(issue.phase).replaceAll('_',' ')}`:null,issue?.code?`Cause: ${String(issue.code).replaceAll('_',' ')}`:null].filter(Boolean).join(' · ');
}
function tuningParameterName(key){return ({min_signal_score:'Minimum evidence score',min_adx:'Minimum trend strength (ADX)',min_setup_volume:'Minimum relative volume',max_atr_extension:'Maximum ATR extension'})[key]||String(key).replaceAll('_',' ');}
const tuningParameterKeys=['min_signal_score','min_adx','min_setup_volume','max_atr_extension'];
function tuningSetLabel(trial,index){return trial?.parameter_set_id||`P${index+1}`;}
function tuningEffectiveParameters(trial,incumbent={}){const values=trial?.effective_parameters||{...incumbent,...trial?.parameters};return Object.fromEntries(tuningParameterKeys.map(key=>[key,values[key]??null]));}
function tuningPhaseLabel(phase){return ({tuning_train:'Training',tuning_validation:'Validation',tuning_test:'Final test',train:'Training',validation:'Validation',test:'Final test'})[phase]||String(phase||'Stage not reported').replaceAll('_',' ');}
function tuningMessage(text,trials=[]){return String(text||'').replace(/\b(incumbent|candidate_\d+)\b/g,id=>{const index=trials.findIndex(trial=>trial.id===id);return index>=0?tuningSetLabel(trials[index],index):id==='incumbent'?'P1':`P${Number(id.slice(10))+1}`;});}
function tuningTrialBadge(trial,applied=false){return trial.status==='error'?badge('Error','red'):applied?badge('Applied','green'):badge(trial.status==='final_test_pending'?'Waiting for final test':String(trial.status||'Pending').replaceAll('_',' '),trial.status==='accepted'?'green':['rejected','validation_failed','test_failed','final_test_pending'].includes(trial.status)?'amber':'');}
function tuningTrialExplanation(trial,trials){
  if(trial.status!=='error')return tuningMessage(trial.reason||'Evaluation is pending.',trials);
  const error=trial.error||{};
  return [error.phase?`Phase: ${tuningPhaseLabel(error.phase)}`:null,error.interval?({day:'Swing daily','5minute':'Intraday 5-minute'})[error.interval]||error.interval:null,`${error.code?`${String(error.code).replaceAll('_',' ')}: `:''}${error.message||trial.reason||'The candidate calculation failed.'}`].filter(Boolean).join(' · ');
}
function tuningSetTable(trials,optimization={},live=false){
  if(!trials.length)return '';
  const rows=trials.map((trial,index)=>{
    const id=tuningSetLabel(trial,index),values=tuningEffectiveParameters(trial,optimization.incumbent_parameters),application=optimization.application||{},eligible=!live&&!!optimization.report_id&&trial.status!=='error'&&trial.application_eligible===true;
    const disabled=researchBusy||!state.connected||['running','collecting'].includes(researchState?.status)||!eligible;
    const applied=application.status==='applied'&&application.parameter_set_id===id;
    const latest=['test','validation','train'].find(stage=>Object.keys(trial[stage]||{}).length),summary=latest?Object.entries(trial[latest]).map(([interval,stage])=>`${interval==='day'?'Swing':interval==='5minute'?'Intraday':interval} ${tuningPhaseLabel(latest).toLowerCase()}: ${numeric(stage.metrics?.net_return_pct)===null?'return not reported':`${decimal(stage.metrics.net_return_pct)}% net`} · ${numeric(stage.metrics?.trade_count)===null?'trades not reported':`${number(stage.metrics.trade_count)} trades`}`).join('; '):'No completed stage reported yet.';
    const reason=live?'Results update as workers finish each stage.':trial.status==='error'?'A set with a calculation error cannot be applied.':!optimization.report_id?'Run analysis again to enable selection for this older report.':trial.application_reason||(trial.application_eligible===true?'Completed saved set is available for manual selection.':'The server has not marked this set eligible for manual application.');
    return `<tr><th scope="row"><strong>${escape(id)}</strong>${index===0?'<small>Starting set</small>':''}</th>${Object.values(values).map(value=>`<td class="tuning-set-value">${escape(value??'Not reported')}</td>`).join('')}<td class="tuning-set-metrics">${escape(summary)}</td><td>${tuningTrialBadge(trial,applied)}<small>${escape(tuningTrialExplanation(trial,trials))}</small>${live?`<small>${escape(reason)}</small>`:''}</td>${!live?`<td><button class="button secondary small" type="button" data-apply-set="${escape(id)}" data-report-id="${escape(optimization.report_id||'')}" ${disabled?'disabled':''}>${researchBusy?'Please wait…':`Apply ${escape(id)}`}</button><small>${escape(reason)}</small></td>`:''}</tr>`;
  }).join('');
  return `<table class="tuning-set-table${live?' tuning-set-table-live':''}" aria-label="${live?'Parameter sets in progress':'Parameter sets'}"><thead><tr><th scope="col">Set</th>${tuningParameterKeys.map(key=>`<th scope="col" class="tuning-set-value">${escape(tuningParameterName(key))}</th>`).join('')}<th scope="col">Latest results</th><th scope="col">Status</th>${!live?'<th scope="col">Apply</th>':''}</tr></thead><tbody>${rows}</tbody></table>`;
}
async function observeTuningApplication(application){
  if(application?.status!=='applied'||!application.applied_at||tuningApplicationsSeen.has(application.applied_at))return;
  tuningApplicationsSeen.add(application.applied_at);if(tuningApplicationsSeen.size>32)tuningApplicationsSeen.delete(tuningApplicationsSeen.values().next().value);
  if(configDirty){$('config-message').textContent='Research updated strategy thresholds. Your unsaved settings are unchanged; review them before saving.';return;}
  if(!configLoaded&&!configLoading)return;
  const previouslyLoaded=configLoaded;configLoaded=false;
  try{if(configLoading)await configLoading.catch(()=>{});if(!configDirty)await loadConfig(true);}
  finally{if(configDirty){configLoaded=previouslyLoaded;$('config-message').textContent='Research updated strategy thresholds. Your unsaved settings are unchanged; review them before saving.';}}
}
function tuningMetricCell(stage){
  if(!stage||typeof stage!=='object')return '<span class="muted">Not evaluated</span>';
  const metrics=stage.metrics||{},quality=stage.data_quality||{},pct=value=>numeric(value)===null?'Not reported':`${decimal(value)}%`;
  return `<strong>${escape(pct(metrics.net_return_pct))} net</strong><small>${escape(pct(metrics.max_drawdown_pct))} drawdown<br>${numeric(metrics.trade_count)===null?'Trades not reported':`${number(metrics.trade_count)} trades`}</small>${quality.eligible===false||quality.completed_result===false?`<small class="negative">${escape(quality.reason||'Incomplete or ineligible data')}</small>`:''}`;
}
function affinityLocation(affinity){
  if(affinity?.cpu===null||affinity?.cpu===undefined)return 'Not reported';
  return [affinity.group!==null&&affinity.group!==undefined?`Group ${affinity.group}`:null,`CPU ${affinity.cpu}`].filter(Boolean).join(' · ');
}
function affinityStatus(affinity){
  if(affinity?.status==='pinned')return affinity.verified===true?'Verified pinned':'Pin not verified';
  return ({failed:'Pin failed',automatic:'Automatic scheduling',unsupported:'Pinning unsupported',unavailable:'Pinning unavailable'})[affinity?.status]||'Awaiting verification';
}
function setResearchMarkup(id,markup){
  const element=$(id);if(researchMarkup.get(element)===markup)return;
  element.innerHTML=markup;researchMarkup.set(element,markup);
}
function renderResearchAffinity(id,capacity,pool,active){
  const plan=capacity?.affinity,workers=Array.isArray(pool?.workers)?pool.workers:[],visible=active&&(!!plan||workers.length>0);
  const processes=id==='tuning-affinity'&&(numeric(capacity?.process_limit)!==null||numeric(pool?.process_limit)!==null||workers.some(worker=>numeric(worker.process_id)!==null));
  $(id).classList.toggle('research-process-affinity',processes);if(id==='tuning-affinity')$('tuning-affinity-identity').textContent=processes?'Process / thread':'Worker';
  $(id).hidden=!visible;
  if(!visible){$(`${id}-summary`).textContent='';setResearchMarkup(`${id}-workers`,'');$(`${id}-details`).hidden=true;return;}
  const currentWorkers=workers.filter(worker=>!['retiring','stopped'].includes(worker.state)),verified=currentWorkers.filter(worker=>worker.affinity?.status==='pinned'&&worker.affinity.verified===true).length,hasStates=workers.some(worker=>!!worker.state),retired=workers.length-currentWorkers.length;
  const mode=plan?.mode==='pinned'?'Pin workers to CPUs requested':plan?.mode==='automatic'?'Automatic scheduling requested':null;
  const noun=processes?'analytics threads':'workers',planStatus=({planned:`Pinning planned; each ${processes?'analytics thread':'worker'} must verify its assignment.`,automatic:`The operating system schedules these ${noun}.`,unsupported:'Pinning is unsupported; using automatic scheduling.',unavailable:'CPU pinning is unavailable; using automatic scheduling.'})[plan?.status];
  $(`${id}-summary`).textContent=[mode,workers.length?`${number(verified)} of ${number(currentWorkers.length)} ${hasStates?'current':'reported'} ${noun} verified pinned`:null,retired?`${number(retired)} retiring or stopped ${processes?'thread':'worker'} records`:null,planStatus,plan?.reason].filter(Boolean).join(' · ');
  $(`${id}-details`).hidden=!workers.length;
  setResearchMarkup(`${id}-workers`,workers.map(worker=>{const affinity=worker.affinity||{},verified=affinity.status==='pinned'&&affinity.verified===true,retired=['retiring','stopped'].includes(worker.state),workerState=({starting:'Starting',ready:'Ready',busy:'Busy',retiring:'Retiring',stopped:'Stopped'})[worker.state]||'Not reported',identity=processes?`PID ${worker.process_id??'not reported'} · Thread ${worker.worker_id??'not reported'}`:worker.worker_id??'Not reported';return `<tr><th scope="row">${escape(identity)}</th><td>${escape(workerState)}</td><td><span class="badge ${verified&&!retired?'green':affinity.status==='failed'?'red':'amber'}">${escape(retired&&verified?'Previously verified pinned':affinityStatus(affinity))}</span>${affinity.reason?`<small>${escape(affinity.reason)}</small>`:''}</td><td>${escape(affinityLocation(affinity))}${affinity.cpu!==null&&affinity.cpu!==undefined&&!verified?'<small>Reported assignment; pin not verified</small>':''}</td><td>${escape(affinity.core??'Not reported')}</td></tr>`;}).join(''));
}
function tuningActiveProgress(item){
  const label=`${item.parameter_set_id||'Set not reported'} · ${tuningPhaseLabel(item.phase)}`,progress=numeric(item.progress),known=progress!==null&&progress>=0&&progress<=1;
  const interval=item.interval?({day:'Swing daily','5minute':'Intraday 5-minute'})[item.interval]||item.interval:null;
  const intervalDetail=[interval,numeric(item.processed_bars)!==null&&numeric(item.total_bars)>0?`${number(item.processed_bars)} of ${number(item.total_bars)} bars`:null].filter(Boolean).join(' · ');
  const detail=[intervalDetail?`Current interval: ${intervalDetail}`:null,numeric(item.completed_intervals)!==null&&numeric(item.total_intervals)>0?`${number(item.completed_intervals)} of ${number(item.total_intervals)} intervals complete in this phase`:null].filter(Boolean).join(' · ');
  const worker=item.worker_id!==null&&item.worker_id!==undefined?`Worker ${item.worker_id}`:null,affinity=item.affinity;
  const process=numeric(item.process_id)!==null?`Process ${item.process_id}`:null,threads=[numeric(item.active_threads)!==null?`${number(item.active_threads)} active`:null,numeric(item.thread_limit)!==null?`${number(item.thread_limit)} capacity`:null].filter(Boolean).join(' / ');
  const assignment=(process||threads?[process,threads?`${threads} analytics threads`:null]:[worker,affinity?affinityStatus(affinity):null,affinity?.cpu!==null&&affinity?.cpu!==undefined?affinityLocation(affinity):null,affinity?.reason]).filter(Boolean).join(' · ');
  return {label,known,value:progress*100,percentage:`${tuningPhaseLabel(item.phase)} progress: ${known?`${decimal(Math.min(progress<1?99.9:100,progress*100),1)}%`:'Progress not reported'}`,assignment,assignmentClass:`tuning-worker-assignment${affinity?.status==='failed'?' negative':''}`,detail};
}
function renderTuningActiveSets(items){
  const list=$('tuning-active-sets'),keyOf=(item,index)=>JSON.stringify([item.parameter_set_id??index,item.phase??'']),keys=new Set(items.map(keyOf));
  for(const [key,{row}] of tuningActiveRows)if(!keys.has(key)){row.remove();tuningActiveRows.delete(key);}
  const text=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
  const attribute=(node,name,value)=>{if(value===null){if(node.hasAttribute(name))node.removeAttribute(name);}else if(node.getAttribute(name)!==String(value))node.setAttribute(name,value);};
  for(const [index,item] of items.entries()){
    const key=keyOf(item,index),view=tuningActiveProgress(item);
    let parts=tuningActiveRows.get(key);
    if(!parts){
      const create=tag=>document.createElement(tag),row=create('li'),heading=create('div'),title=create('strong'),percentage=create('span'),assignment=create('small'),bar=create('progress'),detail=create('small');
      heading.className='tuning-active-heading';heading.append(title,percentage);bar.setAttribute('max','100');row.append(heading,assignment,bar,detail);
      parts={row,title,percentage,assignment,bar,detail};tuningActiveRows.set(key,parts);
    }
    const {row,title,percentage,assignment,bar,detail}=parts;
    text(title,view.label);text(percentage,view.percentage);text(assignment,view.assignment);text(detail,view.detail);
    if(assignment.className!==view.assignmentClass)assignment.className=view.assignmentClass;
    assignment.hidden=!view.assignment;detail.hidden=!view.detail;
    attribute(bar,'aria-label',`${view.label} progress`);attribute(bar,'value',view.known?view.value:null);attribute(bar,'aria-valuetext',view.known?null:'Progress not reported');
    // Keep active nodes in place across polling and unrelated live-state updates.
    if(list.children[index]!==row)list.insertBefore(row,list.children[index]||null);
  }
}
function renderResearchTuning(){
  const research=researchState||{},tuning=research.tuning,primary=research.report||research.result;
  const optimization=primary?.optimization||tuning?.result,active=['running','collecting'].includes(research.status)&&!!tuning;
  $('research-tuning').hidden=!active&&!optimization;
  $('tuning-running').hidden=!active;$('tuning-result').hidden=!optimization;
  const verdicts={accepted:'Passed historical checks',no_improvement:'No validated improvement',completed_with_errors:'Completed with candidate errors',insufficient_data:'Not enough usable data',budget_exhausted:'Trial budget reached',waiting_for_fresh_data:'Waiting for fresh test dates',disabled:'Tuning disabled'};
  $('tuning-status').textContent=active?'Trials in progress':verdicts[optimization?.status]||'Result unavailable';
  $('tuning-status').className=`badge ${active?'blue':optimization?.status==='accepted'?'green':optimization?.status==='disabled'?'':'amber'}`;
  const phase=({tuning_train:'Training candidates',tuning_validation:'Validating candidates',tuning_test:'Checking the final test',train:'Training candidates',training:'Training candidates',validation:'Validating candidates',test:'Checking the final test',final_test:'Checking the final test',preparing:'Preparing trials',complete:'Trials complete'})[tuning?.phase]||String(tuning?.phase||'Waiting for trial details').replaceAll('_',' ');
  const trial=numeric(tuning?.trial),total=numeric(tuning?.trial_count);
  const phaseFinished=numeric(tuning?.parallelism?.completed_tasks),phaseSets=numeric(tuning?.parallelism?.total_tasks);
  $('tuning-phase').textContent=phaseFinished!==null&&phaseSets>0?`${phase} · ${number(phaseFinished)} of ${number(phaseSets)} sets finished in this phase`:[trial!==null&&trial>0?`Evaluation ${number(trial)}${total!==null&&total>0?` of ${number(total)}`:''}`:null,phase].filter(Boolean).join(' · ');
  const liveTrials=Array.isArray(tuning?.trials)?tuning.trials:[];
  $('tuning-message').textContent=tuningMessage(tuning?.message,liveTrials)||'Waiting for the server to report the current trial.';
  const parallel=tuning?.parallelism,activeSets=active&&Array.isArray(parallel?.active_sets)?parallel.active_sets:[];
  $('tuning-parallel').hidden=!active||!parallel;
  const memoryWaiting=active&&parallel?.memory_waiting===true;
  $('tuning-memory-status').hidden=!memoryWaiting;$('tuning-memory-status').textContent=memoryWaiting?({initializing:'Starting candidates in batches; running candidates continue.',free_memory:'Waiting for free RAM; running candidates continue.'})[parallel.memory_wait_reason]||'Waiting to start more candidates; running candidates continue.':'';
  const processMode=numeric(parallel?.process_limit)!==null||numeric(parallel?.active_processes)!==null||numeric(tuning?.capacity?.process_limit)!==null;
  const activeWorkers=numeric(processMode?parallel?.active_processes??parallel?.active_workers:parallel?.active_workers),workerLimit=numeric(processMode?parallel?.process_limit??tuning?.capacity?.process_limit??parallel?.worker_limit:parallel?.worker_limit);
  $('tuning-worker-counts').textContent=[activeWorkers!==null?`${number(activeWorkers)} active ${processMode?'candidate processes':'workers'}`:null,workerLimit!==null?`${number(workerLimit)} ${processMode?'process':'worker'} capacity`:null,processMode&&numeric(parallel?.active_threads)!==null?`${number(parallel.active_threads)} active analytics threads`:null,processMode&&numeric(parallel?.thread_limit??tuning?.capacity?.analytics_thread_limit)!==null?`${number(parallel?.thread_limit??tuning.capacity.analytics_thread_limit)} analytics thread capacity`:null,numeric(parallel?.completed_tasks)!==null?`${number(parallel.completed_tasks)}${numeric(parallel.total_tasks)!==null?` of ${number(parallel.total_tasks)}`:''} tasks completed${numeric(parallel.failed_tasks)!==null?` (${number(parallel.failed_tasks)} failed)`:''}`:numeric(parallel?.failed_tasks)!==null?`${number(parallel.failed_tasks)} tasks failed`:null].filter(Boolean).join(' · ');
  const capacity=tuning?.capacity,resourceLimits=processMode?[numeric(capacity?.physical_cpus)!==null?`Physical cores available: ${number(capacity.physical_cpus)}; up to one candidate process per core.`:null,numeric(capacity?.cpu_budget)!==null?capacity?.cpu_target_percent===100?`CPU eligibility: ${number(capacity.cpu_budget)} logical CPUs (100% allocation target, not a utilization guarantee).`:`Global CPU budget: ${number(capacity.cpu_budget)} logical CPUs shared by research and candidate coordinators and analytics threads.`:null,numeric(capacity?.threads_per_process)!==null?`Up to ${number(capacity.threads_per_process)} analytics threads per candidate process.`:null,numeric(capacity?.allocated_cpu_threads)!==null?`${number(capacity.allocated_cpu_threads)} planned coordinator and analytics threads share the eligible CPUs; thread counts are not core counts.`:null,numeric(capacity?.process_heap_mib)!==null?`Portfolio worker heap allowance: ${number(capacity.process_heap_mib)} MiB.`:null,numeric(capacity?.analytics_worker_heap_mib)!==null?`Analytics thread heap allowance: ${number(capacity.analytics_worker_heap_mib)} MiB.`:null,numeric(capacity?.process_relay_memory_mib)!==null?`Process relay memory reserve: ${number(capacity.process_relay_memory_mib)} MiB.`:null].filter(Boolean):[];
  if(processMode){
    const available=numeric(parallel?.available_memory_mib),reserve=numeric(parallel?.memory_reserve_mib??(capacity?.memory_policy==='pause_starts'?capacity.memory_reserve_mib:null));
    if(available!==null&&available>=0)resourceLimits.push(`Free RAM reported: ${number(available)} MiB.`);
    if(reserve!==null&&reserve>=0)resourceLimits.push(`Free RAM reserve: ${number(reserve)} MiB. Startup copies need additional memory.`);
    const startupMemory=numeric(parallel?.startup_memory_mib??capacity?.startup_memory_mib);if(startupMemory!==null&&startupMemory>=0)resourceLimits.push(`Startup memory allowance per new process: ${number(startupMemory)} MiB.`);
    if(numeric(parallel?.initializing_processes)!==null&&numeric(parallel?.max_initializing)!==null)resourceLimits.push(`Initializing processes: ${number(parallel.initializing_processes)} / ${number(parallel.max_initializing)} initialization limit.`);
  }
  $('tuning-resource-budget').hidden=!active||!resourceLimits.length;$('tuning-resource-details').textContent=resourceLimits.join(' ');
  renderTuningActiveSets(activeSets);
  renderResearchAffinity('tuning-affinity',tuning?.capacity,parallel,active);
  setResearchMarkup('tuning-live-sets',active?tuningSetTable(liveTrials,{},true):'');
  const finalTestSource=active?tuning:optimization,finalTestWaiting=!!finalTestSource&&(finalTestSource.final_test_allowed===false||!!finalTestSource.final_test_block||finalTestSource.status==='waiting_for_fresh_data');
  $('tuning-final-test-wait').hidden=!finalTestWaiting;
  const finalBlock=finalTestSource?.final_test_block||{},finalRanges=finalBlock.ranges||finalTestSource?.ranges||{};
  $('tuning-final-test-reason').textContent=finalBlock.reason||(finalTestSource?.status==='waiting_for_fresh_data'?finalTestSource.reason:null)||'Final testing requires a fresh, unused date window.';
  const blockedIntervals=Array.isArray(finalBlock.blocked_intervals)?finalBlock.blocked_intervals:Object.entries(finalBlock.consumed_test_dates||finalTestSource?.consumed_test_dates||{}).map(([interval,reserved_through])=>({interval,reserved_through,test_from:finalRanges[interval]?.test?.from,test_to:finalRanges[interval]?.test?.to}));
  $('tuning-final-test-dates').innerHTML=blockedIntervals.map(item=>`<div><dt>${escape(({day:'Swing','5minute':'Intraday'})[item.interval]||item.interval||'Interval not reported')}</dt><dd>${item.reserved_through?`<span>Reserved through: ${escape(dateLabel(item.reserved_through))}</span>`:''}${item.test_from||item.test_to?`<span>This run's final-test dates: ${escape(item.test_from?dateLabel(item.test_from):'Not reported')} – ${escape(item.test_to?dateLabel(item.test_to):'Not reported')}</span>`:''}</dd></div>`).join('');
  if(!optimization)return;
  $('tuning-report-note').textContent=['running','collecting'].includes(research.status)?'Previous completed tuning result is shown below while the new research run is in progress.':'The historical verdict and the settings application are reported separately.';
  if(numeric(optimization.failed_trials)>0)$('tuning-report-note').textContent+=` ${number(optimization.failed_trials)} candidate calculation error${optimization.failed_trials===1?'':'s'} recorded; other completed results remain available.`;
  $('tuning-verdict').textContent=verdicts[optimization.status]||String(optimization.status||'Result unavailable').replaceAll('_',' ');
  $('tuning-reason').textContent=optimization.reason||'No verdict explanation was reported.';
  const application=optimization.application||{};
  observeTuningApplication(application).catch(showConfigError);
  $('tuning-application').textContent=({applied:'Settings applied',not_applied:'Settings not applied',stale:'Candidate no longer current',disabled:'Automatic application disabled',waiting:'Waiting to apply settings'})[application.status]||'Application not reported';
  $('tuning-application').className=application.status==='applied'?'positive':'';
  $('tuning-application-reason').textContent=application.reason||'Historical acceptance alone does not confirm a settings change.';
  $('tuning-application-origin').textContent=[application.parameter_set_id,application.source==='manual'?'Manual selection':application.source==='automatic'?'Automatic selection':null].filter(Boolean).join(' · ');
  $('tuning-applied-at').textContent=application.applied_at?`Applied ${dateLabel(application.applied_at)} · ${clock(application.applied_at)} IST`:'';
  const trials=Array.isArray(optimization.trials)?optimization.trials:[],applicationTrial=trials.find((item,index)=>tuningSetLabel(item,index)===application.parameter_set_id);
  const parameters=applicationTrial?tuningEffectiveParameters(applicationTrial,optimization.incumbent_parameters):optimization.parameters||{},incumbent=optimization.incumbent_parameters||{},changes=Array.isArray(application.changes)?application.changes:[],keys=[...new Set([...Object.keys(parameters),...changes.map(change=>change.key)])];
  $('tuning-set-selection').hidden=!trials.length&&!finalTestWaiting&&optimization.status!=='waiting_for_fresh_data';setResearchMarkup('tuning-sets',tuningSetTable(trials,optimization));$('tuning-selection-help').hidden=!trials.length;
  $('tuning-selection-note').textContent=!trials.length?(active?'No parameter results were saved for the previous run. The new analysis is in progress.':'No parameter results were saved for this run. Run analysis again to generate training and validation evidence.'):optimization.report_id?'Manual selection applies the full saved set in the current execution mode, independently of the automatic-application switch.':'This older report has no selection identifier. Run analysis again before applying a set.';
  $('tuning-apply-error').textContent=tuningApplyErrorReportId===optimization.report_id?tuningApplyError:'';
  $('tuning-parameters-panel').hidden=!keys.length;
  $('tuning-parameters').innerHTML=keys.map(key=>{const change=changes.find(item=>item.key===key),before=change?.before??(application.status==='applied'?'Not reported':incumbent[key]),candidate=parameters[key]??change?.after,applied=application.status==='applied'?(change?.after??(applicationTrial?parameters[key]:null)??'Not reported'):'Not applied';return `<tr><td>${escape(tuningParameterName(key))}</td><td>${escape(before??'Not reported')}</td><td>${escape(candidate??'Not reported')}</td><td>${escape(applied)}</td></tr>`;}).join('');
  $('tuning-ranges').innerHTML=Object.entries(optimization.ranges||{}).flatMap(([interval,ranges])=>['train','validation','test'].filter(stage=>ranges?.[stage]).map(stage=>`<div><dt>${escape(({day:'Swing','5minute':'Intraday'})[interval]||interval)} · ${({train:'Training dates',validation:'Validation dates',test:'Final-test dates'})[stage]}</dt><dd>${escape(dateLabel(ranges[stage].from))} – ${escape(dateLabel(ranges[stage].to))}</dd></div>`)).join('');
  const limits=optimization.limits||{};
  $('tuning-limits').textContent=[numeric(limits.max_candidates)!==null?`Set limit: ${number(limits.max_candidates)}`:null,numeric(limits.max_runtime_ms)!==null?`Time budget: ${decimal(limits.max_runtime_ms/1000,0)} seconds`:null,numeric(optimization.elapsed_ms)!==null?`Elapsed: ${decimal(optimization.elapsed_ms/1000,1)} seconds`:null,optimization.holdout_consumed===true?'Final-test dates consumed; overlapping dates cannot be reused for automatic application.':null].filter(Boolean).join(' · ');
  $('tuning-trials-panel').hidden=!trials.length;$('tuning-trials-title').textContent=`Trial evidence (${number(trials.length)})`;
  $('tuning-trials').innerHTML=trials.flatMap((item,index)=>{
    const intervals=[...new Set(['train','validation','test'].flatMap(stage=>Object.keys(item[stage]||{})))];
    const trialParameters=tuningEffectiveParameters(item,incumbent);
    return (intervals.length?intervals:[null]).map(interval=>`<tr><td><strong>${escape(tuningSetLabel(item,index))}${item.id===optimization.selected_id?' · finalist':''}</strong><details><summary>All four parameters</summary><dl>${Object.entries(trialParameters).map(([key,value])=>`<div><dt>${escape(tuningParameterName(key))}</dt><dd>${escape(value??'Not reported')}</dd></div>`).join('')}</dl></details></td><td>${escape(({day:'Swing · daily', '5minute':'Intraday · 5-minute'})[interval]||interval||'Not reported')}</td>${['train','validation','test'].map(stage=>`<td>${tuningMetricCell(item[stage]?.[interval])}</td>`).join('')}<td>${tuningTrialBadge(item)}<small>${escape(tuningTrialExplanation(item,trials))}</small></td></tr>`);
  }).join('');
}
function researchCurrentTask(research){
  const task=research.current_task,phase=research.tuning?.phase,message=research.tuning?.message||research.message||'';
  const phaseTitle=({tuning_train:'Training parameter sets',train:'Training parameter sets',training:'Training parameter sets',tuning_validation:'Validating parameter sets',validation:'Validating parameter sets',tuning_test:'Final-testing parameter sets',test:'Final-testing parameter sets',final_test:'Final-testing parameter sets',preparing:'Preparing parameter evaluations'})[phase];
  const usefulMessage=message&&!/^(?:Historical analysis|Historical research|Research) is in progress\.?$/i.test(message);
  const title=task?.title||phaseTitle||(usefulMessage?message:research.status==='collecting'?'Collecting historical candles':'Research in progress');
  const reportedSets=research.tuning?.parallelism?.active_sets,active=Array.isArray(reportedSets)?reportedSets:[],sets=active.slice(0,4).map(item=>item.parameter_set_id).filter(Boolean);
  const detail=task?.detail||(message!==title&&usefulMessage?message:sets.length?`Active sets: ${sets.join(', ')}${active.length>sets.length?` and ${number(active.length-sets.length)} more`:''}.`:'Waiting for the next task update.');
  return {title,detail};
}
function renderResearchComparison(research){
  const comparison=research.comparison,active=research.status==='running'&&!!comparison&&!research.tuning?.phase&&['validating','baseline','enhanced'].includes(comparison.phase);
  $('research-comparison').hidden=!active;
  renderResearchAffinity('comparison-affinity',comparison?.capacity,comparison?.parallelism,active);
  $('research-comparison-title').textContent=({validating:'Preparing comparison workers',baseline:'Baseline comparison workers',enhanced:'Enhanced comparison workers'})[comparison?.phase]||'Comparison workers';
  if(!active){$('research-comparison-details').innerHTML='';$('research-comparison-candle-details').innerHTML='';$('research-comparison-candle').hidden=true;return;}
  const pool=comparison.parallelism||{},workers=numeric(pool.active_workers),limit=numeric(pool.worker_limit??comparison.capacity?.worker_limit),processed=numeric(comparison.processed_bars),total=numeric(comparison.total_bars),finished=numeric(pool.batch_completed_symbols),batchTotal=numeric(pool.batch_total_symbols);
  const workerText=[workers!==null?`${number(workers)} active`:null,limit!==null?`${number(limit)} capacity`:null].filter(Boolean).join(' / ');
  const counts=(done,count)=>done!==null&&count!==null&&count>0?`${number(done)} / ${number(count)}`:null;
  const timestamp=Number.isFinite(Date.parse(pool.batch_timestamp))?`${dateLabel(pool.batch_timestamp)} · ${clock(pool.batch_timestamp)} IST`:null;
  const details=[['Workers',workerText],['Stocks in comparison',numeric(comparison.symbol_count)!==null?number(comparison.symbol_count):null],['Interval',comparison.interval?({day:'Swing · daily','5minute':'Intraday · 5-minute'})[comparison.interval]||comparison.interval:null],['Candles processed in this pass',counts(processed,total)]];
  $('research-comparison-details').innerHTML=details.filter(([,value])=>value!==null&&value!=='').map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('');
  const candleDetails=[['Historical candle',timestamp],['Stock analyses at this candle',counts(finished,batchTotal)]].filter(([,value])=>value!==null&&value!=='');
  $('research-comparison-candle').hidden=!candleDetails.length;
  $('research-comparison-candle-details').innerHTML=candleDetails.map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('');
}
function renderResearchStatus(){
  const research=researchState||{},status=research.status||'idle',running=['collecting','running'].includes(status),failure=researchFailure(research),retry=researchRetry(research);
  const waiting=retry.waiting&&!running;
  $('research-status').textContent=waiting?(retry.rateLimited&&research.automation?.status!=='retry_wait'?'API cooldown':'Waiting for retry'):researchState?({idle:'Ready',collecting:'Collecting data',running:'Simulating',complete:'Complete',failed:'Failed',cancelled:'Cancelled'})[status]||status:'Not loaded';
  $('research-status').className=`badge ${waiting?'amber':status==='complete'?'green':status==='failed'?'red':running?'blue':''}`;
  const task=running?researchCurrentTask(research):null;
  $('research-current-task').textContent=task?.title||(waiting?'Waiting for research retry':({complete:'Research complete',failed:'Research needs attention',cancelled:'Research cancelled'})[status]||'Research run');
  $('research-message').textContent=failure?.message||task?.detail||research.message||(status==='complete'?'Historical analysis completed.':status==='failed'?'Research could not complete. Review the cause below.':status==='cancelled'?'Research was cancelled.':state.connected?'Ready to collect historical data from the connected Zerodha account.':'Connect Zerodha to collect historical data.');
  const automation=research.automation;
  $('research-auto-note').textContent=automation?`${automation.reason||'Automatic research checks the connected account and available data.'}${automation.next_retry_at?` Next automatic check: ${dateLabel(automation.next_retry_at)}, ${clock(automation.next_retry_at)} IST.`:''}`:'When enabled in Settings, automatic research waits for account funds and market data, then retries temporary failures. No symbols or capital amounts need to be entered here.';
  const progress=numeric(research.progress);
  if(progress===null&&running)$('research-progress').removeAttribute('value');
  else $('research-progress').value=Math.max(0,Math.min(100,progress??0));
  $('research-progress-label').textContent=progress===null?'Overall work: not reported':`Overall work: ${decimal(Math.max(0,Math.min(100,progress)),0)}%`;
  const progressDetail=running?research.progress_detail:null,stageProgress=numeric(progressDetail?.stage_progress),stageKnown=stageProgress!==null&&stageProgress>=0&&stageProgress<=100;
  $('research-progress-detail').hidden=!progressDetail;
  $('research-progress-detail').textContent=progressDetail?[`${progressDetail.stage||'Current stage'}${stageKnown?`: ${decimal(Math.min(stageProgress<100?99.9:100,stageProgress),1)}%`:''}`,numeric(progressDetail.completed)!==null&&numeric(progressDetail.total)>0?`${number(progressDetail.completed)} / ${number(progressDetail.total)} ${progressDetail.unit||'items'}`:null,stageKnown&&progressDetail.unit==='sets finished'?'Percentage includes work on active sets':null].filter(Boolean).join(' · '):'';
  renderResearchComparison(research);
  $('research-started').textContent=research.started_at?`Started ${dateLabel(research.started_at)} · ${clock(research.started_at)} IST`:'Not started';
  const completed=research.completed_at||research.finished_at;
  $('research-completed').textContent=completed?`Finished ${dateLabel(completed)} · ${clock(completed)} IST`:'';
  $('research-start').disabled=researchBusy||running||retry.waiting||!state.connected;
  $('research-start').textContent=researchBusy?'Please wait…':retry.waiting?'Waiting for retry':research.report||research.result?'Run again':'Run analysis';
  const pendingRetry=['failed','cancelled'].includes(status)&&automation?.enabled&&['ready','waiting','retry_wait'].includes(automation.status);
  const pendingApplication=(research.report||research.result)?.optimization?.application?.status==='waiting'||research.tuning?.application?.status==='waiting';
  $('research-cancel').disabled=researchBusy||!(running||pendingRetry||pendingApplication);
  $('research-cancel').textContent=pendingApplication&&!running?'Cancel queued change':'Cancel research';
  $('research-refresh').disabled=researchBusy||!!researchLoading;
  $('research-failure').hidden=!failure;
  $('research-failure-title').textContent=({rate_limit:'Zerodha request limit reached',authentication:'Zerodha connection needs renewal',permission:'Historical data access denied',network:'Broker connection unavailable',data_coverage:'Usable history is missing',worker:'Historical simulation could not finish',worker_timeout:'Historical simulation timed out',cpu_affinity:'Research CPU assignment failed',error:'Research could not complete'})[failure?.code]||'Research could not complete';
  $('research-failure-message').textContent=failure?.message||'';
  const runtime=numeric(failure?.runtime_budget_ms),processed=numeric(failure?.processed_bars),totalBars=numeric(failure?.total_bars);
  const timeLimit=runtime>0?(runtime>=60000?`${decimal(runtime/60000,1)} ${runtime===60000?'minute':'minutes'} (${number(runtime/1000)} seconds)`:`${decimal(runtime/1000,1)} seconds`):null;
  const candleCount=processed!==null&&processed>=0?`${number(processed)}${totalBars!==null&&totalBars>=0?` / ${number(totalBars)}`:''}`:null;
  const details=[['HTTP status',failure?.http_status],['Phase',failure?.phase?String(failure.phase).replaceAll('_',' '):null],['Stock / index',failure?.symbol],['Cause',failure?.code?String(failure.code).replaceAll('_',' '):null],['Time limit',timeLimit],['Candles processed',candleCount],['Timeout scope',({variant:'Single comparison pass',watchdog:'Combined comparison job'})[failure?.timeout_kind]]];
  $('research-failure-details').innerHTML=details.filter(([,value])=>value!==null&&value!==undefined&&value!=='').map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('');
  $('research-retry').hidden=!retry.at&&!failure&&!researchRetryUnverified;
  $('research-retry').textContent=researchRetryUnverified?'The start request was rate limited. Waiting for the server to confirm when retry is allowed; Refresh checks status without restarting research.':retry.at?`${research.automation?.enabled&&research.automation?.status==='retry_wait'?'Automatic retry scheduled':'Retry available'}: ${dateLabel(retry.at)} · ${clock(retry.at)} IST. ${retry.waiting?'Run analysis waits until this retry time. Refresh only checks saved status.':research.automation?.enabled?'The scheduler will recheck its requirements.':'Run analysis to try again.'}`:failure?.retryable===false?'Action is required before retrying. '+(research.automation?.reason||'Review the failure details above before running analysis again.'):failure?'The program will report a retry time when one is scheduled.':'';
  const issues=Array.isArray(research.issues)?research.issues:[];
  $('research-issues').hidden=!issues.length;$('research-issues-title').textContent=`Collection issues (${number(issues.length)})`;
  $('research-issues-list').innerHTML=issues.map(issue=>`<li>${escape(researchIssueText(issue))}</li>`).join('');
  renderResearchTuning();
  renderResearchSettings();
}
function researchSettingsLocked(){return ['running','collecting'].includes(researchState?.status)||(researchState?.report||researchState?.result)?.optimization?.application?.status==='waiting'||researchState?.tuning?.application?.status==='waiting'||state.maintenance||state.restart_required||configRestartRequired;}
function renderResearchSettings(){
  const disabled=!researchSettingsLoaded||researchSettingsBusy||researchBusy||researchSettingsLocked();
  $('research-sample-size').disabled=disabled;$('research-set-count').disabled=disabled;$('research-cpu-affinity').disabled=disabled;$('research-settings-save').disabled=disabled;
  $('research-settings-save').textContent=researchSettingsBusy?'Saving…':'Save research settings';
  if(researchSettingsLocked())$('research-settings-status').textContent='Wait for active research to finish, cancel any queued parameter change, and resolve a required restart before changing this scope.';
  else if(researchSettingsDirty)$('research-settings-status').textContent='Unsaved research settings. Save to use them on the next manual or automatic research run.';
  else if($('research-settings-status').textContent.startsWith('Wait for active research'))$('research-settings-status').textContent='Saved scope applies to the next manual or automatic research run.';
}
function acceptResearchSettings(values){
  if(!Number.isInteger(values?.research_symbols)||!Number.isInteger(values?.research_tuning_trials))return;
  researchSettingsLoaded=true;
  if(!researchSettingsDirty){$('research-sample-size').value=String(values.research_symbols);$('research-set-count').value=String(values.research_tuning_trials);$('research-cpu-affinity').value=values.research_cpu_affinity||'pinned';$('research-settings-status').textContent='Saved scope applies to the next manual or automatic research run. Save does not start a run immediately.';}
  renderResearchSettings();
}
async function loadResearchSettings(force=false){
  if(researchSettingsLoading)return researchSettingsLoading;
  if(!csrf||!liveAllowed||researchSettingsDirty||researchSettingsLoaded&&!force)return;
  researchSettingsLoading=(async()=>{try{const data=await api('/api/config');acceptResearchSettings(data.values);$('research-settings-error').textContent=researchSettingsLoaded?'':'Saved research settings were not reported.';}catch(error){$('research-settings-error').textContent=error.message;throw error;}finally{researchSettingsLoading=null;renderResearchSettings();}})();
  return researchSettingsLoading;
}
$('research-settings-form').addEventListener('input',()=>{researchSettingsDirty=true;renderResearchSettings();});
$('research-settings-form').addEventListener('submit',async event=>{
  event.preventDefault();if(researchSettingsBusy||researchBusy||!researchSettingsLoaded||researchSettingsLocked()||!csrf||!liveAllowed)return;
  const values={research_symbols:Number($('research-sample-size').value),research_tuning_trials:Number($('research-set-count').value),research_cpu_affinity:$('research-cpu-affinity').value};
  if(!Number.isInteger(values.research_symbols)||values.research_symbols<1||values.research_symbols>150||!Number.isInteger(values.research_tuning_trials)||values.research_tuning_trials<3||values.research_tuning_trials>100){$('research-settings-error').textContent='Choose 1–150 stocks and 3–100 parameter sets, using whole numbers.';return;}
  if(!['pinned','automatic'].includes(values.research_cpu_affinity)){$('research-settings-error').textContent='Choose Pin workers to CPUs or Automatic scheduling.';return;}
  researchSettingsBusy=true;researchBusy=true;$('research-settings-error').textContent='';renderResearchStatus();
  try{
    if(researchLoading)await researchLoading.catch(()=>{});
    if(researchSettingsLocked())return;
    const result=await api('/api/research/settings','PUT',values);researchSettingsDirty=false;acceptResearchSettings(result.settings);
    const optimization=(researchState?.report||researchState?.result)?.optimization;for(const trial of optimization?.trials||[])Object.assign(trial,{application_eligible:false,application_reason:'Research settings changed. Refresh status before selecting a saved set.'});
    if(configDirty)$('config-message').textContent='Research scope changed. Your unsaved Settings form is unchanged; review its research values before saving.';
    else if(configLoaded){configLoaded=false;loadConfig(true).catch(showConfigError);}
    await loadResearch().catch(()=>{});$('research-settings-status').textContent='Research settings saved for the next manual or automatic run. Select Run analysis to request it now.';
  }catch(error){$('research-settings-error').textContent=error.message;}
  finally{researchSettingsBusy=false;researchBusy=false;renderResearchStatus();}
});
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
  const diversification=metadata.diversification;
  $('research-diversification').hidden=!diversification;
  if(diversification){
    const actual=new Set(symbols.map(item=>typeof item==='string'?item:item.symbol||item.tradingsymbol).filter(Boolean));
    const members=Array.isArray(diversification.members)?diversification.members:[],reported=Array.isArray(dataset.symbols)||Array.isArray(dataset.instruments),included=reported?members.filter(item=>actual.has(item.symbol)):[];
    const classified=included.filter(item=>item.industry&&item.classification_status==='fresh'),industries=new Map();
    for(const item of classified){const group=industries.get(item.industry)||[];group.push(item.symbol);industries.set(item.industry,group);}
    const known=new Set(classified.map(item=>item.symbol)),unclassified=[...actual].filter(symbol=>!known.has(symbol));
    $('research-diversification-status').textContent=({diversified:'Industry sample selected',limited:'Limited industry coverage',unclassified:'Classification unavailable'})[diversification.status]||'Coverage reported';
    $('research-diversification-status').className=`badge ${diversification.status==='diversified'?'blue':'amber'}`;
    $('research-diversification-summary').textContent=[numeric(diversification.requested_count)!==null?`${number(diversification.requested_count)} requested`:null,numeric(diversification.selected_count)!==null?`${number(diversification.selected_count)} selected`:null,reported?`${number(actual.size)} instruments in this report across ${number(industries.size)} classified industries`:'Actual report instruments were not listed'].filter(Boolean).join(' · ');
    $('research-industries').innerHTML=[...industries].map(([industry,names])=>`<div><dt>${escape(industry)}</dt><dd>${names.map(escape).join(', ')}</dd></div>`).join('');
    $('research-unclassified').textContent=unclassified.length?`Unclassified in this report: ${unclassified.join(', ')}. These instruments do not establish industry coverage.`:reported?(actual.size?'Every reported instrument has a fresh industry classification.':'No usable report instruments were returned.'):'Industry groups will appear when actual report instruments are available.';
    $('research-diversification-caveat').textContent=diversification.caveat||'The sample spreads across available verified industry groups; it is not selected using past returns. Missing history can reduce actual coverage.';
  }
  const assumptions=[metadata.selection,metadata.live_controls,'Profit factor is unavailable when there are no losing trades or no closed trades. Costs paid counts estimated fees; slippage is reflected in fill prices.',...(report.caveats||[]),...(report.baseline?.caveats||[]),...(report.enhanced?.caveats||[])].filter(Boolean);
  for(const [key,label] of [['baseline','Baseline'],['enhanced','Enhanced']]){
    const model=report[key]?.cost_model||{},options=report[key]?.options||{};
    if(numeric(model.fee_rate)!==null||numeric(model.slippage_rate)!==null)assumptions.push(`${label} execution assumptions: estimated fee ${percentage(model.fee_rate)} per fill; adverse slippage ${percentage(model.slippage_rate)} per fill.`);
    if(numeric(options.risk_per_trade_pct)!==null)assumptions.push(`${label} planned risk per trade: ${percentage(options.risk_per_trade_pct)}.`);
  }
  const notes=[...new Set(assumptions.map(item=>typeof item==='string'?item:JSON.stringify(item)).filter(Boolean))];
  $('research-assumptions').innerHTML=(notes.length?notes:['No additional assumptions were supplied in this report.']).map(item=>`<li>${escape(item)}</li>`).join('');
  const errors=[...(dataset.errors||[]),...(report.errors||[]),...(report.metadata?.issues||[])];
  $('research-errors-panel').hidden=!errors.length;
  $('research-errors').innerHTML=errors.map(item=>`<li>${escape(typeof item==='string'?item:(!item.http_status&&!item.code?`${item.symbol||item.tradingsymbol||'Data'}: ${item.message||item.error||item.reason||JSON.stringify(item)}`:researchIssueText(item)))}</li>`).join('');
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
  if(activePage==='research'&&document.visibilityState!=='hidden'&&csrf&&liveAllowed&&!researchBusy)researchTimer=setTimeout(()=>{researchTimer=null;loadResearch().catch(()=>{});},['collecting','running'].includes(researchState?.status)?2000:5000);
}
async function loadResearch(){
  if(researchLoading)return researchLoading;
  if(!csrf||!liveAllowed)return;
  stopResearchPolling();researchRequest=new AbortController();const request=researchRequest,timer=setTimeout(()=>request.abort(),10000);
  researchLoading=(async()=>{try{
    researchState=await api('/api/research','GET',undefined,{signal:request.signal});researchRetryUnverified=false;
    $('research-error').textContent=typeof researchState.error==='string'?researchState.error:'';renderResearchReport();
  }catch(error){if(liveAllowed)$('research-error').textContent=error.name==='AbortError'?'Research status took too long to load. It will be checked again.':error.message;throw error;}
  finally{clearTimeout(timer);researchRequest=null;}})();
  renderResearchStatus();
  try{await researchLoading;}finally{researchLoading=null;renderResearchStatus();scheduleResearchPolling();}
}
async function researchAction(action){
  if(researchBusy||!csrf||!liveAllowed)return;
  if(action==='start'&&(!state.connected||['collecting','running'].includes(researchState?.status)||researchRetry(researchState).waiting))return;
  researchBusy=true;$('research-error').textContent='';stopResearchPolling();renderResearchStatus();
  try{
    // Finish the current status request before mutation so an older response
    // cannot replace the new run's state.
    if(researchLoading)await researchLoading.catch(()=>{});
    if(action==='start'&&researchRetry(researchState).waiting)return;
    const result=await api(`/api/research/${action}`,'POST',{});
    if(result.status){researchState=result;renderResearchReport();}
    await loadResearch();
  }catch(error){$('research-error').textContent=error.message;if(error.status===429){researchRetryUnverified=true;await loadResearch().catch(()=>{});}}
  finally{researchBusy=false;renderResearchStatus();scheduleResearchPolling();}
}
$('research-refresh').addEventListener('click',()=>{loadResearch().catch(()=>{});loadResearchSettings(true).catch(()=>{});});
$('research-start').addEventListener('click',()=>researchAction('start'));
$('research-cancel').addEventListener('click',()=>researchAction('cancel'));
async function applyResearchSet(reportId,parameterSetId){
  const eligible=()=>{const optimization=(researchState?.report||researchState?.result)?.optimization;return !!reportId&&optimization?.report_id===reportId&&optimization.trials?.some((trial,index)=>tuningSetLabel(trial,index)===parameterSetId&&trial.status!=='error'&&trial.application_eligible===true);};
  if(researchBusy||!csrf||!liveAllowed||!state.connected||['running','collecting'].includes(researchState?.status)||!eligible())return;
  researchBusy=true;tuningApplyError='';tuningApplyErrorReportId=reportId;stopResearchPolling();renderResearchStatus();
  try{
    if(researchLoading)await researchLoading.catch(()=>{});
    if(['running','collecting'].includes(researchState?.status)||!eligible())return;
    researchState=await api('/api/research/apply','POST',{report_id:reportId,parameter_set_id:parameterSetId});
    renderResearchReport();await loadResearch();
  }catch(error){tuningApplyError=error.message;}
  finally{researchBusy=false;renderResearchStatus();scheduleResearchPolling();}
}
$('tuning-sets').addEventListener('click',event=>{const button=event.target.closest('[data-apply-set]');if(button&&!button.disabled)applyResearchSet(button.dataset.reportId,button.dataset.applySet);});
function renderActivity(){
  $('clear-activity').disabled=clearingActivity;
  $('recent-activity').innerHTML=events.slice(-4).reverse().map(e=>`<div class="timeline-item"><span class="dot ${e.level==='error'?'red':e.level==='warning'?'amber':'green'}"></span><div><p>${escape(e.message)}</p></div><time>${escape(clock(e.timestamp))}</time></div>`).join('') || '<p class="empty-copy">Waiting for activity.</p>';
  if(activePage!=='activity') return;
  const search=$('event-search').value.toLowerCase(),level=$('event-level').value;
  const filtered=events.filter(e=>(!level||e.level===level)&&(!search||JSON.stringify(e).toLowerCase().includes(search)));
  $('activity-list').innerHTML=filtered.slice().reverse().map(e=>`<div class="audit-row"><div class="audit-heading"><time>${escape(new Date(e.timestamp).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short'}))} · ${escape(clock(e.timestamp))}</time>${badge(e.level,e.level==='error'?'red':e.level==='warning'?'amber':'blue')}<span class="audit-kind">${escape(e.kind)}</span></div><p>${escape(e.message)}</p>${activityHelpMarkup(e.help)}${Object.keys(e.data||{}).length?`<details><summary>View event details</summary><pre>${escape(JSON.stringify(e.data,null,2))}</pre></details>`:''}</div>`).join('')||(events.length?'<div class="empty-cell">No events match this filter.</div>':'<div class="empty-cell">Activity log is empty. New events will appear here.</div>');
}
$('event-search').addEventListener('input',renderActivity);$('event-level').addEventListener('change',renderActivity);

function applyEventFloor(floor){
  if(!Number.isSafeInteger(floor)||floor<eventFloor)return;
  eventFloor=floor;events=events.filter(event=>event.id>eventFloor);
  eventCursor=Math.max(eventCursor??0,eventFloor);
}
async function clearActivity(){
  if(clearingActivity)return;
  clearingActivity=true;renderActivity();$('activity-error').textContent='';
  try{
    const result=await api('/api/events','DELETE',{});
    if(!Number.isSafeInteger(result.event_floor)||result.event_floor<0)throw new Error('The server did not confirm which entries were cleared. Refresh Activity before trying again.');
    applyEventFloor(result.event_floor);renderActivity();toast('Activity history cleared. Trading records and settings are unchanged.');
  }catch(error){$('activity-error').textContent=error.message;}
  finally{clearingActivity=false;renderActivity();}
}
$('clear-activity').addEventListener('click',clearActivity);

function activityHelpMarkup(help){
  if(!help||!Array.isArray(help.steps)||!help.steps.length)return '';
  const links=(help.links||[]).map(link=>{
    if(['overview','settings','background','research','holdings','orders'].includes(link.page))
      return `<button type="button" class="text-button" data-help-page="${escape(link.page)}" data-help-target="${escape(link.target||'')}">${escape(link.label)}</button>`;
    try{const url=new URL(link.url);if(url.protocol==='https:'&&['developers.kite.trade','support.zerodha.com','kite.zerodha.com'].includes(url.hostname))return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(link.label)}</a>`;}catch{}
    return '';
  }).join('');
  return `<div class="activity-help"><strong>What to check</strong><ul>${help.steps.map(step=>`<li>${escape(step)}</li>`).join('')}</ul>${links?`<div class="activity-help-links">${links}</div>`:''}</div>`;
}
async function openActivityHelp(event){
  const button=event.target.closest('[data-help-page]');if(!button)return;
  showPage(button.dataset.helpPage);
  if(button.dataset.helpPage==='settings')try{await loadConfig();}catch{}
  const target=$(button.dataset.helpTarget);
  target?.scrollIntoView?.({block:'center',behavior:'smooth'});target?.focus?.({preventScroll:true});
}
$('activity-list').addEventListener('click',openActivityHelp);
$('error-help').addEventListener('click',openActivityHelp);

function render(next){
  state=next;
  renderStartup();renderBackground();
  renderHoldingsAuthorization();
  renderReadiness();
  renderMarketContext();
  renderDecisionControls();
  renderResearchStatus();
  const paper=state.mode!=='live', connected=state.connected, running=state.status==='running', recovering=running&&state.recovery?.blocked,waitingFunds=running&&state.waiting_for_funds,waitingClock=running&&state.broker_clock&&(state.broker_clock.status!=='aligned'||state.broker_clock.stale||state.broker_clock.blocked);
  const clockSkewed=waitingClock&&state.broker_clock.blocked;
  const starting=startupRequestPending||startupState().status==='running';
  $('mode-pill').textContent=paper?'Paper trading':'Live trading';$('mode-pill').classList.toggle('live',!paper);
  if(state.restart_required)configRestartRequired=true;
  renderPaperTrading();
  $('equity-mode').textContent=paper?'PAPER':'LIVE';
  $('engine-status').textContent=clockSkewed?'Clock synchronization required':waitingClock?'Waiting for clock verification':starting?'Startup in progress':recovering?'Recovering account':waitingFunds?'Waiting for funds':({disconnected:'Disconnected',monitoring:'Monitoring',running:'Trading active',paused:'Entries paused',error:'Attention needed'})[state.status]||state.status||'Disconnected';
  $('engine-dot').className=`dot ${state.status==='error'?'red':starting||recovering||waitingFunds||waitingClock?'amber':running?'green':connected?'amber':''}`;
  $('broker-dot').className=`dot ${connected?'green':''}`;$('broker-sidebar').textContent=connected?(state.user_id||'Connected'):'Not connected';
  $('market-state').textContent=state.market_open?(state.feed_fresh?'Market open':'Awaiting fresh market data'):'Outside market hours';
  $('account-ref').textContent=`Zerodha account · ${state.user_id||'—'}`;
  $('session-message').textContent=state.message || (connected?'Your account is connected. Monitoring continues when you close this page.':'Connect your Zerodha account to start monitoring.');
  $('start').disabled=busy||starting||running||state.maintenance;
  $('start').innerHTML=starting?'Starting…':clockSkewed?'Clock out of sync':waitingClock?'Checking system clock':recovering?'Checking account':waitingFunds?'Waiting for funds':running?'Trading active':`<span aria-hidden="true">▶</span> ${connected?'Resume trading':'Start Trading'}`;
  $('pause').disabled=busy||(!starting&&(!connected||!running));
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
  $('settings-note').textContent=state.settings_blocker?.message||(state.mode==='paper'?'Settings can be saved while paper trading is paused. Existing simulated positions and results are retained.':'Pause entries before saving. Managed live positions and unresolved orders must be resolved first.');
  $('strategy-cards').innerHTML=[['Intraday','intraday','Positions close during the trading day'],['Swing','swing','Positions may stay open overnight']].map(([name,key,desc])=>`<div class="strategy-item"><div><strong>${name}</strong><small>${escape(desc)}</small></div><div><strong>${money(config[`${key}_capital`]||0,0)}</strong><small>${badge(config[`${key}_enabled`]?'Enabled':'Disabled',config[`${key}_enabled`]?'green':'')}</small></div></div>`).join('');
  const warning=state.error||(state.maintenance?'Server maintenance is in progress. New entries are blocked.':!state.configured?'Setup needed: configure your Kite API credentials and Zerodha client ID on the server.':connected&&!state.account_fresh?'Account reconciliation is delayed. Check the activity log.':'');
  $('notice').textContent=warning;$('notice').hidden=!warning;$('notice').className=`notice ${state.error?'error':''}`;
  $('error-help').innerHTML=state.error?activityHelpMarkup(state.error_help):'';$('error-help').hidden=!$('error-help').innerHTML;
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
  $('signals-body').innerHTML=(state.signals||[]).slice(0,8).map(s=>`<tr><td>${escape(clock(s.timestamp||s.time))}</td><td>${escape(s.symbol)}</td><td>${badge(s.strategy,'blue')}<div class="entry-side">${entrySide(s)}</div></td><td>${badge(String(s.status||'analysed').replaceAll('_',' '),s.status==='candidate'?'green':'')}</td><td class="signal-explanation"><span>${escape(s.reason)}</span>${signalMetrics(s,openedSignals)}</td></tr>`).join('')||empty(5,'Signals appear after complete candles pass the strategy checks. Routine decisions are grouped in activity summaries.');
  if(activePage==='holdings'){
    const holdings=state.account?.holdings||[],analysis=state.holdings_signals||[];
    $('holdings-count').textContent=number(holdings.length);$('account-updated').textContent=`Account updated ${clock(state.account?.updated_at)}`;
    $('holdings-body').innerHTML=holdings.map(h=>{
      const q=Number(h.quantity||0)+Number(h.t1_quantity||0),pnl=(Number(h.last_price||0)-Number(h.average_price||0))*q;
      const signal=Array.isArray(analysis)?analysis.find(x=>x.symbol===h.tradingsymbol&&(!x.exchange||x.exchange===h.exchange)):analysis[h.tradingsymbol];
      const labels={ignored:'Ignored',exit_candidate:'Exit candidate',hold:'Hold',unsupported:'Unsupported',universe_unavailable:'Eligibility unavailable',history_unavailable:'No usable history',awaiting_market_data:'Waiting for market data',warming_up:'Waiting for daily history',analysing:'Analysing'};
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
  updateHoldingPolicy();
}
function updateHoldingPolicy(){
  const form=$('settings-form');
  form.elements.managed_symbols.disabled=form.elements.manage_existing_holdings.value!=='selected';
}
$('holding-policy').addEventListener('change',updateHoldingPolicy);
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
  const settingsNote=state.settings_blocker?.message||(disabledLive?'Your saved live mode has real execution disabled. Turn paper trading on to use simulation.':state.mode==='paper'?'Save and restart to apply changes. Simulated positions and results are retained.':'Save and restart to apply changes. Pause entries before saving.');
  $('paper-trading-note').textContent=configRestartRequired?(paperModeDirty?'Your unsaved selection has not been saved. Restart the program to load the saved settings.':'Settings saved. Restart the program to apply the saved trading mode.'):(paperModeDirty?'Unsaved change. ':'')+settingsNote;
  const disabled=!configLoaded||configSaving||configRestartRequired;
  $('paper-trading').disabled=disabled;$('paper-trading-save').disabled=disabled;$('config-submit').disabled=disabled;
  for(const field of configFields){const input=$('config-form').elements[field.key];if(input)input.disabled=configSaving||configRestartRequired;}
}
function renderConfig(data){
  acceptResearchSettings(data.values);
  const automatic=new Set(['public_url','app_env','paper_capital','live_capital','admin_username','trading_mode','live_trading_enabled']);
  configFields=(data.fields||[]).filter(field=>!automatic.has(field.key));
  const values=data.values||{};
  savedExecution={trading_mode:values.trading_mode,live_trading_enabled:values.live_trading_enabled===true};
  $('paper-trading').checked=values.trading_mode==='paper';paperModeDirty=false;configRestartRequired=configRestartRequired||data.restart_required===true;
  $('config-fields').innerHTML=configFields.map(field=>{
    const id=`config-${field.key}`, value=values[field.key], label=escape(field.label||field.key);
    if(field.type==='checkbox')return `<div class="config-field config-checkbox"><label for="${escape(id)}">${label}</label><label class="switch"><input id="${escape(id)}" name="${escape(field.key)}" type="checkbox" ${value?'checked':''} aria-label="${label}"><span></span></label></div>`;
    if(field.type==='select')return `<div class="config-field"><label for="${escape(id)}">${label}</label><select id="${escape(id)}" name="${escape(field.key)}">${(field.choices||[]).map(choice=>`<option value="${escape(choice)}" ${choice===value?'selected':''}>${escape(field.key==='research_cpu_affinity'?({pinned:'Pin workers to CPUs',automatic:'Automatic scheduling'})[choice]||choice:choice)}</option>`).join('')}</select></div>`;
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
function updateView(data){applyEventFloor(data.event_floor);equityHistory=data.equity_history||equityHistory;render(data.state);addEvents(data.events);if(Number.isSafeInteger(data.event_cursor)&&data.event_cursor>=0)eventCursor=Math.max(eventCursor??0,data.event_cursor);if(data.equity_history)drawChart();}
function statePath(){return eventCursor===null?'/api/state':`/api/state?after=${eventCursor}`;}
async function refresh(){const request=new AbortController(),timer=setTimeout(()=>request.abort(),10000);try{updateView(await api(statePath(),'GET',undefined,{signal:request.signal}));}finally{clearTimeout(timer);}}
async function action(path){
  busy=true;render(state);
  try{const result=await api(path,'POST',{});if(result.startup){startupLocal=result.startup;state={...state,startup:result.startup};render(state);}if(result.redirect_url){location.assign(result.redirect_url);return;}await refresh();}catch(e){toast(e.message);}finally{busy=false;render(state);}
}
async function startTrading(){
  if(busy||startupRequestPending||startupState().status==='running'||state.status==='running'||state.maintenance)return;
  const version=++startupRequestVersion;startupBaseline=state.startup?.operation_id||state.startup?.started_at;startupRequestPending=true;
  startupLocal={status:'running',phase:'requesting',message:'Sending the start request. Server steps will appear as they complete.'};render(state);
  let accepted=false;
  try{
    const result=await api('/api/trading/start','POST',{});if(version!==startupRequestVersion)return;
    accepted=result.accepted===true||result.startup?.status==='running';
    if(result.startup){startupLocal=result.startup;state={...state,startup:result.startup};render(state);}
    if(result.redirect_url){location.assign(result.redirect_url);return;}
    await refresh();
  }catch(error){if(version===startupRequestVersion){if(!accepted)startupLocal={status:'failed',phase:'start_request',message:error.message};toast(error.message);}}
  finally{if(version===startupRequestVersion)startupRequestPending=false;render(state);}
}
$('start').addEventListener('click',startTrading);
$('pause').addEventListener('click',()=>{if(busy)return;++startupRequestVersion;startupRequestPending=false;return action('/api/trading/pause');});
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
