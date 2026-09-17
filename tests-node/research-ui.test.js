import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const script=fs.readFileSync(path.join(import.meta.dirname,'../public/app.js'),'utf8');
const html=fs.readFileSync(path.join(import.meta.dirname,'../public/index.html'),'utf8');
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function element(id=''){
  const events={},classes=new Set(),attributes={},children=[];let markup='';
  const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  return {id,hidden:false,disabled:false,textContent:'',value:'',dataset:{},style:{},events,attributes,children,parentNode:null,
    get innerHTML(){return children.length?children.map(child=>child.outerHTML).join(''):markup;},
    set innerHTML(value){for(const child of children)child.parentNode=null;children.length=0;markup=value;},
    get outerHTML(){const attrs={...attributes,...(this.className?{class:this.className}:{}),...(this.hidden?{hidden:''}:{})};return `<${this.tagName}${Object.entries(attrs).map(([key,value])=>` ${key}="${escape(value)}"`).join('')}>${children.length?this.innerHTML:markup||escape(this.textContent)}</${this.tagName}>`;},
    append(...nodes){for(const node of nodes)this.insertBefore(node,null);},
    insertBefore(node,before){node.remove();const index=before?children.indexOf(before):children.length;assert.ok(index>=0);children.splice(index,0,node);node.parentNode=this;},
    remove(){if(this.parentNode){const siblings=this.parentNode.children;siblings.splice(siblings.indexOf(this),1);this.parentNode=null;}},
    elements:new Proxy({},{get:(target,key)=>target[key]||=(element(String(key)))}),
    classList:{toggle(name,active){if(active)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},
    setAttribute(name,value){attributes[name]=String(value);},getAttribute(name){return attributes[name]??null;},hasAttribute(name){return Object.hasOwn(attributes,name);},removeAttribute(name){delete attributes[name];delete this[name];},
    addEventListener(name,fn){events[name]=fn;},querySelector:()=>element(),focus(){},select(){},showModal(){},
  };
}
const current=()=>({connected:true,configured:true,status:'running',mode:'paper',account_fresh:true,signals:[],strategy_settings:{intraday_enabled:true,intraday_allocation_pct:1,swing_allocation_pct:0}});
async function harness(){
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],element(match[1])])),requests=[],timers=new Map(),windowEvents={},documentEvents={};
  let timerId=0,research={status:'idle',progress:0,report:null},customGet=null,customTrading=null,customResearchStart=null,customResearchApply=null,customResearchSettings=null,configValues={research_symbols:20,research_tuning_trials:9,research_cpu_affinity:'pinned'},brokerState=current(),openSignals=[];
  const document={visibilityState:'visible',createElement:tagName=>Object.assign(element(),{tagName}),getElementById:id=>{assert.ok(elements.has(id),`Missing element ${id}`);return elements.get(id);},querySelectorAll:selector=>selector==='#signals-body details[open]'?openSignals:[],addEventListener:(name,fn)=>documentEvents[name]=fn};
  const context=vm.createContext({document,console,URL,URLSearchParams,Intl,AbortController,Date,
    window:{addEventListener:(name,fn)=>windowEvents[name]=fn,open(){throw new Error('Research must never open a broker order page');}},
    location:{hostname:'localhost',pathname:'/',hash:'',search:'',assign(){}},history:{replaceState(){}},navigator:{},
    setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    createLiveView:()=>({start(){},stop(){}}),
    async fetch(url,options){
      requests.push({url,options});let data;
      if(url==='/api/session')data={csrf:'research-csrf'};
      else if(url==='/api/config')data={fields:[],values:configValues,urls:{}};
      else if(url==='/api/state')data={state:brokerState,events:[]};
      else if(url==='/api/research')data=customGet?await customGet(options):research;
      else if(url==='/api/research/start'){if(customResearchStart)return customResearchStart();data=research={status:'collecting',progress:3,message:'Collecting historical candles',report:null};}
      else if(url==='/api/research/apply'&&customResearchApply)return customResearchApply(options);
      else if(url==='/api/research/settings'){if(customResearchSettings)return customResearchSettings(options);const values=JSON.parse(options.body);configValues={...configValues,...values};data={ok:true,settings:values};}
      else if(url==='/api/research/cancel')data=research={...research,status:'cancelled',message:'Research cancelled'};
      else if(['/api/trading/start','/api/trading/pause'].includes(url)&&customTrading)data=await customTrading(url,options);
      else throw new Error(`Unexpected UI request ${url}`);
      return {ok:true,status:200,json:async()=>structuredClone(data)};
    },
  });
  vm.runInContext(script,context,{filename:'public/app.js'});await flush();
  return {context,elements,requests,timers,document,windowEvents,documentEvents,run:code=>vm.runInContext(code,context),
    setResearch(value){research=value;},customGet(fn){customGet=fn;},setOpenSignals(keys){openSignals=keys.map(key=>({dataset:{signal:key}}));},
    tradingAction(fn){customTrading=fn;},
    researchStart(fn){customResearchStart=fn;},
    researchApply(fn){customResearchApply=fn;},
    researchSettings(fn){customResearchSettings=fn;},setConfig(values){configValues=values;},
    setState(value){brokerState=value;context.nextState=value;vm.runInContext('render(nextState)',context);},
  };
}
function report(){
  const metrics={initial_capital:100000,ending_equity:101250,net_pnl:1250,net_return_pct:1.25,trade_count:12,win_rate_pct:50,expectancy:104.166,profit_factor:null,max_drawdown_pct:2.5,costs_paid:190,open_positions:0};
  return {strategy_version:'2.0.0',dataset:{interval:'5minute',symbol_count:2,bar_count:3000,from:'2026-08-01',to:'2026-09-16',symbols:['INFY','<script>stock</script>'],errors:[{symbol:'MISSING',message:'Unavailable <data>'}]},
    baseline:{metrics,period_metrics:[{name:'train',from:'2026-08-01',to:'2026-08-21',metrics}],cost_model:{fee_rate:.0003,slippage_rate:.0005},caveats:['Current universe may introduce selection bias.']},
    enhanced:{metrics:{...metrics,net_return_pct:-.75,net_pnl:-750},period_metrics:[{name:'test',from:'2026-09-01',to:'2026-09-16',metrics}],caveats:['Current universe may introduce selection bias.']},
    caveats:['Historical simulation only. <Never a guarantee>'],
  };
}

test('research is a separate page and disconnected accounts see no fabricated performance',async()=>{
  const h=await harness();assert.equal(h.requests.some(item=>item.url==='/api/research'),false);
  h.setState({...current(),connected:false});h.run("showPage('research')");await flush();
  assert.equal(h.elements.get('breadcrumb').textContent,'Strategy research');
  assert.equal(h.elements.get('research-start').disabled,true);assert.equal(h.elements.get('research-report').hidden,true);
  assert.equal(h.elements.get('research-metrics-body').innerHTML,'');
  assert.match(html,/simulated research/);assert.match(html,/never automatically enable or promote live trading/);
});

test('report shows actual percent-point metrics, chronological periods, data gaps and escaped source text',async()=>{
  const h=await harness();h.setResearch({status:'complete',progress:100,report:report(),completed_at:'2026-09-17T10:00:00+05:30'});h.run("showPage('research')");await flush();
  assert.equal(h.elements.get('research-report').hidden,false);assert.equal(h.elements.get('research-empty').hidden,true);
  const body=h.elements.get('research-metrics-body').innerHTML;assert.match(body,/>1\.25%</);assert.match(body,/>-0\.75%</);assert.doesNotMatch(body,/>125%|>NaN|>Infinity/);assert.match(body,/<td>Profit factor<\/td><td>—<\/td>/);
  assert.match(h.elements.get('research-splits').innerHTML,/train/);assert.match(h.elements.get('research-splits').innerHTML,/test/);
  assert.match(h.elements.get('research-symbols').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(h.elements.get('research-symbols').innerHTML,/<script>/);
  assert.equal(h.elements.get('research-errors-panel').hidden,false);assert.match(h.elements.get('research-errors').innerHTML,/MISSING: Unavailable &lt;data&gt;/);
  const assumptions=h.elements.get('research-assumptions').innerHTML;assert.match(assumptions,/0\.03% per fill/);assert.match(assumptions,/0\.05% per fill/);assert.equal(assumptions.match(/selection bias/g).length,1);
  assert.equal(h.elements.get('research-progress').value,100);assert.match(h.elements.get('research-completed').textContent,/Finished/);
});

test('research Start and Cancel are CSRF-protected and never enable live trading or place orders',async()=>{
  const h=await harness();await h.run("researchAction('start')");
  assert.equal(h.elements.get('research-cancel').disabled,false);assert.equal(h.elements.get('research-start').disabled,true);
  assert.equal(h.elements.get('research-progress').value,3);assert.equal(h.elements.get('research-status').textContent,'Collecting data');
  await h.run("researchAction('cancel')");assert.equal(h.elements.get('research-status').textContent,'Cancelled');assert.equal(h.elements.get('research-cancel').disabled,true);
  const posts=h.requests.filter(item=>item.options.method==='POST');assert.deepEqual(posts.map(item=>item.url),['/api/research/start','/api/research/cancel']);
  for(const request of posts){assert.equal(request.options.headers['X-CSRF-Token'],'research-csrf');assert.deepEqual(JSON.parse(request.options.body),{});}
});

test('research status is single-flight and polling stops when page is hidden or changed',async()=>{
  const h=await harness();let complete;h.customGet(()=>new Promise(resolve=>{complete=resolve;}));
  h.run("showPage('research')");const first=h.run('loadResearch()'),second=h.run('loadResearch()');await flush();
  assert.equal(h.requests.filter(item=>item.url==='/api/research').length,1);assert.equal(h.elements.get('research-refresh').disabled,true);
  complete({status:'running',progress:42});await Promise.all([first,second]);await flush();
  assert.equal([...h.timers.values()].filter(timer=>timer.delay===2000).length,1);
  h.document.visibilityState='hidden';h.documentEvents.visibilitychange();assert.equal([...h.timers.values()].filter(timer=>timer.delay===2000).length,0);
  h.customGet(null);h.document.visibilityState='visible';h.documentEvents.visibilitychange();await flush();assert.equal([...h.timers.values()].filter(timer=>timer.delay===5000).length,1);
  h.run("showPage('overview')");assert.equal([...h.timers.values()].filter(timer=>timer.delay===5000).length,0);
});

test('decision controls expose breadth, all-account exposure and backend blockers without replacing dirty settings',async()=>{
  const h=await harness();h.run("settingsDirty=true;configDirty=true;document.getElementById('settings-form').elements.managed_symbols.value='UNSAVED'");
  h.setState({...current(),decision_controls:{strategy_version:'2.0.0',regime:{status:'defensive',advancing:15,total:100,coverage:.5,breadth:.15,message:'Weak market participation'},portfolio:{reference_assets:100000,gross_exposure:70000,gross_fraction:.7,estimated_stress_loss:3000,rows:[{symbol:'INFY',exposure:70000,weight:.7,stress:3000}],unpriced_symbols:['UNKNOWN']},blocked_reasons:['Market participation below threshold.','Concentration <limit> reached.'],cooldown:{until:'2026-09-17T12:30:00+05:30',message:'Loss cooldown active.'},candidate_count:1,ranked_candidates:[{symbol:'<img src=x>',strategy:'intraday',score:78,reason:'Trend <confirmation>'}]}});
  assert.equal(h.elements.get('regime-breadth').textContent,'15%');assert.equal(h.elements.get('regime-coverage').textContent,'50%');assert.equal(h.elements.get('regime-status').textContent,'Weak participation');
  assert.match(h.elements.get('portfolio-exposures').innerHTML,/70%/);assert.match(h.elements.get('decision-blockers').innerHTML,/Concentration &lt;limit&gt;/);assert.match(h.elements.get('decision-blockers').innerHTML,/Loss cooldown/);
  assert.match(h.elements.get('ranked-candidates').innerHTML,/&lt;img/);assert.doesNotMatch(h.elements.get('ranked-candidates').innerHTML,/<img/);
  assert.equal(h.run("document.getElementById('settings-form').elements.managed_symbols.value"),'UNSAVED');assert.equal(h.run('configDirty'),true);
});

test('signal details explain indicators and evidence, retain expanded rows and distinguish incomplete VWAP',async()=>{
  const h=await harness(),signal={symbol:'INFY',strategy:'intraday',time:'2026-09-17T10:00:00+05:30',setup:'trend_pullback',score:78,score_components:{trend:18},reason:'Confirmed trend',analytics:{ema9:1500,rsi14:58,macd_histogram:1.2,session_vwap:null,window_vwap:1490,vwap_scope:'window',session_vwap_complete:false,bollinger_width20:.04,patterns:[{name:'Bullish engulfing',direction:'bullish',context:'support <area>'}]},evidence:['Trend aligned'],opposition:['Low <volume>']};
  h.setOpenSignals([`${signal.symbol}:${signal.strategy}:${signal.time}`]);h.setState({...current(),signals:[signal]});
  const body=h.elements.get('signals-body').innerHTML;assert.match(body,/ open>/);assert.match(body,/EMA 9/);assert.match(body,/MACD histogram/);assert.match(body,/Bollinger width<\/dt><dd>4%/);assert.match(body,/partial session/);assert.match(body,/not a probability of profit/);assert.match(body,/Low &lt;volume&gt;/);assert.match(body,/support &lt;area&gt;/);
});

test('failed status refresh preserves existing research results and displays the transport error',async()=>{
  const h=await harness();h.setResearch({status:'complete',progress:100,report:report()});await h.run('loadResearch()');const previous=h.elements.get('research-metrics-body').innerHTML;
  h.customGet(()=>{throw new Error('Research transport unavailable');});await assert.rejects(h.run('loadResearch()'),/Research transport unavailable/);
  assert.equal(h.elements.get('research-metrics-body').innerHTML,previous);assert.equal(h.elements.get('research-error').textContent,'Research transport unavailable');assert.equal(h.elements.get('research-refresh').disabled,false);
});

test('automatic research exposes retry time and cancellation without losing the previous report',async()=>{
  const h=await harness();
  h.setResearch({status:'failed',report:report(),automation:{enabled:true,status:'retry_wait',reason:'Historical data unavailable. Automatic retry scheduled.',next_retry_at:'2026-09-17T10:15:00+05:30'}});
  await h.run('loadResearch()');
  assert.equal(h.elements.get('research-report').hidden,false);
  assert.match(h.elements.get('research-auto-note').textContent,/Automatic retry scheduled/);
  assert.match(h.elements.get('research-auto-note').textContent,/10:15.*IST/);
  assert.equal(h.elements.get('research-cancel').disabled,false);
  h.setResearch({status:'cancelled',report:report(),automation:{enabled:true,status:'cancelled',reason:'Automatic research paused for this configuration. Run analysis to resume.',next_retry_at:null}});
  await h.run('loadResearch()');
  assert.match(h.elements.get('research-auto-note').textContent,/Run analysis to resume/);
  assert.doesNotMatch(h.elements.get('research-auto-note').textContent,/Next automatic check/);
  assert.equal(h.elements.get('research-report').hidden,false);
  assert.equal(h.elements.get('research-cancel').disabled,true);
});

test('armed engine waiting for funds remains pausable and does not display active trading',async()=>{
  const h=await harness();
  h.setState({...current(),waiting_for_funds:true,message:'Add funds in Zerodha. The program checks balances automatically.'});
  assert.equal(h.elements.get('engine-status').textContent,'Waiting for funds');
  assert.match(h.elements.get('engine-dot').className,/amber/);
  assert.equal(h.elements.get('start').disabled,true);
  assert.equal(h.elements.get('pause').disabled,false);
  h.setState({...current(),waiting_for_funds:false});
  assert.equal(h.elements.get('engine-status').textContent,'Trading active');
  h.setState({...current(),status:'paused',maintenance:false,waiting_for_funds:true});
  assert.equal(h.elements.get('engine-status').textContent,'Entries paused');
  assert.equal(h.elements.get('start').disabled,false);
  assert.equal(h.elements.get('pause').disabled,true);
});

test('confirmed clock mismatch shows an action-required label and clears after a fresh aligned observation',async()=>{
  const h=await harness();
  h.setState({...current(),broker_clock:{status:'skewed',blocked:true,stale:false,offset_lower_ms:222000,offset_upper_ms:224000}});
  assert.equal(h.elements.get('clock-status').hidden,false);
  assert.match(h.elements.get('clock-status').textContent,/223 seconds behind/);
  assert.match(h.elements.get('clock-status').textContent,/New entries wait/);
  assert.match(h.elements.get('clock-status').textContent,/rechecks automatically after synchronization/);
  assert.equal(h.elements.get('engine-status').textContent,'Clock synchronization required');
  assert.equal(h.elements.get('start').innerHTML,'Clock out of sync');
  assert.equal(h.elements.get('start').disabled,true);
  assert.equal(h.elements.get('pause').disabled,false);
  h.setState({...current(),broker_clock:{status:'aligned',blocked:false,stale:false}});
  assert.equal(h.elements.get('clock-status').hidden,true);
  assert.equal(h.elements.get('engine-status').textContent,'Trading active');
  assert.equal(h.elements.get('start').innerHTML,'Trading active');
  assert.equal(h.elements.get('start').disabled,true);assert.equal(h.elements.get('pause').disabled,false);
});

test('pending and stale clock verification remain distinguishable from confirmed clock skew',async()=>{
  const h=await harness();
  for(const broker_clock of [{status:'unknown',blocked:false,stale:true},{status:'uncertain',blocked:false,stale:false},{status:'aligned',blocked:false,stale:true}]){
    h.setState({...current(),broker_clock});
    assert.equal(h.elements.get('clock-status').hidden,false);
    assert.match(h.elements.get('clock-status').textContent,/recent broker clock check/);
    assert.equal(h.elements.get('engine-status').textContent,'Waiting for clock verification');
    assert.equal(h.elements.get('start').innerHTML,'Checking system clock');
    assert.equal(h.elements.get('start').disabled,true);assert.equal(h.elements.get('pause').disabled,false);
  }
});

test('automatic clock recheck does not rearm paused trading',async()=>{
  const h=await harness();
  h.setState({...current(),broker_clock:{status:'skewed',blocked:true,stale:false}});
  h.setState({...current(),status:'paused',maintenance:false,broker_clock:{status:'skewed',blocked:true,stale:true}});
  assert.equal(h.elements.get('engine-status').textContent,'Entries paused');assert.equal(h.elements.get('pause').disabled,true);
  assert.match(h.elements.get('clock-status').textContent,/Paused trading stays paused/);
  h.setState({...current(),status:'paused',maintenance:false,broker_clock:{status:'aligned',blocked:false,stale:false}});
  assert.equal(h.elements.get('clock-status').hidden,true);assert.equal(h.elements.get('engine-status').textContent,'Entries paused');
  assert.match(h.elements.get('start').innerHTML,/Resume trading/);assert.equal(h.elements.get('start').disabled,false);assert.equal(h.elements.get('pause').disabled,true);
  assert.equal(h.run('state.status'),'paused');assert.equal(h.requests.some(request=>request.options.method==='POST'),false);
});

test('Start immediately reports pending work, prevents duplicate requests and follows actual server steps despite clock blockers',async()=>{
  const h=await harness();h.setState({...current(),status:'paused',maintenance:false,startup:{status:'idle'}});
  let release;h.tradingAction(()=>new Promise(resolve=>{release=resolve;}));const pending=h.run('startTrading()');
  assert.equal(h.elements.get('startup-card').hidden,false);assert.equal(h.elements.get('startup-phase').textContent,'Sending start request');
  assert.equal(h.elements.get('startup-progress').hidden,true);assert.doesNotMatch(h.elements.get('startup-count').textContent,/%/);
  assert.equal(h.elements.get('start').disabled,true);assert.equal(h.elements.get('pause').disabled,false);
  await h.run('startTrading()');assert.equal(h.requests.filter(request=>request.url==='/api/trading/start').length,1);
  h.setState({...current(),status:'paused',maintenance:false,startup:{status:'idle'}});
  assert.equal(h.elements.get('startup-card').hidden,false,'An old snapshot cannot erase the pending request');
  const startup={status:'running',phase:'universe',message:'Checking stock eligibility',completed:2,total:6,started_at:'2026-09-17T10:00:00+05:30',updated_at:'2026-09-17T10:00:02+05:30'};
  h.setState({...current(),startup,broker_clock:{status:'skewed',blocked:true}});
  assert.equal(h.elements.get('startup-progress').value,2);assert.equal(h.elements.get('startup-progress').max,6);
  assert.equal(h.elements.get('startup-count').textContent,'2 of 6 steps · 33%');assert.equal(h.elements.get('start').innerHTML,'Starting…');
  assert.equal(h.elements.get('engine-status').textContent,'Clock synchronization required');assert.equal(h.elements.get('startup-card').hidden,false);
  release({accepted:true,startup});await pending;
  assert.equal(h.elements.get('pause').disabled,false);assert.equal(h.elements.get('start').disabled,true);
  h.setState({...current(),waiting_for_funds:true,startup:{...startup,status:'complete',completed:6,phase:'complete',updated_at:'2026-09-17T10:00:05+05:30'}});
  assert.equal(h.elements.get('startup-title').textContent,'Startup checks finished');assert.equal(h.elements.get('startup-count').textContent,'6 of 6 steps · 100%');
  assert.equal(h.elements.get('engine-status').textContent,'Waiting for funds');assert.match(h.elements.get('startup-note').textContent,/trade checks still apply/);
});

test('Pause can cancel startup before connection and a late Start reply cannot rearm the UI',async()=>{
  const h=await harness();h.setState({...current(),status:'disconnected',connected:false,maintenance:false,startup:{status:'idle'}});
  let release;const cancelled={status:'cancelled',phase:'cancelled',message:'Startup cancelled',completed:0,total:6,started_at:'2026-09-17T10:00:00+05:30',updated_at:'2026-09-17T10:00:02+05:30'};
  h.tradingAction(url=>url==='/api/trading/start'?new Promise(resolve=>{release=resolve;}):{accepted:true,startup:cancelled});
  const pending=h.run('startTrading()');assert.equal(h.elements.get('pause').disabled,false);
  h.setState({...current(),status:'paused',connected:false,maintenance:false,startup:cancelled});
  await h.elements.get('pause').events.click();
  release({accepted:true,startup:{...cancelled,status:'running',phase:'account',updated_at:'2026-09-17T10:00:01+05:30'}});await pending;
  assert.equal(h.elements.get('startup-title').textContent,'Startup cancelled');assert.equal(h.elements.get('start').disabled,false);
  assert.equal(h.elements.get('engine-status').textContent,'Entries paused');assert.equal(h.run('state.status'),'paused');
  assert.deepEqual(h.requests.filter(request=>request.options.method==='POST').map(request=>request.url),['/api/trading/start','/api/trading/pause']);
});

test('Background shows actual job counts, escaped symbols, retry reasons, CPU batches and research without inventing missing progress',async()=>{
  const h=await harness();h.run("showPage('background')");assert.equal(h.elements.get('breadcrumb').textContent,'Background work');
  assert.match(h.elements.get('background-tasks').innerHTML,/not been reported/);assert.equal(h.elements.get('background-cpu').textContent,'Not reported');
  assert.equal(h.elements.get('background-research-progress').hidden,true);
  h.setState({...current(),resources:{cpu_percent:12.5},performance:{worker_limit:8,live_workers:2,active_jobs:1,queue_depth:15,completed_symbols:120,active_batches:[{symbols:['INFY','<script>'],strategies:['intraday'],started_at:'2026-09-17T10:00:00+05:30'}]},background:{tasks:[
    {id:'daily_history',label:'Daily history',status:'running',message:'Downloading completed candles',current_item:'INFY<script>',completed:5,total:20,failed:2,updated_at:'2026-09-17T10:00:00+05:30'},
    {id:'universe',label:'Stock eligibility',status:'waiting',message:'Waiting for official source',next_retry_at:'2026-09-17T10:01:00+05:30'},
  ],research:{status:'running',progress:42,message:'Comparing completed history'}}});
  const tasks=h.elements.get('background-tasks').innerHTML;assert.match(tasks,/5 of 20 completed · 25%/);assert.match(tasks,/2 failed/);assert.match(tasks,/INFY&lt;script&gt;/);assert.doesNotMatch(tasks,/<script>/);
  assert.match(tasks,/Waiting for official source/);assert.match(tasks,/Next retry.*10:01/);assert.equal((tasks.match(/<progress/g)||[]).length,1);
  assert.equal(h.elements.get('background-cpu').textContent,'12.5%');assert.equal(h.elements.get('background-workers').textContent,'2 live / 8 capacity');
  assert.equal(h.elements.get('background-queue').textContent,'15 queued analyses');assert.match(h.elements.get('background-batches').innerHTML,/INFY, &lt;script&gt;/);
  assert.equal(h.elements.get('background-research-progress').value,42);assert.equal(h.elements.get('background-research-status').textContent,'running');
  assert.equal(h.requests.some(request=>request.url==='/api/research/start'),false);
  h.setState({...current(),background:{research:{status:'idle',automation:{reason:'Waiting for verified funds before automatic research.',next_retry_at:'2026-09-17T10:05:00+05:30'}}}});
  assert.match(h.elements.get('background-research-message').textContent,/Waiting for verified funds/);assert.match(h.elements.get('background-research-detail').textContent,/Next retry.*10:05/);
});

test('startup revisions keep progress current across backward clock corrections and stale responses',async()=>{
  const h=await harness(),startup={status:'running',operation_id:'startup-one',lifecycle_id:'server-one',revision:8,phase:'account',completed:1,total:6,started_at:'2026-09-17T10:04:00+05:30',updated_at:'2026-09-17T10:04:01+05:30'};
  h.setState({...current(),startup});
  h.setState({...current(),startup:{...startup,revision:9,phase:'universe',completed:2,updated_at:'2026-09-17T10:00:20+05:30'}});
  assert.equal(h.elements.get('startup-count').textContent,'2 of 6 steps · 33%');
  h.setState({...current(),startup});assert.equal(h.elements.get('startup-count').textContent,'2 of 6 steps · 33%','An older reply cannot roll progress backward');
  h.setState({...current(),startup:{...startup,revision:10,status:'complete',completed:6,updated_at:'2026-09-17T10:00:21+05:30'}});
  assert.equal(h.elements.get('startup-title').textContent,'Startup checks finished');
  h.setState({...current(),status:'paused',startup:{status:'idle',operation_id:'startup-two',lifecycle_id:'server-two',revision:0}});
  assert.equal(h.elements.get('startup-card').hidden,true,'A restarted server has a new lifecycle and may reset revisions');
});

test('server progress replaces a local Start transport failure when the accepted operation appears',async()=>{
  const h=await harness();h.setState({...current(),status:'paused',maintenance:false,startup:{status:'idle',operation_id:'idle-one',revision:0}});
  h.tradingAction(()=>{throw new Error('Start response interrupted');});await h.run('startTrading()');
  assert.equal(h.elements.get('startup-title').textContent,'Startup needs attention');
  h.setState({...current(),startup:{status:'running',operation_id:'accepted-one',revision:2,phase:'account',message:'Refreshing account',completed:1,total:6,started_at:'2026-09-17T10:00:00+05:30',updated_at:'2026-09-17T10:00:01+05:30'}});
  assert.equal(h.elements.get('startup-title').textContent,'Starting trading session');assert.equal(h.elements.get('startup-message').textContent,'Refreshing account');
});

test('research explains HTTP 429 and prevents repeated Start through cancellation until the server cooldown expires',async()=>{
  const h=await harness(),now='2026-09-17T10:00:00+05:30',until='2026-09-17T10:02:00+05:30';h.setState({...current(),server_time:now});
  const error={code:'rate_limit',message:'Zerodha limited historical requests. Wait before retrying.',http_status:429,phase:'symbol_history',symbol:'INFY',retryable:true,next_retry_at:until};
  h.setResearch({status:'failed',progress:12,report:report(),error,cooldown:{next_retry_at:until},issues:[error],automation:{enabled:true,status:'retry_wait',reason:'Automatic historical retry is scheduled.',next_retry_at:until}});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-status').textContent,'Waiting for retry');assert.equal(h.elements.get('research-failure').hidden,false);
  assert.equal(h.elements.get('research-failure-title').textContent,'Zerodha request limit reached');assert.match(h.elements.get('research-failure-details').innerHTML,/>429<.*symbol history.*INFY/s);
  assert.match(h.elements.get('research-retry').textContent,/Automatic retry scheduled.*10:02/s);assert.equal(h.elements.get('research-error').textContent,'');
  assert.equal(h.elements.get('research-start').disabled,true);assert.equal(h.elements.get('research-refresh').disabled,false);assert.equal(h.elements.get('research-report').hidden,false);
  await h.run("researchAction('start')");await h.run("researchAction('start')");assert.equal(h.requests.some(request=>request.url==='/api/research/start'),false);
  h.setResearch({status:'cancelled',error,cooldown:{next_retry_at:until},automation:{enabled:true,status:'cancelled',reason:'Automatic research was cancelled.'}});await h.run('loadResearch()');
  await h.run("researchAction('start')");assert.equal(h.elements.get('research-start').disabled,true);assert.equal(h.requests.some(request=>request.url==='/api/research/start'),false);
  h.setState({...current(),server_time:'2026-09-17T10:02:01+05:30'});h.setResearch({status:'cancelled',error,cooldown:null,automation:{enabled:true,status:'cancelled'}});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-start').disabled,false);await h.run("researchAction('start')");assert.equal(h.requests.filter(request=>request.url==='/api/research/start').length,1);
});

test('worker timeouts and permission failures show distinct causes without claiming a broker API limit',async()=>{
  const h=await harness();
  h.setResearch({status:'failed',error:{code:'worker_timeout',message:'Historical simulation exceeded its time limit.',http_status:null,phase:'worker_enhanced',symbol:null,retryable:false,next_retry_at:null},automation:{enabled:true,status:'action_required',reason:'Automatic retry is paused after the simulation time limit.'}});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-failure-title').textContent,'Historical simulation timed out');assert.equal(h.elements.get('research-status').textContent,'Failed');
  assert.match(h.elements.get('research-failure-details').innerHTML,/worker timeout/);assert.doesNotMatch(h.elements.get('research-failure-details').innerHTML,/HTTP status|429|Time limit|Candles processed|Timeout scope/);
  assert.match(h.elements.get('research-retry').textContent,/Action is required.*Automatic retry is paused/);assert.equal(h.elements.get('research-start').disabled,false);
  h.setResearch({status:'failed',error:{code:'worker_timeout',message:'The enhanced pass reached its limit.',phase:'worker_enhanced',runtime_budget_ms:1800000,processed_bars:12345,total_bars:200000,timeout_kind:'variant'}});await h.run('loadResearch()');
  assert.match(h.elements.get('research-failure-details').innerHTML,/Time limit.*30 minutes \(1,800 seconds\).*Candles processed.*12,345 \/ 2,00,000.*Timeout scope.*Single comparison pass/s);
  h.setResearch({status:'failed',error:{code:'worker_timeout',message:'Comparison job reached its limit.',runtime_budget_ms:500,processed_bars:0,total_bars:200000,timeout_kind:'watchdog'}});await h.run('loadResearch()');assert.match(h.elements.get('research-failure-details').innerHTML,/0\.5 seconds.*Candles processed.*0 \/ 2,00,000.*Combined comparison job/s);
  h.setResearch({status:'failed',error:{code:'permission',message:'Historical data access is unavailable for this account.',http_status:403,phase:'symbol_history',symbol:'NIFTY 50',retryable:false,next_retry_at:null},automation:{enabled:true,status:'action_required',reason:'Check historical data access in your Kite application.'}});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-failure-title').textContent,'Historical data access denied');assert.match(h.elements.get('research-retry').textContent,/Action is required/);
  assert.doesNotMatch(h.elements.get('research-message').textContent,/\[object Object\]/);
});

test('partial reports and current collection issues retain safe HTTP, phase and symbol details',async()=>{
  const h=await harness(),issue={code:'network',message:'Broker history <unavailable>',http_status:503,phase:'context_history',symbol:'<INDEX>',retryable:true};
  h.setResearch({status:'complete',report:{...report(),metadata:{issues:[issue]}},issues:[issue]});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-issues').hidden,false);assert.equal(h.elements.get('research-errors-panel').hidden,false);
  for(const id of ['research-issues-list','research-errors']){
    const text=h.elements.get(id).innerHTML;assert.match(text,/HTTP 503/);assert.match(text,/context history/);assert.match(text,/&lt;INDEX&gt;/);assert.doesNotMatch(text,/<INDEX>/);
  }
});

test('Background distinguishes real historical API cooldowns from ordinary research failures and clears recovered limits',async()=>{
  const h=await harness(),until='2026-09-17T10:02:00+05:30',error={code:'rate_limit',message:'Zerodha historical requests reached a limit.',http_status:429,phase:'context_history',symbol:'NIFTY 50',retryable:true,next_retry_at:until};
  const category={category:'historical',status:'cooldown',retry_at:until,retry_after_seconds:120,rate_limited_responses:2,blocked_requests:8};
  h.setState({...current(),server_time:'2026-09-17T10:00:00+05:30',api_limits:{status:'cooldown',categories:[category]},background:{research:{status:'failed',error,cooldown:{next_retry_at:until},automation:{enabled:true,status:'retry_wait',reason:'Automatic retry scheduled.'}}}});
  assert.equal(h.elements.get('background-api').hidden,false);assert.match(h.elements.get('background-api-categories').innerHTML,/Historical data.*120 seconds remaining.*8 requests deferred locally/s);
  assert.equal(h.elements.get('background-research-status').textContent,'Waiting for retry');assert.match(h.elements.get('background-research-error').textContent,/HTTP 429.*context history/);
  assert.equal(h.elements.get('research-start').disabled,true,'A reported historical API cooldown blocks starting a new research run');
  h.setState({...current(),api_limits:{status:'ready',categories:[{...category,status:'ready',retry_at:null,retry_after_seconds:0}]}});
  assert.equal(h.elements.get('background-api-title').textContent,'Broker rate-limit history');assert.equal(h.elements.get('research-start').disabled,false);
});

test('a late Start HTTP 429 reloads safe retry status and blocks further starts if that status read fails',async()=>{
  const h=await harness();h.setResearch({status:'idle'});await h.run('loadResearch()');
  h.researchStart(()=>({ok:false,status:429,json:async()=>({detail:'Research is rate limited. Wait for the scheduled retry.'})}));
  h.customGet(()=>{throw new Error('Status temporarily unavailable');});await h.run("researchAction('start')");
  assert.equal(h.elements.get('research-start').disabled,true);assert.match(h.elements.get('research-retry').textContent,/server to confirm/);
  await h.run("researchAction('start')");assert.equal(h.requests.filter(request=>request.url==='/api/research/start').length,1);
  h.customGet(null);h.setResearch({status:'idle',cooldown:null});await h.run('loadResearch()');assert.equal(h.elements.get('research-start').disabled,false);
});

const tuningResult=()=>({status:'accepted',reason:'The finalist passed the required validation and final-test checks.',parameters:{min_signal_score:65,min_adx:22},incumbent_parameters:{min_signal_score:60,min_adx:20},selected_id:'candidate-1',ranges:{'5minute':{train:{from:'2026-07-01',to:'2026-08-10'},validation:{from:'2026-08-11',to:'2026-08-25'},test:{from:'2026-08-26',to:'2026-09-16'}}},limits:{max_candidates:9,max_runtime_ms:600000},elapsed_ms:12345,holdout_consumed:true,application:{status:'waiting',reason:'Waiting for flat managed exposure and no active orders.',changes:[]},trials:[{id:'candidate-1',parameters:{min_signal_score:65,min_adx:22},train:{'5minute':{metrics:{net_return_pct:1.25,max_drawdown_pct:0.8,trade_count:21},data_quality:{eligible:true}}},validation:{'5minute':{metrics:{net_return_pct:0.75,max_drawdown_pct:0.5,trade_count:12},data_quality:{eligible:true}}},test:{'5minute':{metrics:{net_return_pct:0.6,max_drawdown_pct:0.4,trade_count:10},data_quality:{eligible:true}}},status:'accepted',reason:'All checks passed.'}]});

test('tuning uses the overall run bar and keeps a previous verdict separate from active trials',async()=>{
  const h=await harness();assert.equal(h.elements.get('research-tuning').hidden,true);
  h.setResearch({status:'running',progress:80,tuning:{phase:'tuning_validation',trial:3,trial_count:9,progress:0.375,message:'Checking candidate <three>.'}});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-tuning').hidden,false);assert.equal(h.elements.get('tuning-result').hidden,true);
  assert.equal(h.elements.get('tuning-phase').textContent,'Evaluation 3 of 9 · Validating candidates');assert.equal(h.elements.has('tuning-progress'),false);assert.equal(h.elements.get('research-progress').value,80);
  assert.equal(h.elements.get('tuning-message').textContent,'Checking candidate <three>.');
  h.setResearch({status:'running',tuning:{phase:'tuning_test',message:'Awaiting final-test progress.'},report:{...report(),optimization:{...tuningResult(),status:'no_improvement',reason:'Previous finalist failed.',application:{status:'not_applied',reason:'No validated candidate.'}}}});await h.run('loadResearch()');
  assert.equal(h.elements.get('tuning-active-sets').innerHTML,'');
  assert.match(h.elements.get('tuning-report-note').textContent,/Previous completed/);assert.equal(h.elements.get('tuning-verdict').textContent,'No validated improvement');assert.equal(h.elements.get('tuning-status').textContent,'Trials in progress');
});

test('accepted historical tuning is distinct from safe-point application in either execution mode',async()=>{
  const h=await harness(),optimization=tuningResult();
  for(const mode of ['paper','live']){
    h.setState({...current(),mode,status:'paused'});h.setResearch({status:'complete',report:{...report(),optimization}});await h.run('loadResearch()');
    assert.equal(h.elements.get('tuning-verdict').textContent,'Passed historical checks');assert.equal(h.elements.get('tuning-application').textContent,'Waiting to apply settings');
    assert.equal(h.elements.get('research-cancel').disabled,false);assert.equal(h.elements.get('research-cancel').textContent,'Cancel queued change');
    assert.match(h.elements.get('tuning-ranges').innerHTML,/Intraday · Final-test dates.*26 Aug 2026.*16 Sept 2026/s);
    assert.match(h.elements.get('tuning-application-reason').textContent,/flat managed exposure/);assert.match(h.elements.get('tuning-parameters').innerHTML,/>60<.*>65<.*Not applied/s);
    h.setResearch({status:'complete',report:{...report(),optimization:{...optimization,application:{status:'applied',reason:'Thresholds updated in the existing execution mode.',applied_at:'2026-09-17T10:15:00+05:30',changes:[{key:'min_signal_score',before:60,after:65},{key:'min_adx',before:20,after:22}]}}}});await h.run('loadResearch()');
    assert.equal(h.elements.get('tuning-application').textContent,'Settings applied');assert.match(h.elements.get('tuning-parameters').innerHTML,/>60<.*>65<.*>65</s);assert.match(h.elements.get('tuning-applied-at').textContent,/10:15:00 IST/);
    assert.equal(h.run('state.mode'),mode);assert.equal(h.run('state.status'),'paused');
  }
  assert.equal(h.requests.some(request=>request.options.method==='POST'),false);
});

test('tuning trial evidence preserves interval metrics, missing stages and escaped rejection reasons',async()=>{
  const h=await harness(),optimization=tuningResult(),trial=optimization.trials[0];
  optimization.status='no_improvement';optimization.parameters=null;optimization.application={status:'not_applied',reason:'Final-test result did not qualify.'};
  optimization.trials=[{...trial,id:'<candidate>',parameter_set_id:'<candidate>',status:'test_failed',reason:'Missing <history>',train:{...trial.train,day:{metrics:{net_return_pct:-0.5,max_drawdown_pct:1.5,trade_count:4},data_quality:{eligible:false,reason:'Too few <trades>'}}},test:undefined}];
  h.setResearch({status:'complete',report:{...report(),optimization}});await h.run('loadResearch()');
  const rows=h.elements.get('tuning-trials').innerHTML;
  assert.match(rows,/Intraday · 5-minute/);assert.match(rows,/Swing · daily/);assert.match(rows,/1\.25% net/);assert.match(rows,/-0\.5% net/);assert.doesNotMatch(rows,/125%/);
  assert.match(rows,/Not evaluated/);assert.match(rows,/&lt;candidate&gt;/);assert.match(rows,/Missing &lt;history&gt;/);assert.match(rows,/Too few &lt;trades&gt;/);assert.doesNotMatch(rows,/<candidate>|<history>|<trades>/);
  assert.equal(h.elements.get('tuning-parameters-panel').hidden,true);assert.match(h.elements.get('tuning-limits').textContent,/overlapping dates cannot be reused/);
});

test('tuning reports fresh-data waits, exhausted budgets and stale settings without manufacturing a winner',async()=>{
  const h=await harness();
  for(const [status,label] of [['waiting_for_fresh_data','Waiting for fresh test dates'],['budget_exhausted','Trial budget reached'],['insufficient_data','Not enough usable data'],['disabled','Tuning disabled']]){
    h.setResearch({status:'complete',report:{...report(),optimization:{status,reason:'No candidate can be applied.',parameters:null,trials:[],application:{status:'stale',reason:'Settings changed after these trials.'}}}});await h.run('loadResearch()');
    assert.equal(h.elements.get('tuning-verdict').textContent,label);assert.equal(h.elements.get('tuning-application').textContent,'Candidate no longer current');assert.equal(h.elements.get('tuning-parameters-panel').hidden,true);assert.equal(h.elements.get('tuning-trials-panel').hidden,true);
  }
});

test('applied tuning refreshes clean loaded settings once and preserves unsaved edits',async()=>{
  const h=await harness();h.run("showPage('settings')");await flush();const before=h.requests.filter(request=>request.url==='/api/config').length;
  const application={status:'applied',applied_at:'2026-09-17T10:00:00+05:30',changes:[{key:'min_signal_score',before:60,after:65}]};
  h.setState({...current(),background:{research:{tuning:{application}}}});await flush();
  assert.equal(h.requests.filter(request=>request.url==='/api/config').length,before+1);
  h.setState({...current(),background:{research:{tuning:{application}}}});await flush();
  h.setResearch({status:'complete',report:{...report(),optimization:{...tuningResult(),application}}});await h.run('loadResearch()');await flush();
  assert.equal(h.requests.filter(request=>request.url==='/api/config').length,before+1,'The same application arriving over polling and Research does not reload twice');
  h.elements.get('config-form').elements.min_signal_score.value='73';h.elements.get('config-form').events.input();
  h.setState({...current(),background:{research:{tuning:{application:{...application,applied_at:'2026-09-17T10:01:00+05:30'}}}}});await flush();
  assert.equal(h.elements.get('config-form').elements.min_signal_score.value,'73');assert.equal(h.requests.filter(request=>request.url==='/api/config').length,before+1);assert.match(h.elements.get('config-message').textContent,/unsaved settings are unchanged/);
});

function selectableTuning(){const optimization=tuningResult(),effective={min_signal_score:60,min_adx:20,min_setup_volume:1.5,max_atr_extension:2};return {...optimization,status:'no_improvement',report_id:'report-saved-1',parameters:null,incumbent_parameters:effective,trials:[{...optimization.trials[0],id:'incumbent',parameter_set_id:'P1',parameters:{},effective_parameters:effective,application_eligible:true,application_reason:'Completed reference set can be selected manually.'},{...optimization.trials[0],id:'candidate_1',parameter_set_id:'P2',parameters:{min_signal_score:55},effective_parameters:{...effective,min_signal_score:55},status:'validation_failed',reason:'Validation did not improve net performance.',application_eligible:true,application_reason:'Manual selection is available despite the failed validation check.'}],application:{status:'not_applied',reason:'No automatic winner.'}};}

test('manual selection sends only saved identifiers once and shows all values of the applied set',async()=>{
  const h=await harness(),optimization=selectableTuning();h.setState({...current(),mode:'live',status:'paused'});h.setResearch({status:'complete',report:{...report(),optimization}});await h.run('loadResearch()');
  const setTable=h.elements.get('tuning-sets').innerHTML,p2Row=[...setTable.matchAll(/<tr>[\s\S]*?<\/tr>/g)].find(row=>row[0].includes('<strong>P2</strong>'))?.[0]||'';
  assert.match(setTable,/P1.*P2/s);assert.match(setTable,/Minimum relative volume.*Maximum ATR extension/s);assert.match(p2Row,/>55<\/td>.*>20<\/td>.*>1\.5<\/td>.*>2<\/td>/s);assert.match(setTable,/validation failed/);
  let release;h.researchApply(()=>new Promise(resolve=>release=resolve));const first=h.run("applyResearchSet('report-saved-1','P2')");await flush();await h.run("applyResearchSet('report-saved-1','P2')");
  const posts=h.requests.filter(request=>request.url==='/api/research/apply');assert.equal(posts.length,1);assert.equal(posts[0].options.headers['X-CSRF-Token'],'research-csrf');assert.deepEqual(JSON.parse(posts[0].options.body),{report_id:'report-saved-1',parameter_set_id:'P2'});
  const applied={status:'complete',report:{...report(),optimization:{...optimization,application:{status:'applied',source:'manual',parameter_set_id:'P2',report_id:'report-saved-1',reason:'The selected set was applied.',applied_at:'2026-09-17T11:00:00+05:30',changes:[{key:'min_signal_score',before:65,after:55}]}}}};
  h.setResearch(applied);release({ok:true,status:200,json:async()=>applied});await first;
  assert.equal(h.elements.get('tuning-application-origin').textContent,'P2 · Manual selection');assert.match(h.elements.get('tuning-parameters').innerHTML,/>65<.*>55<.*>55<.*Minimum relative volume.*>1\.5<.*>1\.5</s);
  assert.equal(h.run('state.mode'),'live');assert.equal(h.run('state.status'),'paused');
});

test('legacy, ineligible and stale parameter selections do not submit and failed requests preserve evidence',async()=>{
  const h=await harness(),optimization=selectableTuning();h.setResearch({status:'complete',report:{...report(),optimization:{...optimization,report_id:undefined}}});await h.run('loadResearch()');
  assert.match(h.elements.get('tuning-selection-note').textContent,/older report/);await h.run("applyResearchSet('report-saved-1','P2')");
  h.setResearch({status:'complete',report:{...report(),optimization:{...optimization,trials:optimization.trials.map(trial=>({...trial,application_eligible:false,application_reason:'Report no longer matches the research context.'}))}}});await h.run('loadResearch()');await h.run("applyResearchSet('report-saved-1','P2')");
  assert.equal(h.requests.some(request=>request.url==='/api/research/apply'),false);
  h.setResearch({status:'complete',report:{...report(),optimization}});await h.run('loadResearch()');h.researchApply(()=>({ok:false,status:409,json:async()=>({detail:'Selected report is stale <rerun>.'})}));
  await h.run("applyResearchSet('different-report','P2')");await h.run("applyResearchSet('report-saved-1','P2')");assert.equal(h.requests.filter(request=>request.url==='/api/research/apply').length,1);
  assert.equal(h.elements.get('tuning-apply-error').textContent,'Selected report is stale <rerun>.');assert.match(h.elements.get('tuning-sets').innerHTML,/Validation did not improve/);
});

test('reserved final-test dates retain all saved parameter evidence and manual eligibility without claiming test results',async()=>{
  const h=await harness(),base=selectableTuning(),trials=base.trials.map((trial,index)=>({...trial,status:index?'final_test_pending':'incumbent',test:undefined}));
  const final_test_block={reason:'The requested final-test dates overlap <reserved> history.',blocked_intervals:[{interval:'5minute',reserved_through:'2026-09-16',test_from:'2026-08-26',test_to:'2026-09-16'},{interval:'<day>',reserved_through:'2026-09-15',test_from:'2026-08-25',test_to:'2026-09-15'}]};
  for(const [status,label] of [['waiting_for_fresh_data','Waiting for fresh test dates'],['no_improvement','No validated improvement'],['completed_with_errors','Completed with candidate errors']]){
    h.setResearch({status:'complete',report:{...report(),optimization:{...base,status,parameters:null,trials,final_test_allowed:false,final_test_block}}});await h.run('loadResearch()');
    assert.equal(h.elements.get('tuning-verdict').textContent,label);assert.equal(h.elements.get('tuning-final-test-wait').hidden,false);assert.equal(h.elements.get('tuning-final-test-reason').textContent,final_test_block.reason);assert.equal(h.elements.get('tuning-set-selection').hidden,false);
    const dates=h.elements.get('tuning-final-test-dates').innerHTML;assert.match(dates,/Intraday.*Reserved through: 16 Sept 2026.*26 Aug 2026.*16 Sept 2026/s);assert.match(dates,/&lt;day&gt;/);assert.doesNotMatch(dates,/<day>/);
    const table=h.elements.get('tuning-sets').innerHTML;assert.match(table,/P1.*P2.*0\.75% net.*Waiting for final test/s);assert.doesNotMatch(table,/data-apply-set="P2"[^>]*disabled/);assert.match(h.elements.get('tuning-trials').innerHTML,/1\.25% net.*0\.75% net.*Not evaluated/s);assert.equal(h.elements.get('tuning-application').textContent,'Settings not applied');
  }
  h.setResearch({status:'running',tuning:{phase:'tuning_train',trials,final_test_allowed:false,final_test_block}});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-final-test-wait').hidden,false);assert.equal(h.elements.get('tuning-result').hidden,true);assert.match(h.elements.get('tuning-live-sets').innerHTML,/P1.*P2/s);
  h.setResearch({status:'complete',report:{...report(),optimization:base}});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-final-test-wait').hidden,true);assert.equal(h.elements.get('tuning-final-test-dates').innerHTML,'');assert.equal(h.requests.some(request=>request.url==='/api/research/apply'),false);
});

test('an older empty fresh-date wait explains that a rerun is needed without inventing parameter rows',async()=>{
  const h=await harness(),optimization={status:'waiting_for_fresh_data',reason:'The final-test window was already reserved.',trials:[],parameters:null,consumed_test_dates:{'5minute':'2026-09-16'},application:{status:'not_applied'}};
  h.setResearch({status:'complete',report:{...report(),optimization}});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-set-selection').hidden,false);assert.equal(h.elements.get('tuning-selection-help').hidden,true);assert.match(h.elements.get('tuning-selection-note').textContent,/No parameter results were saved for this run\. Run analysis again/);assert.equal(h.elements.get('tuning-sets').innerHTML,'');assert.equal(h.elements.get('tuning-trials-panel').hidden,true);assert.match(h.elements.get('tuning-final-test-dates').innerHTML,/Reserved through: 16 Sept 2026/);
  h.setResearch({status:'running',tuning:{phase:'tuning_train'},report:{...report(),optimization}});await h.run('loadResearch()');assert.match(h.elements.get('tuning-selection-note').textContent,/previous run\. The new analysis is in progress/);assert.doesNotMatch(h.elements.get('tuning-selection-note').textContent,/Run analysis again/);
});

test('parallel tuning shows reported workers, active P sets and partial evidence without invented telemetry',async()=>{
  const h=await harness(),optimization=selectableTuning();
  h.setResearch({status:'running',tuning:{phase:'tuning_train',progress:0.2,message:'train: candidate_1',trials:optimization.trials,parallelism:{worker_limit:4,active_workers:2,completed_tasks:3,total_tasks:9,active_sets:[{parameter_set_id:'P2',phase:'tuning_train',interval:'5minute'},{parameter_set_id:'<P3>',phase:'tuning_validation',interval:'day'}]}}});await h.run('loadResearch()');
  assert.equal(h.elements.get('tuning-worker-counts').textContent,'2 active workers · 4 worker capacity · 3 of 9 tasks completed');assert.equal(h.elements.get('tuning-message').textContent,'train: P2');assert.match(h.elements.get('tuning-active-sets').innerHTML,/&lt;P3&gt;.*Validation/);assert.doesNotMatch(h.elements.get('tuning-active-sets').innerHTML,/<P3>/);
  assert.equal(h.elements.get('tuning-phase').textContent,'Training candidates · 3 of 9 sets finished in this phase');
  const liveTable=h.elements.get('tuning-live-sets').innerHTML,p2Row=[...liveTable.matchAll(/<tr>[\s\S]*?<\/tr>/g)].find(row=>row[0].includes('<strong>P2</strong>'))?.[0]||'';
  assert.match(liveTable,/Minimum trend strength/);assert.match(p2Row,/>55<\/td>.*>20<\/td>.*>1\.5<\/td>.*>2<\/td>/s);assert.doesNotMatch(liveTable,/data-apply-set/);
  h.setResearch({status:'running',tuning:{phase:'tuning_train',message:'Awaiting worker telemetry.'}});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-parallel').hidden,true);assert.equal(h.elements.get('tuning-worker-counts').textContent,'');assert.equal(h.elements.get('tuning-live-sets').innerHTML,'');
});

test('one overall bar follows reported run progress and candidate bars exist only while their phase is active',async()=>{
  const h=await harness(),optimization=selectableTuning(),p2={parameter_set_id:'P2',phase:'tuning_train',interval:'5minute',progress:0.25,processed_bars:250,total_bars:1000,completed_intervals:0,total_intervals:2},p3={parameter_set_id:'<P3>',phase:'tuning_train'};
  const update=async(status,progress,activeSets,trials=optimization.trials)=>{h.setResearch({status,progress,tuning:{phase:'tuning_train',trials,parallelism:{active_sets:activeSets}}});await h.run('loadResearch()');};
  await update('running',52,[p2,p3]);let rows=h.elements.get('tuning-active-sets').innerHTML;
  assert.equal(h.elements.get('research-progress').value,52);assert.equal(h.elements.has('tuning-progress'),false);assert.equal((rows.match(/<progress /g)||[]).length,2);
  assert.match(rows,/aria-label="P2 · Training progress"[^>]*value="25"/);assert.match(rows,/250 of 1,000 bars.*0 of 2 intervals complete/);assert.match(rows,/&lt;P3&gt; · Training progress/);assert.doesNotMatch(rows,/<P3>|aria-label="&lt;P3&gt; · Training progress"[^>]*value=/);assert.match(rows,/Progress not reported/);
  await update('running',58,[{...p2,progress:0.75,processed_bars:750},p3]);assert.equal(h.elements.get('research-progress').value,58);assert.match(h.elements.get('tuning-active-sets').innerHTML,/value="75"/);
  const failed={...optimization.trials[1],status:'error',error:{phase:'train',message:'Calculation failed.'}};
  await update('running',64,[p3],[optimization.trials[0],failed]);rows=h.elements.get('tuning-active-sets').innerHTML;assert.equal((rows.match(/<progress /g)||[]).length,1);assert.doesNotMatch(rows,/P2/);assert.match(h.elements.get('tuning-live-sets').innerHTML,/badge red[^>]*>Error/);
  await update('running',76,[]);assert.equal(h.elements.get('tuning-active-sets').innerHTML,'');
  await update('running',81,[{...p3,phase:'tuning_validation',progress:0.1}]);assert.match(h.elements.get('tuning-active-sets').innerHTML,/Validation progress"[^>]*value="10"/);
  await update('running',90,[{...p3,phase:'tuning_validation',progress:0.999999}]);assert.match(h.elements.get('tuning-active-sets').innerHTML,/Validation progress: 99\.9%/);assert.doesNotMatch(h.elements.get('tuning-active-sets').innerHTML,/progress: 100%/);
  for(const status of ['cancelled','failed','complete']){await update(status,status==='complete'?100:81,[p2,p3]);assert.equal(h.elements.get('tuning-active-sets').innerHTML,'');}
});

test('Research prominently reports the actual current task and falls back to known tuning phases',async()=>{
  const h=await harness();
  for(const [title,detail] of [['Downloading INFY candles','Five-minute history · 4 of 20 stocks'],['Preparing benchmark context','NIFTY 50 · daily candles'],['Comparing baseline rules','Intraday · baseline pass'],['Comparing enhanced rules','Intraday · enhanced pass']]){
    h.setResearch({status:'running',message:'Historical research is in progress.',progress:28,current_task:{title,detail}});await h.run('loadResearch()');assert.equal(h.elements.get('research-current-task').textContent,title);assert.equal(h.elements.get('research-message').textContent,detail);
  }
  for(const [phase,title] of [['tuning_train','Training parameter sets'],['tuning_validation','Validating parameter sets'],['tuning_test','Final-testing parameter sets']]){h.setResearch({status:'running',message:'Historical research is in progress.',tuning:{phase,parallelism:{active_sets:[{parameter_set_id:'P2',phase}]}}});await h.run('loadResearch()');assert.equal(h.elements.get('research-current-task').textContent,title);assert.match(h.elements.get('research-message').textContent,/Active sets: P2/);}
  h.setResearch({status:'collecting',message:'Downloading daily candles for <INFY>.',current_task:{title:'Downloading <INFY> candles',detail:'History <check>'}});await h.run('loadResearch()');assert.equal(h.elements.get('research-current-task').textContent,'Downloading <INFY> candles');assert.equal(h.elements.get('research-message').textContent,'History <check>');assert.equal(h.elements.get('research-current-task').innerHTML,'');
  h.setResearch({status:'cancelled',message:'Cancelled.',current_task:{title:'Downloading INFY candles',detail:'Outdated worker task.'}});await h.run('loadResearch()');assert.equal(h.elements.get('research-current-task').textContent,'Research cancelled');assert.equal(h.elements.get('research-message').textContent,'Cancelled.');
});

test('comparison workers show actual capacity and per-candle stock work separately from tuning candidates',async()=>{
  const h=await harness(),comparison={phase:'baseline',interval:'5minute',symbol_count:150,processed_bars:15000,total_bars:200000,capacity:{worker_limit:32},parallelism:{worker_limit:32,active_workers:12,batch_completed_symbols:70,batch_total_symbols:150,batch_timestamp:'2026-09-16T10:15:00+05:30'}};
  h.setResearch({status:'running',progress:24,comparison});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-comparison').hidden,false);assert.equal(h.elements.get('research-comparison-title').textContent,'Baseline comparison workers');let details=h.elements.get('research-comparison-details').innerHTML;
  assert.match(details,/Workers.*12 active \/ 32 capacity.*Stocks in comparison.*150.*Intraday · 5-minute.*Candles processed in this pass.*15,000 \/ 2,00,000/s);assert.match(h.elements.get('research-comparison-candle-details').innerHTML,/Historical candle.*10:15:00 IST.*Stock analyses at this candle.*70 \/ 150/s);assert.doesNotMatch(details,/Historical candle|Stock analyses at this candle/);assert.equal(h.elements.get('tuning-active-sets').innerHTML,'');assert.doesNotMatch(details,/<progress/);
  h.setResearch({status:'running',progress:28,progress_detail:{stage:'Enhanced comparison',stage_progress:8.025,unit:'candles',completed:16050,total:200000},comparison:{...comparison,phase:'enhanced',processed_bars:16050,parallelism:{...comparison.parallelism,active_workers:4,batch_completed_symbols:10,batch_timestamp:'2026-09-16T10:20:00+05:30'}}});await h.run('loadResearch()');assert.equal(h.elements.get('research-comparison-title').textContent,'Enhanced comparison workers');assert.match(h.elements.get('research-comparison-details').innerHTML,/4 active \/ 32 capacity.*16,050 \/ 2,00,000/s);assert.match(h.elements.get('research-comparison-candle-details').innerHTML,/10:20:00 IST.*10 \/ 150/s);assert.equal(h.elements.get('research-progress-label').textContent,'Overall work: 28%');assert.equal(h.elements.get('research-progress-detail').textContent,'Enhanced comparison: 8% · 16,050 / 2,00,000 candles');
  h.setResearch({status:'running',comparison:{phase:'validating',interval:'<interval>',symbol_count:150}});await h.run('loadResearch()');details=h.elements.get('research-comparison-details').innerHTML;assert.match(details,/&lt;interval&gt;/);assert.doesNotMatch(details,/active|capacity|Candles processed|Stock analyses at this candle|<interval>/);assert.equal(h.elements.get('research-progress-detail').hidden,true);assert.equal(h.elements.get('research-comparison-candle').hidden,true);
  for(const state of [{status:'collecting',comparison},{status:'running',comparison,tuning:{phase:'tuning_train',parallelism:{active_sets:[{parameter_set_id:'P2',phase:'tuning_train',progress:0.4}]}}},{status:'cancelled',comparison},{status:'failed',comparison},{status:'complete',comparison},{status:'running'}]){h.setResearch(state);await h.run('loadResearch()');assert.equal(h.elements.get('research-comparison').hidden,true);assert.equal(h.elements.get('research-comparison-details').innerHTML,'');if(state.tuning)assert.match(h.elements.get('tuning-active-sets').innerHTML,/P2 · Training progress/);}
});

test('candidate calculation errors preserve healthy evidence, explain the failed stage and prevent selection',async()=>{
  const h=await harness(),optimization=selectableTuning(),healthy=optimization.trials[0],rejected={...optimization.trials[1],status:'rejected',reason:'Training return was negative.'};
  const failed={...rejected,id:'candidate_2',parameter_set_id:'P3',status:'error',reason:'The validation worker failed.',error:{code:'worker_error',message:'Worker <memory> limit.',phase:'validation',interval:'5minute'},validation:undefined,test:undefined,application_eligible:true};
  const trials=[healthy,rejected,failed],parallelism={worker_limit:4,active_workers:1,completed_tasks:2,total_tasks:3,failed_tasks:1,active_sets:[{parameter_set_id:'P1',phase:'tuning_validation'}]};
  h.setResearch({status:'running',tuning:{phase:'tuning_validation',trials,parallelism}});await h.run('loadResearch()');
  assert.equal(h.elements.get('tuning-worker-counts').textContent,'1 active workers · 4 worker capacity · 2 of 3 tasks completed (1 failed)');
  assert.match(h.elements.get('tuning-live-sets').innerHTML,/badge red[^>]*>Error<.*Phase: Validation.*Intraday 5-minute.*worker error: Worker &lt;memory&gt; limit\./s);
  h.setResearch({status:'complete',report:{...report(),optimization:{...optimization,status:'completed_with_errors',failed_trials:1,trials}}});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-status').textContent,'Complete');assert.equal(h.elements.get('tuning-verdict').textContent,'Completed with candidate errors');assert.match(h.elements.get('tuning-report-note').textContent,/1 candidate calculation error/);
  const table=h.elements.get('tuning-sets').innerHTML,rows=[...table.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map(match=>match[0]),p2=rows.find(row=>row.includes('<strong>P2</strong>')),p3=rows.find(row=>row.includes('<strong>P3</strong>'));
  assert.match(p2,/badge amber[^>]*>rejected</);assert.doesNotMatch(p2,/badge red|data-apply-set="P2"[^>]*disabled/);
  assert.match(p3,/1\.25% net.*badge red[^>]*>Error<.*data-apply-set="P3"[^>]*disabled/s);assert.doesNotMatch(table,/<memory>/);
  assert.match(h.elements.get('tuning-trials').innerHTML,/badge red[^>]*>Error<.*Phase: Validation.*Worker &lt;memory&gt; limit\./s);
  await h.run("applyResearchSet('report-saved-1','P3')");assert.equal(h.requests.some(request=>request.url==='/api/research/apply'),false);
  for(const status of ['accepted','no_improvement']){h.setResearch({status:'complete',report:{...report(),optimization:{...optimization,status,failed_trials:1,trials}}});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-verdict').textContent,status==='accepted'?'Passed historical checks':'No validated improvement');assert.match(h.elements.get('tuning-report-note').textContent,/1 candidate calculation error/);}
  h.setResearch({status:'complete',report:{...report(),optimization}});await h.run('loadResearch()');assert.doesNotMatch(h.elements.get('tuning-report-note').textContent,/candidate calculation error/);
});

test('industry coverage counts only actual report instruments with fresh classifications',async()=>{
  const h=await harness(),diversification={policy:'industry_round_robin_v1',status:'diversified',requested_count:20,selected_count:20,classified_count:19,available_industries:8,members:[{symbol:'INFY',industry:'Information <technology>',classification_status:'fresh'},{symbol:'NO_HISTORY',industry:'Banking',classification_status:'fresh'},{symbol:'UNKNOWN',industry:null,classification_status:'unknown'},{symbol:'STALE',industry:'Old industry',classification_status:'stale'}],industries:[{industry:'Banking',symbols:['NO_HISTORY']}],caveat:'Industry spread cannot prevent a shared market decline.'};
  h.setResearch({status:'complete',report:{...report(),dataset:{...report().dataset,symbols:['INFY','UNKNOWN','STALE']},metadata:{diversification}}});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-diversification').hidden,false);assert.match(h.elements.get('research-diversification-summary').textContent,/20 requested.*20 selected.*3 instruments in this report across 1 classified industries/);
  assert.match(h.elements.get('research-industries').innerHTML,/Information &lt;technology&gt;.*INFY/);assert.doesNotMatch(h.elements.get('research-industries').innerHTML,/Banking|NO_HISTORY|Old industry|<technology>/);
  assert.match(h.elements.get('research-unclassified').textContent,/UNKNOWN, STALE/);assert.match(h.elements.get('research-diversification-caveat').textContent,/cannot prevent/);
  h.setResearch({status:'complete',report:report()});await h.run('loadResearch()');assert.equal(h.elements.get('research-diversification').hidden,true);
});

test('Research saves 150 stocks and 50 sets through the scoped endpoint without starting a run',async()=>{
  const h=await harness();await h.run('loadResearchSettings()');assert.equal(h.elements.get('research-sample-size').value,'20');assert.equal(h.elements.get('research-set-count').value,'9');assert.equal(h.elements.get('research-cpu-affinity').value,'pinned');
  h.elements.get('research-sample-size').value='150';h.elements.get('research-set-count').value='50';h.elements.get('research-cpu-affinity').value='automatic';h.elements.get('research-settings-form').events.input();
  await h.elements.get('research-settings-form').events.submit({preventDefault(){}});
  const writes=h.requests.filter(request=>request.options.method!=='GET');assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/research/settings');assert.equal(writes[0].options.method,'PUT');assert.equal(writes[0].options.headers['X-CSRF-Token'],'research-csrf');assert.deepEqual(JSON.parse(writes[0].options.body),{research_symbols:150,research_tuning_trials:50,research_cpu_affinity:'automatic'});assert.equal(h.elements.get('research-cpu-affinity').value,'automatic');
  assert.equal(h.elements.get('research-sample-size').value,'150');assert.equal(h.elements.get('research-set-count').value,'50');assert.match(h.elements.get('research-settings-status').textContent,/next manual or automatic run/);assert.equal(h.run('state.status'),'running');
});

test('CPU affinity distinguishes planned assignments, verified workers and failure or platform fallback',async()=>{
  const h=await harness(),plan={mode:'pinned',status:'planned',assignments:[{group:1,cpu:3,core:2}]};
  let research={status:'running',comparison:{phase:'baseline',capacity:{affinity:plan},parallelism:{active_workers:0,worker_limit:2,workers:[]}}};h.setResearch(research);await h.run('loadResearch()');
  assert.equal(h.elements.get('comparison-affinity').hidden,false);assert.match(h.elements.get('comparison-affinity-summary').textContent,/Pinning planned/);assert.doesNotMatch(h.elements.get('comparison-affinity-summary').textContent,/workers verified pinned/);assert.equal(h.elements.get('comparison-affinity-details').hidden,true);
  const workers=[{worker_id:17,affinity:{status:'pinned',verified:true,group:1,cpu:3,core:2}},{worker_id:18,affinity:{status:'pinned',verified:false,group:0,cpu:4}},{worker_id:19,affinity:{status:'failed',verified:false,reason:'Access <denied>'}}];
  research.comparison.parallelism.workers=workers;h.setResearch(research);await h.run('loadResearch()');
  assert.match(h.elements.get('comparison-affinity-summary').textContent,/1 of 3 reported workers verified pinned/);const rows=h.elements.get('comparison-affinity-workers').innerHTML;
  assert.match(rows,/Group 1 · CPU 3/);assert.match(rows,/Pin not verified/);assert.match(rows,/Pin failed/);assert.match(rows,/Access &lt;denied&gt;/);assert.doesNotMatch(rows,/<denied>/);
  workers[0].state='stopped';workers[1].state='starting';workers[2].state='retiring';research.comparison.parallelism.workers=workers;h.setResearch(research);await h.run('loadResearch()');assert.match(h.elements.get('comparison-affinity-summary').textContent,/0 of 1 current workers verified pinned/);assert.match(h.elements.get('comparison-affinity-summary').textContent,/2 retiring or stopped/);assert.match(h.elements.get('comparison-affinity-workers').innerHTML,/Stopped.*Previously verified pinned/s);workers[0].state='busy';
  research={status:'running',tuning:{phase:'tuning_train',capacity:{affinity:plan},parallelism:{workers,active_workers:1,worker_limit:2,active_sets:[{parameter_set_id:'P2',phase:'tuning_train',progress:.5,worker_id:17,affinity:workers[0].affinity}]}}};h.setResearch(research);await h.run('loadResearch()');
  assert.equal(h.elements.get('comparison-affinity').hidden,true);assert.equal(h.elements.get('comparison-affinity-workers').innerHTML,'');assert.equal(h.elements.get('tuning-affinity').hidden,false);assert.match(h.elements.get('tuning-active-sets').innerHTML,/P2.*Worker 17 · Verified pinned · Group 1 · CPU 3/s);
  research.tuning.capacity.affinity={mode:'pinned',status:'unsupported',reason:'macOS does not support hard pinning <reason>'};research.tuning.parallelism.workers=[{worker_id:20,affinity:{status:'unsupported',reason:'Using automatic scheduling'}}];research.tuning.parallelism.active_sets=[];h.setResearch(research);await h.run('loadResearch()');
  assert.match(h.elements.get('tuning-affinity-summary').textContent,/Pinning is unsupported; using automatic scheduling/);assert.match(h.elements.get('tuning-affinity-summary').textContent,/0 of 1 reported workers verified pinned/);assert.equal(h.elements.get('tuning-active-sets').innerHTML,'');
  research.tuning.capacity.affinity={mode:'automatic',status:'automatic'};h.setResearch(research);await h.run('loadResearch()');assert.match(h.elements.get('tuning-affinity-summary').textContent,/Automatic scheduling requested/);
  h.setResearch({...research,status:'cancelled'});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-affinity').hidden,true);assert.equal(h.elements.get('tuning-affinity-workers').innerHTML,'');
  h.setResearch({status:'running',comparison:{phase:'enhanced',parallelism:{active_workers:1}}});await h.run('loadResearch()');assert.equal(h.elements.get('comparison-affinity').hidden,true);
});

test('Settings labels CPU scheduling choices without changing their submitted enum values',async()=>{
  const h=await harness();h.run("renderConfig({fields:[{key:'research_cpu_affinity',label:'Research CPU scheduling',type:'select',choices:['pinned','automatic']}],values:{research_cpu_affinity:'automatic'}})");
  const fields=h.elements.get('config-fields').innerHTML;assert.match(fields,/value="pinned"[^>]*>Pin workers to CPUs/);assert.match(fields,/value="automatic" selected>Automatic scheduling/);
});

test('candidate processes and their analytics threads remain distinct across repeated thread IDs and cancellation',async()=>{
  const h=await harness(),workers=[{process_id:4201,worker_id:1,state:'busy',affinity:{status:'pinned',verified:true,group:0,cpu:3}},{process_id:4202,worker_id:1,state:'busy',affinity:{status:'pinned',verified:true,group:1,cpu:3}},{process_id:4100,worker_id:1,state:'stopped',affinity:{status:'pinned',verified:true,group:0,cpu:2}}];
  const tuning={phase:'tuning_train',capacity:{process_limit:96,threads_per_process:4,analytics_thread_limit:384,physical_cpus:96,cpu_target_percent:100,cpu_budget:192,allocated_cpu_threads:481,process_heap_mib:1024,analytics_worker_heap_mib:128,process_relay_memory_mib:1152,affinity:{mode:'pinned',status:'planned'}},parallelism:{worker_limit:96,active_workers:2,process_limit:96,active_processes:2,thread_limit:384,active_threads:6,completed_tasks:1,total_tasks:100,workers,active_sets:[{parameter_set_id:'P2',phase:'tuning_train',process_id:4201,thread_limit:4,active_threads:3,progress:.25,interval:'5minute',processed_bars:250,total_bars:1000},{parameter_set_id:'P3',phase:'tuning_train',process_id:4202,thread_limit:4,active_threads:3,progress:.5}]}};
  h.setResearch({status:'running',tuning});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-worker-counts').textContent,'2 active candidate processes · 96 process capacity · 6 active analytics threads · 384 analytics thread capacity · 1 of 100 tasks completed');
  const rows=h.elements.get('tuning-affinity-workers').innerHTML;assert.match(rows,/PID 4201 · Thread 1/);assert.match(rows,/PID 4202 · Thread 1/);assert.match(rows,/PID 4100 · Thread 1.*Stopped/s);assert.match(h.elements.get('tuning-affinity-summary').textContent,/2 of 2 current analytics threads verified pinned/);assert.equal(h.elements.get('tuning-affinity-identity').textContent,'Process / thread');
  assert.match(h.elements.get('tuning-active-sets').innerHTML,/P2.*Process 4201 · 3 active \/ 4 capacity analytics threads.*Current interval:.*250 of 1,000 bars/s);assert.match(h.elements.get('tuning-resource-details').textContent,/Physical cores available: 96.*192 logical CPUs \(100% allocation target, not a utilization guarantee\).*4 analytics threads per candidate process.*481 planned coordinator and analytics threads.*Portfolio worker heap allowance: 1,024 MiB.*128 MiB.*Process relay memory reserve: 1,152 MiB/);assert.equal(h.elements.get('tuning-resource-budget').hidden,false);
  assert.equal(h.elements.get('tuning-memory-status').hidden,true);Object.assign(tuning.parallelism,{memory_waiting:true,memory_wait_reason:'free_memory',available_memory_mib:4096,memory_reserve_mib:8192,initializing_processes:1,max_initializing:4,startup_memory_mib:2048});h.setResearch({status:'running',tuning});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-memory-status').textContent,'Waiting for free RAM; running candidates continue.');assert.equal(h.elements.get('tuning-memory-status').hidden,false);assert.match(h.elements.get('tuning-resource-details').textContent,/Free RAM reported: 4,096 MiB.*Free RAM reserve: 8,192 MiB.*Startup copies need additional memory.*Startup memory allowance per new process: 2,048 MiB.*1 \/ 4 initialization limit/);assert.match(h.elements.get('tuning-worker-counts').textContent,/2 active candidate processes · 96 process capacity/);
  Object.assign(tuning.parallelism,{memory_wait_reason:'initializing',available_memory_mib:32768,initializing_processes:4});h.setResearch({status:'running',tuning});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-memory-status').textContent,'Starting candidates in batches; running candidates continue.');assert.doesNotMatch(h.elements.get('tuning-memory-status').textContent,/Waiting for free RAM/);assert.match(h.elements.get('tuning-resource-details').textContent,/Free RAM reported: 32,768 MiB/);
  tuning.parallelism.memory_waiting=false;h.setResearch({status:'running',tuning});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-memory-status').hidden,true);assert.equal(h.elements.get('tuning-memory-status').textContent,'');tuning.parallelism.memory_waiting=true;
  h.setResearch({status:'cancelled',tuning});await h.run('loadResearch()');assert.equal(h.elements.get('tuning-affinity-workers').innerHTML,'');assert.equal(h.elements.get('tuning-active-sets').innerHTML,'');assert.equal(h.elements.get('tuning-resource-budget').hidden,true);assert.equal(h.elements.get('tuning-memory-status').hidden,true);
  h.setResearch({status:'running',tuning:{phase:'tuning_train',parallelism:{active_processes:1,process_limit:2,active_sets:[{parameter_set_id:'P4',phase:'tuning_train',process_id:4203}]}}});await h.run('loadResearch()');assert.doesNotMatch(h.elements.get('tuning-worker-counts').textContent,/analytics thread/);assert.equal(h.elements.get('tuning-resource-budget').hidden,true);assert.doesNotMatch(h.elements.get('tuning-active-sets').innerHTML,/capacity analytics threads/);
});

test('Research scope validates bounds, preserves unsaved input and refuses active or queued work',async()=>{
  const h=await harness();await h.run('loadResearchSettings()');h.elements.get('research-sample-size').value='151';h.elements.get('research-set-count').value='101';h.elements.get('research-settings-form').events.input();
  await h.run('loadResearchSettings(true)');assert.equal(h.elements.get('research-sample-size').value,'151');await h.elements.get('research-settings-form').events.submit({preventDefault(){}});assert.match(h.elements.get('research-settings-error').textContent,/1–150 stocks and 3–100/);
  h.elements.get('research-sample-size').value='150';h.elements.get('research-set-count').value='50';
  h.elements.get('research-cpu-affinity').value='exclusive';await h.elements.get('research-settings-form').events.submit({preventDefault(){}});assert.match(h.elements.get('research-settings-error').textContent,/Choose Pin workers/);h.elements.get('research-cpu-affinity').value='automatic';await h.run('loadResearchSettings(true)');assert.equal(h.elements.get('research-cpu-affinity').value,'automatic');
  for(const research of [{status:'running'},{status:'complete',report:{optimization:{application:{status:'waiting'}}}}]){h.setResearch(research);await h.run('loadResearch()');assert.equal(h.elements.get('research-settings-save').disabled,true);assert.equal(h.elements.get('research-cpu-affinity').disabled,true);await h.elements.get('research-settings-form').events.submit({preventDefault(){}});}
  assert.equal(h.requests.some(request=>request.url==='/api/research/settings'),false);
  h.setResearch({status:'idle'});await h.run('loadResearch()');h.researchSettings(()=>({ok:false,status:409,json:async()=>({detail:'A research run started before these settings could be saved.'})}));await h.elements.get('research-settings-form').events.submit({preventDefault(){}});
  assert.equal(h.elements.get('research-sample-size').value,'150');assert.equal(h.elements.get('research-set-count').value,'50');assert.match(h.elements.get('research-settings-error').textContent,/started before/);assert.equal(h.elements.get('research-settings-save').disabled,false);
});
