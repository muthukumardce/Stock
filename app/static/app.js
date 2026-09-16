'use strict';
const $ = id => document.getElementById(id);
const money = (n, digits=2) => Number.isFinite(Number(n)) && n !== null && n !== undefined ? new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:digits}).format(Number(n)) : '—';
const number = n => new Intl.NumberFormat('en-IN').format(Number(n) || 0);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = value => {if(!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value).slice(-8) : d.toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});};
const positive = n => Number(n) < 0 ? 'negative' : Number(n) > 0 ? 'positive' : '';
const empty = (n,text) => `<tr><td colspan="${n}" class="empty-cell">${escape(text)}</td></tr>`;
let csrf='', state={}, events=[], equityHistory=[], liveView=null, liveAllowed=true, activePage='overview', settingsLoaded=false, settingsDirty=false, busy=false, lastChartAt=0, toastTimer;

async function api(path, method='GET', body, options={}) {
  const response = await fetch(path,{method,cache:'no-store',signal:options.signal,headers:{'Content-Type':'application/json',...(method==='GET'?{}:{'X-CSRF-Token':csrf})},...(body === undefined?{}:{body:JSON.stringify(body)})});
  if(response.status===401){liveAllowed=false;liveView?.stop();location.assign('/login');const error=new Error('Your session expired.');error.status=401;throw error;}
  const data = await response.json();
  if(!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Please check your settings and try again.');
  return data;
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function showPage(name){
  if(!['overview','holdings','orders','activity','settings'].includes(name)) name='overview';
  activePage=name;
  document.querySelectorAll('.page').forEach(p=>p.hidden=p.id!==`page-${name}`);
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===name));
  $('breadcrumb').textContent={overview:'Overview',holdings:'Holdings',orders:'Orders & trades',activity:'Activity log',settings:'Settings'}[name];
  history.replaceState(null,'',name==='settings'?'/settings':`/#${name}`);
  renderTables();
}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));

function addEvents(rows){
  const known = new Set(events.map(e=>e.id));
  for(const row of rows||[]) if(!known.has(row.id)){events.push(row);known.add(row.id);}
  events.sort((a,b)=>a.id-b.id);events=events.slice(-500);renderActivity();
}
function badge(text, color=''){return `<span class="badge ${color}">${escape(text)}</span>`;}
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
  const paper=state.mode!=='live', connected=state.connected, running=state.status==='running', recovering=running&&state.recovery?.blocked;
  $('mode-pill').textContent=paper?'Paper trading':'Live trading';$('mode-pill').classList.toggle('live',!paper);
  $('equity-mode').textContent=paper?'PAPER':'LIVE';$('risk-mode').textContent=paper?'PAPER':'LIVE';
  $('engine-status').textContent=recovering?'Recovering account':({disconnected:'Disconnected',monitoring:'Monitoring',running:'Trading active',paused:'Entries paused',error:'Attention needed'})[state.status]||state.status||'Disconnected';
  $('engine-dot').className=`dot ${state.status==='error'?'red':recovering?'amber':running?'green':connected?'amber':''}`;
  $('broker-dot').className=`dot ${connected?'green':''}`;$('broker-sidebar').textContent=connected?(state.user_id||'Connected'):'Not connected';
  $('market-state').textContent=state.market_open?(state.feed_fresh?'Market open':'Awaiting fresh market data'):'Outside market hours';
  $('account-ref').textContent=`Zerodha account · ${state.user_id||'—'}`;
  $('session-message').textContent=state.message || (connected?'Your account is connected. Monitoring continues when you close this page.':'Connect your Zerodha account to start monitoring.');
  $('start').disabled=busy||running||state.maintenance;
  $('start').innerHTML=recovering?'Checking account':running?'Trading active':`<span aria-hidden="true">▶</span> ${connected?'Resume trading':'Start Trading'}`;
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
  $('resource-cores').textContent=`${number(resources.logical_cpus)} logical processors`;
  $('resource-memory').textContent=`${Number(resources.memory_used_gib||0).toFixed(1)} GB`;
  $('resource-total').textContent=`of ${number(resources.memory_total_gib)} GB system memory`;
  $('resource-workers').textContent=`${number(performance.worker_limit)} workers`;
  $('resource-queue').textContent=`${number(performance.active_jobs)} active · ${number(performance.queue_depth)} queued`;
  $('resource-completed').textContent=number(performance.completed_jobs);
  $('resource-latency').textContent=performance.completed_jobs?`Latest batch ${Number(performance.analysis_ms||0).toFixed(1)} ms`:'Workers activate as data is ready';
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
  const limits=state.limits||{};$('allocation-limit').textContent=`Available trading capital: ${money(limits.capital,0)}`;
  $('risk-limits').innerHTML=[['Risk per trade',`${Number(limits.risk_per_trade_pct||0)*100}%`],['Daily loss halt',`${Number(limits.daily_loss_pct||0)*100}%`],['Maximum positions',limits.max_positions||'—'],['Maximum stock allocation',`${Number(limits.max_position_pct||0)*100}%`],['Intraday entry cutoff',`${limits.entry_cutoff||'—'} IST`],['Intraday close target',`${limits.exit_time||'—'} IST`],['Execution mode',paper?'Paper · simulated orders':'Live · real orders'],['Zerodha sign-in','Required each trading day']].map(([a,b])=>`<div><dt>${escape(a)}</dt><dd>${escape(b)}</dd></div>`).join('');
  $('position-subtitle').textContent=paper?'Simulated positions · real Zerodha holdings are shown separately':'Positions managed by StockPilot · broker fills are reconciled';
  if(connected&&Number.isFinite(Number(state.equity))&&Date.now()-lastChartAt>=30000){equityHistory.push({timestamp:state.server_time,equity:Number(state.equity)});equityHistory=equityHistory.slice(-180);lastChartAt=Date.now();drawChart();}
  renderTables();
}
function renderTables(){
  const positions=state.positions||[];
  $('positions-body').innerHTML=positions.map(p=>`<tr><td>${escape(p.symbol||p.tradingsymbol)}</td><td>${badge(p.strategy||'intraday','blue')}</td><td>${number(p.quantity)}</td><td>${money(p.entry)}</td><td>${money(p.last??p.last_price)}</td><td>${money(p.stop)}${p.protection_status?` ${badge(p.protection_status)}`:''}</td><td class="align-right ${positive(p.unrealised??p.unrealised_pnl)}">${money(p.unrealised??p.unrealised_pnl)}</td></tr>`).join('')||empty(7,state.connected?'No managed positions. The scanner waits for qualifying signals.':'Connect to Zerodha to begin monitoring.');
  $('signals-body').innerHTML=(state.signals||[]).slice(0,8).map(s=>`<tr><td>${escape(clock(s.timestamp||s.time))}</td><td>${escape(s.symbol)}</td><td>${badge(s.strategy,'blue')}</td><td>${badge(String(s.status||'analysed').replaceAll('_',' '),s.status==='candidate'?'green':'')}</td><td title="${escape(s.reason)}">${escape(s.reason)}</td></tr>`).join('')||empty(5,'Signals appear after complete candles pass the strategy checks. All decisions are recorded in the activity log.');
  if(activePage==='holdings'){
    const holdings=state.account?.holdings||[],analysis=state.holdings_signals||[];
    $('holdings-count').textContent=number(holdings.length);$('account-updated').textContent=`Account updated ${clock(state.account?.updated_at)}`;
    $('holdings-body').innerHTML=holdings.map(h=>{
      const q=Number(h.quantity||0)+Number(h.t1_quantity||0),pnl=(Number(h.last_price||0)-Number(h.average_price||0))*q;
      const signal=Array.isArray(analysis)?analysis.find(x=>x.symbol===h.tradingsymbol):analysis[h.tradingsymbol];
      const managed=signal?.managed; const label=signal?.action==='simulated_sell'?'Paper exit recorded':signal?.status==='exit_candidate'?'Exit candidate':signal?.status==='hold'?'Hold':'Analysing';
      return `<tr><td>${escape(h.tradingsymbol)}<small> · ${escape(h.exchange)}</small></td><td>${number(q)}</td><td>${money(h.average_price)}</td><td>${money(h.last_price)}</td><td>${money(q*Number(h.last_price||0),0)}</td><td class="${positive(pnl)}">${money(pnl)}</td><td title="${escape(signal?.reason||'Awaiting analysis')}">${badge(managed?'Managed':'Observe only',managed?'blue':'')} ${badge(label,signal?.status==='exit_candidate'?'amber':'')}</td></tr>`;
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
  for(const key of ['intraday_capital','swing_capital'])form.elements[key].value=values[key]??0;
  form.elements.manage_existing_holdings.value=values.manage_existing_holdings||'selected';
  form.elements.managed_symbols.value=(values.managed_symbols||[]).join(', ');
}
$('settings-form').addEventListener('input',()=>settingsDirty=true);
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;$('settings-error').textContent='';
  const values={intraday_enabled:form.elements.intraday_enabled.checked,swing_enabled:form.elements.swing_enabled.checked,intraday_capital:Number(form.elements.intraday_capital.value),swing_capital:Number(form.elements.swing_capital.value),manage_existing_holdings:form.elements.manage_existing_holdings.value,managed_symbols:form.elements.managed_symbols.value.toUpperCase().split(/[\s,]+/).filter(Boolean)};
  try{await api('/api/settings','PUT',values);settingsDirty=false;settingsLoaded=false;toast('Settings saved. They apply when trading starts.');await refresh();}catch(e){$('settings-error').textContent=e.message;}finally{button.disabled=false;}
});
function updateView(data){equityHistory=data.equity_history||equityHistory;render(data.state);addEvents(data.events);if(data.equity_history)drawChart();}
async function refresh(){const request=new AbortController(),timer=setTimeout(()=>request.abort(),10000);try{updateView(await api('/api/state','GET',undefined,{signal:request.signal}));}finally{clearTimeout(timer);}}
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
$('logout').addEventListener('click',async()=>{liveAllowed=false;liveView?.stop();try{await api('/api/logout','POST',{});location.assign('/login');}catch(e){toast(e.message);if(e.status!==401){liveAllowed=true;liveView?.start();}}});
liveView=createLiveView({
  hostname:location.hostname,
  EventSource:globalThis.EventSource,
  after:()=>events.at(-1)?.id||0,
  fetchState:options=>api('/api/state','GET',undefined,options),
  onUpdate:updateView,
  onStatus:({text,color})=>{$('feed-state').innerHTML=`<span class="dot ${escape(color)}"></span> ${escape(text)}`;},
  onExpired:()=>{liveAllowed=false;location.assign('/login?error=expired');},
});
window.addEventListener('pagehide',()=>{liveAllowed=false;liveView.stop();});
window.addEventListener('pageshow',event=>{liveAllowed=true;if(event.persisted&&csrf)liveView.start();});
(async()=>{
  try{
    const session=await api('/api/session');csrf=session.csrf;
    const error=new URLSearchParams(location.search).get('error');
    showPage(location.pathname==='/settings'?'settings':location.hash.slice(1)||'overview');
    try{await refresh();}finally{if(liveAllowed)liveView.start();}
    if(error)toast(({callback:'The Zerodha sign-in expired or failed its security check. Please try Start Trading again.',wrong_account:'The Zerodha client ID does not match the account configured on this server.',kite_login:'Zerodha sign-in was not completed.',start:'Your session could not start trading. Check the status and activity log.'})[error]||'Please reconnect to Zerodha.');
  }catch(e){toast(e.message);}
})();
