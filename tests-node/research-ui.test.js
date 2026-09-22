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
  let timerId=0,research={status:'idle',progress:0,report:null},customGet=null,customTrading=null,customResearchStart=null,customResearchApply=null,customResearchSettings=null,configValues={research_symbols:20,research_cpu_affinity:'pinned'},brokerState=current(),openSignals=[];
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

async function riskHarness(){
  const h=await harness();
  const values={daily_loss_pct:.01,risk_per_trade_pct:.0025,max_account_risk_pct:.03,max_position_pct:.10,max_account_stock_pct:.25,portfolio_risk_enabled:true,max_positions:5,max_spread_pct:.003,min_daily_turnover:10000000,trading_mode:'paper',live_trading_enabled:false};
  const form=h.elements.get('config-form');
  for(const [key,value]of Object.entries(values)){form.elements[key].value=String(value);form.elements[key].checked=value===true;}
  h.context.configData={values,fields:Object.keys(values).map(key=>({key,type:typeof values[key]==='boolean'?'checkbox':typeof values[key]==='number'?'number':'text'})),urls:{}};
  h.run('renderConfig(configData)');
  return h;
}

test('daily risk preset splits the chosen budget across slots without multiplying total planned risk',async()=>{
  const h=await harness();
  for(const percent of [.5,1,5,10])for(const slots of [1,5,50]){
    const preset=h.run(`dailyRiskPreset(${percent},${slots})`);
    assert.equal(preset.daily_loss_pct,percent/100);assert.equal(preset.max_account_risk_pct,percent/100);
    assert(preset.risk_per_trade_pct*slots<=percent/100+1e-8);
    assert(preset.risk_per_trade_pct<=preset.max_position_pct);assert(preset.max_position_pct*slots<=1+1e-8);
    assert.equal(preset.max_account_stock_pct,preset.max_position_pct);assert.equal(preset.portfolio_risk_enabled,true);
  }
  for(const [percent,slots]of [[0,5],[11,5],[1.1,5],[10,0],[10,2.5],[10,51]])assert.throws(()=>h.run(`dailyRiskPreset(${percent},${slots})`));
});

test('10% slider previews linked budgets with the correct capital bases and sends no save request',async()=>{
  const h=await riskHarness(),form=h.elements.get('config-form'),before=h.requests.length;
  h.setState({...current(),capital:100000,equity:120000,broker_available_cash:90000,strategy_settings:{intraday_enabled:true,intraday_allocation_pct:.6,swing_enabled:true,swing_allocation_pct:.4},decision_controls:{portfolio:{reference_assets:200000}}});
  h.elements.get('daily-risk-slider').value='10';h.elements.get('daily-risk-slider').events.input();
  assert.equal(form.elements.daily_loss_pct.value,'0.1');assert.equal(form.elements.risk_per_trade_pct.value,'0.02');
  assert.equal(form.elements.max_account_risk_pct.value,'0.1');assert.equal(form.elements.max_position_pct.value,'0.2');assert.equal(form.elements.max_account_stock_pct.value,'0.2');
  assert.equal(form.elements.max_spread_pct.value,'0.003');assert.equal(form.elements.min_daily_turnover.value,'10000000');
  const preview=h.elements.get('risk-preset-preview').innerHTML;
  assert.match(preview,/10,000\.00/);assert.match(preview,/Intraday:.*1,200\.00/);assert.match(preview,/Swing:.*800\.00/);assert.match(preview,/20,000\.00/);
  assert.equal(h.elements.get('daily-risk-value').textContent,'10%');assert.equal(h.elements.get('risk-preset-status').textContent,'Unsaved preset');
  assert.match(h.elements.get('risk-capital-explanation').textContent,/simulated results/);assert.equal(h.requests.length,before);
  h.setState({...current(),capital:110000,mode:'live'});
  assert.equal(form.elements.daily_loss_pct.value,'0.1');assert.equal(h.elements.get('daily-risk-slider').value,'10');assert.match(h.elements.get('risk-capital-explanation').textContent,/cash uninvested/);
});

test('dashboard distinguishes paper equity from the eligible broker cash used for funding',async()=>{
  const h=await harness();
  h.setState({...current(),capital:100000,equity:105000,broker_available_cash:70000,account:{margins:{equity:{available:{cash:80000,live_balance:120000,collateral:50000}}}}});
  assert.match(h.elements.get('metric-equity').textContent,/1,05,000/);assert.match(h.elements.get('metric-cash').textContent,/70,000/);
  assert.match(h.elements.get('equity-detail').textContent,/simulated/);
  h.setState({...current(),mode:'live',capital:100000,equity:105000,broker_available_cash:0,account:{margins:{equity:{available:{live_balance:120000}}}}});
  assert.match(h.elements.get('metric-cash').textContent,/0/);assert.doesNotMatch(h.elements.get('metric-cash').textContent,/1,20,000/);
  assert.doesNotMatch(h.elements.get('equity-detail').textContent,/simulated/);
});

test('linked slots recalculate risk while manual edits stay custom through refresh and block saves after restart is required',async()=>{
  const h=await riskHarness(),form=h.elements.get('config-form');
  h.elements.get('daily-risk-slider').value='10';h.elements.get('daily-risk-slider').events.input();
  form.elements.max_positions.value='10';form.events.input({target:{name:'max_positions'}});
  assert.equal(form.elements.risk_per_trade_pct.value,'0.01');assert.equal(form.elements.max_position_pct.value,'0.1');
  form.elements.risk_per_trade_pct.value='0.03';form.events.input({target:{name:'risk_per_trade_pct'}});
  assert.equal(h.elements.get('risk-preset-status').textContent,'Custom settings');
  form.elements.max_positions.value='5';form.events.input({target:{name:'max_positions'}});assert.equal(form.elements.risk_per_trade_pct.value,'0.03');
  form.elements.daily_loss_pct.value='0.2';form.events.input({target:{name:'daily_loss_pct'}});
  assert.equal(h.elements.get('daily-risk-value').textContent,'20%');assert.match(h.elements.get('risk-preset-policy').textContent,/outside the slider/);
  h.setState({...current(),restart_required:true});
  assert.equal(h.elements.get('daily-risk-slider').disabled,true);assert.equal(h.elements.get('risk-preset-save').disabled,true);
  h.elements.get('daily-risk-slider').value='5';h.elements.get('daily-risk-slider').events.input();assert.equal(form.elements.daily_loss_pct.value,'0.2');
});

test('research is a separate page and disconnected accounts see no fabricated performance',async()=>{
  const h=await harness();assert.equal(h.requests.some(item=>item.url==='/api/research'),false);
  h.setState({...current(),connected:false});h.run("showPage('research')");await flush();
  assert.equal(h.elements.get('breadcrumb').textContent,'Strategy research');
  assert.equal(h.elements.get('research-start').disabled,true);assert.equal(h.elements.get('research-report').hidden,true);
  assert.equal(h.elements.get('research-metrics-body').innerHTML,'');
  assert.match(html,/simulated research/);assert.match(html,/does not refine parameters, change settings or place orders/);
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

test('index reports distinguish selected stocks from usable history and explain excluded constituents',async()=>{
  const h=await harness(),result=report();
  result.dataset.symbols=['INFY'];result.dataset.symbol_count=1;
  result.metadata={universe:{name:'NIFTY TOTAL MARKET',mode:'all',constituent_count:750,eligible_count:749,selected_count:749,observed_at:'2026-09-17T10:00:00Z',excluded_symbols:[{symbol:'MISSING',reason:'broker_instrument_unavailable'}],excluded_placeholders:[{symbol:'DUMMYHEG',reason:'index_corporate_action_placeholder'}]},
    diversification:{status:'diversified',requested_count:750,selected_count:749,members:[{symbol:'INFY',industry:'Information Technology',classification_status:'fresh'},{symbol:'NOHISTORY',industry:'Energy',classification_status:'fresh'}],caveat:'Current membership introduces survivorship bias.'}};
  h.setResearch({status:'complete',report:result});await h.run('loadResearch()');
  assert.match(h.elements.get('research-scope').innerHTML,/NIFTY TOTAL MARKET/);assert.match(h.elements.get('research-scope').innerHTML,/All eligible constituents/);
  assert.equal(h.elements.get('research-diversification-status').textContent,'All eligible stocks selected');
  assert.match(h.elements.get('research-diversification-summary').textContent,/1 instruments in this report across 1 classified industries/);
  assert.doesNotMatch(h.elements.get('research-industries').innerHTML,/NOHISTORY|Energy/);
  assert.match(h.elements.get('research-errors').innerHTML,/MISSING: No matching broker instrument.*NSE security universe/);
  assert.match(h.elements.get('research-errors').innerHTML,/DUMMYHEG: Corporate-action placeholder excluded/);
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

test('comparison workers show actual capacity and per-candle stock work separately from tuning candidates',async()=>{
  const h=await harness(),comparison={phase:'baseline',interval:'5minute',symbol_count:150,processed_bars:15000,total_bars:200000,capacity:{worker_limit:32},parallelism:{worker_limit:32,active_workers:12,batch_completed_symbols:70,batch_total_symbols:150,batch_timestamp:'2026-09-16T10:15:00+05:30'}};
  h.setResearch({status:'running',progress:24,comparison});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-comparison').hidden,false);assert.equal(h.elements.get('research-comparison-title').textContent,'Baseline comparison workers');let details=h.elements.get('research-comparison-details').innerHTML;
  assert.match(details,/Workers.*12 active \/ 32 capacity.*Stocks in comparison.*150.*Intraday · 5-minute.*Candles processed in this pass.*15,000 \/ 2,00,000/s);assert.match(h.elements.get('research-comparison-candle-details').innerHTML,/Historical candle.*10:15:00 IST.*Stock analyses at this candle.*70 \/ 150/s);assert.doesNotMatch(details,/Historical candle|Stock analyses at this candle/);assert.doesNotMatch(details,/<progress/);
  h.setResearch({status:'running',progress:28,progress_detail:{stage:'Enhanced comparison',stage_progress:8.025,unit:'candles',completed:16050,total:200000},comparison:{...comparison,phase:'enhanced',processed_bars:16050,parallelism:{...comparison.parallelism,active_workers:4,batch_completed_symbols:10,batch_timestamp:'2026-09-16T10:20:00+05:30'}}});await h.run('loadResearch()');assert.equal(h.elements.get('research-comparison-title').textContent,'Enhanced comparison workers');assert.match(h.elements.get('research-comparison-details').innerHTML,/4 active \/ 32 capacity.*16,050 \/ 2,00,000/s);assert.match(h.elements.get('research-comparison-candle-details').innerHTML,/10:20:00 IST.*10 \/ 150/s);assert.equal(h.elements.get('research-progress-label').textContent,'Overall work: 28%');assert.equal(h.elements.get('research-progress-detail').textContent,'Enhanced comparison: 8% · 16,050 / 2,00,000 candles');
  h.setResearch({status:'running',comparison:{phase:'validating',interval:'<interval>',symbol_count:150}});await h.run('loadResearch()');details=h.elements.get('research-comparison-details').innerHTML;assert.match(details,/&lt;interval&gt;/);assert.doesNotMatch(details,/active|capacity|Candles processed|Stock analyses at this candle|<interval>/);assert.equal(h.elements.get('research-progress-detail').hidden,true);assert.equal(h.elements.get('research-comparison-candle').hidden,true);
  for(const state of [{status:'collecting',comparison},{status:'cancelled',comparison},{status:'failed',comparison},{status:'complete',comparison},{status:'running'}]){h.setResearch(state);await h.run('loadResearch()');assert.equal(h.elements.get('research-comparison').hidden,true);assert.equal(h.elements.get('research-comparison-details').innerHTML,'');}
});

test('industry coverage counts only actual report instruments with fresh classifications',async()=>{
  const h=await harness(),diversification={policy:'industry_round_robin_v1',status:'diversified',requested_count:20,selected_count:20,classified_count:19,available_industries:8,members:[{symbol:'INFY',industry:'Information <technology>',classification_status:'fresh'},{symbol:'NO_HISTORY',industry:'Banking',classification_status:'fresh'},{symbol:'UNKNOWN',industry:null,classification_status:'unknown'},{symbol:'STALE',industry:'Old industry',classification_status:'stale'}],industries:[{industry:'Banking',symbols:['NO_HISTORY']}],caveat:'Industry spread cannot prevent a shared market decline.'};
  h.setResearch({status:'complete',report:{...report(),dataset:{...report().dataset,symbols:['INFY','UNKNOWN','STALE']},metadata:{diversification}}});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-diversification').hidden,false);assert.match(h.elements.get('research-diversification-summary').textContent,/20 requested.*20 selected.*3 instruments in this report across 1 classified industries/);
  assert.match(h.elements.get('research-industries').innerHTML,/Information &lt;technology&gt;.*INFY/);assert.doesNotMatch(h.elements.get('research-industries').innerHTML,/Banking|NO_HISTORY|Old industry|<technology>/);
  assert.match(h.elements.get('research-unclassified').textContent,/UNKNOWN, STALE/);assert.match(h.elements.get('research-diversification-caveat').textContent,/cannot prevent/);
  h.setResearch({status:'complete',report:report()});await h.run('loadResearch()');assert.equal(h.elements.get('research-diversification').hidden,true);
});

test('Research saves 150 index stocks through the scoped endpoint without starting a run',async()=>{
  const h=await harness();await h.run('loadResearchSettings()');assert.equal(h.elements.get('research-sample-size').value,'20');assert.equal(h.elements.get('research-cpu-affinity').value,'pinned');
  h.elements.get('research-sample-size').value='150';h.elements.get('research-cpu-affinity').value='automatic';h.elements.get('research-settings-form').events.input();
  await h.elements.get('research-settings-form').events.submit({preventDefault(){}});
  const writes=h.requests.filter(request=>request.options.method!=='GET');assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/research/settings');assert.equal(writes[0].options.method,'PUT');assert.equal(writes[0].options.headers['X-CSRF-Token'],'research-csrf');assert.deepEqual(JSON.parse(writes[0].options.body),{research_symbols:150,research_cpu_affinity:'automatic'});assert.equal(h.elements.get('research-cpu-affinity').value,'automatic');
  assert.equal(h.elements.get('research-sample-size').value,'150');assert.match(h.elements.get('research-settings-status').textContent,/next manual or automatic run/);assert.equal(h.run('state.status'),'running');
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
});

test('Settings labels CPU scheduling choices without changing their submitted enum values',async()=>{
  const h=await harness();h.run("renderConfig({fields:[{key:'research_cpu_affinity',label:'Research CPU scheduling',type:'select',choices:['pinned','automatic']}],values:{research_cpu_affinity:'automatic'}})");
  const fields=h.elements.get('config-fields').innerHTML;assert.match(fields,/value="pinned"[^>]*>Pin workers to CPUs/);assert.match(fields,/value="automatic" selected>Automatic scheduling/);
});

test('Research scope validates bounds, preserves unsaved input and refuses active work',async()=>{
  const h=await harness();await h.run('loadResearchSettings()');h.elements.get('research-sample-size').value='1001';h.elements.get('research-settings-form').events.input();
  await h.run('loadResearchSettings(true)');assert.equal(h.elements.get('research-sample-size').value,'1001');await h.elements.get('research-settings-form').events.submit({preventDefault(){}});assert.match(h.elements.get('research-settings-error').textContent,/1 to 1000/);
  h.elements.get('research-sample-size').value='150';
  h.elements.get('research-cpu-affinity').value='exclusive';await h.elements.get('research-settings-form').events.submit({preventDefault(){}});assert.match(h.elements.get('research-settings-error').textContent,/Choose Pin workers/);h.elements.get('research-cpu-affinity').value='automatic';await h.run('loadResearchSettings(true)');assert.equal(h.elements.get('research-cpu-affinity').value,'automatic');
  for(const research of [{status:'running'},{status:'collecting'}]){h.setResearch(research);await h.run('loadResearch()');assert.equal(h.elements.get('research-settings-save').disabled,true);assert.equal(h.elements.get('research-cpu-affinity').disabled,true);await h.elements.get('research-settings-form').events.submit({preventDefault(){}});}
  assert.equal(h.requests.some(request=>request.url==='/api/research/settings'),false);
  h.setResearch({status:'idle'});await h.run('loadResearch()');h.researchSettings(()=>({ok:false,status:409,json:async()=>({detail:'A research run started before these settings could be saved.'})}));await h.elements.get('research-settings-form').events.submit({preventDefault(){}});
  assert.equal(h.elements.get('research-sample-size').value,'150');assert.match(h.elements.get('research-settings-error').textContent,/started before/);assert.equal(h.elements.get('research-settings-save').disabled,false);
});

test('all constituents saves zero and legacy refinement reports expose no parameter actions',async()=>{
  const h=await harness();await h.run('loadResearchSettings()');
  h.setResearch({status:'complete',report:{...report(),optimization:{application:{status:'waiting'}}}});await h.run('loadResearch()');
  assert.equal(h.elements.get('research-settings-save').disabled,false);
  assert.doesNotMatch(html,/id="tuning-|id="research-set-count"|Parameter tuning/);
  h.elements.get('research-all-symbols').checked=true;h.elements.get('research-all-symbols').events.change();
  assert.equal(h.elements.get('research-sample-size').disabled,true);
  await h.elements.get('research-settings-form').events.submit({preventDefault(){}});
  const writes=h.requests.filter(request=>request.options.method!=='GET');assert.equal(writes.length,1);
  assert.deepEqual(JSON.parse(writes[0].options.body),{research_symbols:0,research_cpu_affinity:'pinned'});
  assert.equal(h.elements.get('research-all-symbols').checked,true);
  h.elements.get('research-all-symbols').checked=false;h.elements.get('research-all-symbols').events.change();
  assert.equal(h.elements.get('research-sample-size').disabled,false);
});
