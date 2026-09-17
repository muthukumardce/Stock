import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const script=fs.readFileSync(path.join(import.meta.dirname,'../public/app.js'),'utf8');
const html=fs.readFileSync(path.join(import.meta.dirname,'../public/index.html'),'utf8');
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function element(id=''){
  const events={},classes=new Set(),attributes={};
  return {id,hidden:false,disabled:false,textContent:'',innerHTML:'',value:'',dataset:{},style:{},events,attributes,
    elements:new Proxy({},{get:(target,key)=>target[key]||=(element(String(key)))}),
    classList:{toggle(name,active){if(active)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},
    setAttribute(name,value){attributes[name]=value;},removeAttribute(name){delete attributes[name];delete this[name];},
    addEventListener(name,fn){events[name]=fn;},querySelector:()=>element(),focus(){},select(){},showModal(){},
  };
}
const current=()=>({connected:true,configured:true,status:'running',mode:'paper',account_fresh:true,signals:[],strategy_settings:{intraday_enabled:true,intraday_allocation_pct:1,swing_allocation_pct:0}});
async function harness(){
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],element(match[1])])),requests=[],timers=new Map(),windowEvents={},documentEvents={};
  let timerId=0,research={status:'idle',progress:0,report:null},customGet=null,brokerState=current(),openSignals=[];
  const document={visibilityState:'visible',getElementById:id=>{assert.ok(elements.has(id),`Missing element ${id}`);return elements.get(id);},querySelectorAll:selector=>selector==='#signals-body details[open]'?openSignals:[],addEventListener:(name,fn)=>documentEvents[name]=fn};
  const context=vm.createContext({document,console,URL,URLSearchParams,Intl,AbortController,Date,
    window:{addEventListener:(name,fn)=>windowEvents[name]=fn,open(){throw new Error('Research must never open a broker order page');}},
    location:{hostname:'localhost',pathname:'/',hash:'',search:'',assign(){}},history:{replaceState(){}},navigator:{},
    setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    createLiveView:()=>({start(){},stop(){}}),
    async fetch(url,options){
      requests.push({url,options});let data;
      if(url==='/api/session')data={csrf:'research-csrf'};
      else if(url==='/api/config')data={fields:[],values:{},urls:{}};
      else if(url==='/api/state')data={state:brokerState,events:[]};
      else if(url==='/api/research')data=customGet?await customGet(options):research;
      else if(url==='/api/research/start')data=research={status:'collecting',progress:3,message:'Collecting historical candles',report:null};
      else if(url==='/api/research/cancel')data=research={...research,status:'cancelled',message:'Research cancelled'};
      else throw new Error(`Unexpected UI request ${url}`);
      return {ok:true,status:200,json:async()=>structuredClone(data)};
    },
  });
  vm.runInContext(script,context,{filename:'public/app.js'});await flush();
  return {context,elements,requests,timers,document,windowEvents,documentEvents,run:code=>vm.runInContext(code,context),
    setResearch(value){research=value;},customGet(fn){customGet=fn;},setOpenSignals(keys){openSignals=keys.map(key=>({dataset:{signal:key}}));},
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
  assert.equal([...h.timers.values()].filter(timer=>timer.delay===5000).length,1);
  h.document.visibilityState='hidden';h.documentEvents.visibilitychange();assert.equal([...h.timers.values()].filter(timer=>timer.delay===5000).length,0);
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

test('clock mismatch is visible with synchronization guidance and clears after a fresh aligned observation',async()=>{
  const h=await harness();
  h.setState({...current(),broker_clock:{status:'skewed',blocked:true,stale:false,offset_lower_ms:222000,offset_upper_ms:224000}});
  assert.equal(h.elements.get('clock-status').hidden,false);
  assert.match(h.elements.get('clock-status').textContent,/223 seconds behind/);
  assert.match(h.elements.get('clock-status').textContent,/New entries wait/);
  assert.equal(h.elements.get('engine-status').textContent,'Waiting for clock verification');
  assert.equal(h.elements.get('pause').disabled,false);
  h.setState({...current(),broker_clock:{status:'aligned',blocked:false,stale:false}});
  assert.equal(h.elements.get('clock-status').hidden,true);
  h.setState({...current(),broker_clock:{status:'uncertain',blocked:false,stale:true}});
  assert.equal(h.elements.get('clock-status').hidden,false);
  assert.match(h.elements.get('clock-status').textContent,/recent broker clock check/);
});
