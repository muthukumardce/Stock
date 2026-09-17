import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const script=fs.readFileSync(path.join(import.meta.dirname,'../public/app.js'),'utf8'),html=fs.readFileSync(path.join(import.meta.dirname,'../public/index.html'),'utf8');
function element(id=''){
  const events={},classes=new Set();return {id,events,hidden:false,disabled:false,textContent:'',innerHTML:'',value:'',style:{},dataset:{},
    elements:new Proxy({},{get:(target,key)=>target[key]||=(element(String(key)))}),
    classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},
    addEventListener:(name,fn)=>events[name]=fn,setAttribute(){},removeAttribute(name){delete this[name];},querySelector:()=>element(),focus(){},select(){},showModal(){}};
}
async function harness(){
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],element(match[1])])),requests=[];
  const initial={connected:true,configured:true,account_fresh:true,status:'running',mode:'paper'};
  const context=vm.createContext({console,URL,URLSearchParams,Date,Intl,AbortController,
    document:{visibilityState:'visible',getElementById:id=>{assert.ok(elements.has(id),`Missing element ${id}`);return elements.get(id);},querySelectorAll:()=>[],addEventListener(){}},
    window:{addEventListener(){},open(){throw new Error('Market context must not open external pages');}},
    location:{hostname:'localhost',pathname:'/',search:'',hash:'',assign(){}},history:{replaceState(){}},navigator:{},
    setTimeout(){return 1;},clearTimeout(){},createLiveView:()=>({start(){},stop(){}}),
    async fetch(url,options){requests.push({url,options});const data=url==='/api/session'?{csrf:'csrf'}:url==='/api/config'?{fields:[],values:{},urls:{}}:url==='/api/state'?{state:initial,events:[]}:null;assert.notEqual(data,null,'Unexpected request '+url);return {ok:true,status:200,json:async()=>data};},
  });vm.runInContext(script,context);for(let i=0;i<30;i++)await Promise.resolve();
  return {elements,requests,run:code=>vm.runInContext(code,context),setState(value){context.next={...initial,...value};vm.runInContext('render(next)',context);},setResearch(report){context.report=report;vm.runInContext("researchState={status:'complete',report};renderResearchReport()",context);}};
}

test('operational readiness and corporate-calendar blocks remain distinct, explicit and escaped',async()=>{
  const h=await harness();h.setState({readiness:{ready:true,checks:[{key:'broker_session',ok:true,detail:'Identity verified <source>'}],scope:'Operational prerequisites only.'},decision_controls:{market_context:{status:'partial',calendar:{status:'partial',risk_filter_enabled:true,blackout_before_days:1,blackout_after_days:1,sources:[{id:'calendar',status:'unavailable',last_error:'http_403'}]},classification:{coverage:.25,covered_symbols:500,universe_symbols:2000,message:'Known industry <coverage>'}}}});
  assert.equal(h.elements.get('readiness-status').textContent,'Operational checks passed');assert.match(h.elements.get('readiness-checks').innerHTML,/&lt;source&gt;/);
  assert.equal(h.elements.get('calendar-status').textContent,'Partial coverage');assert.match(h.elements.get('calendar-message').textContent,/New entries wait/);assert.match(h.elements.get('decision-blockers').innerHTML,/Corporate-event calendar coverage/);
  assert.equal(h.elements.get('classification-coverage').textContent,'25%');assert.match(h.elements.get('classification-count').textContent,/500 of 2,000/);assert.match(h.elements.get('context-sources').innerHTML,/http 403/);
});

test('blackouts and stale benchmarks expose actual source age without classifying absence as fresh',async()=>{
  const h=await harness();h.setState({decision_controls:{market_context:{status:'ready',calendar:{status:'fresh',risk_filter_enabled:true,blackout_count:1,blackout_symbols:[{symbol:'<script>INFY</script>',dates:['2026-09-18'],kinds:['financial_results']}],sources:[]},classification:{sources:[]},benchmarks:[{name:'NIFTY <50>',price:25000,change_from_open:-.015,trend:'mixed',quote_status:'stale',history_status:'fresh',bar_count:65,observed_at:'2026-09-17T12:00:00+05:30'}]}}});
  assert.equal(h.elements.get('calendar-blackout-panel').hidden,false);assert.match(h.elements.get('calendar-blackouts').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(h.elements.get('calendar-blackouts').innerHTML,/<script>/);
  const benchmarks=h.elements.get('context-benchmarks').innerHTML;assert.match(benchmarks,/NIFTY &lt;50&gt;/);assert.match(benchmarks,/-1\.5%/);assert.match(benchmarks,/Stale/);assert.equal(h.elements.get('classification-coverage').textContent,'—');
});

test('BUY/SELL entry direction appears in positions, signals and rankings while zero resource readings remain valid',async()=>{
  const h=await harness(),short={symbol:'INFY',strategy:'intraday',side:'SELL',quantity:5,entry:100,last:98,stop:102,target:96,unrealised:10,score:78,reason:'Downward setup'};
  h.setState({positions:[short,{...short,symbol:'TCS',side:'BUY'}],signals:[short],resources:{disk_free_mib:2048,memory_free_mib:1024,event_loop_delay_ms:0},decision_controls:{ranked_candidates:[short],candidate_count:1}});
  assert.match(h.elements.get('positions-body').innerHTML,/SELL · Short/);assert.match(h.elements.get('positions-body').innerHTML,/BUY · Long/);assert.match(h.elements.get('signals-body').innerHTML,/SELL · Short/);assert.match(h.elements.get('ranked-candidates').innerHTML,/SELL · Short/);
  assert.equal(h.elements.get('resource-disk-free').textContent,'2 GiB');assert.equal(h.elements.get('resource-memory-free').textContent,'1 GiB');assert.equal(h.elements.get('resource-loop-delay').textContent,'0 ms');assert.equal(h.requests.some(request=>request.options.method==='POST'),false);
});

function report(interval='5minute'){
  return {dataset:{interval,symbol_count:1,bar_count:100,from:'2026-09-01',to:'2026-09-16',requested_from:'2026-08-01',requested_to:'2026-09-16'},
    baseline:{metrics:{net_return_pct:interval==='day'?2:1},trades:[{symbol:'INFY',side:'SELL',quantity:2,entry:100,exit:103,pnl:-6,reason:'stop_gap',entry_time:'2026-09-15T10:00:00+05:30',exit_time:'2026-09-15T11:00:00+05:30'}],open_positions:[]},
    enhanced:{metrics:{net_return_pct:interval==='day'?3:1.5},trades:[],open_positions:[{symbol:'TCS',side:'BUY',quantity:1,entry:100,last:102,stop:95,target:110,unrealised_pnl:2}],decisions:{opening_gap_invalidates_signal:3}},
    caveats:['Missing timestamps may exclude halt <sessions>.']};
}
test('research interval switching preserves separate metrics, entry sides, open exposure and execution-gap evidence',async()=>{
  const h=await harness(),primary=report();primary.alternate_reports={day:report('day')};h.setResearch(primary);
  assert.equal(h.elements.get('research-interval').disabled,false);assert.match(h.elements.get('research-interval').innerHTML,/Swing/);assert.match(h.elements.get('research-metrics-body').innerHTML,/>1\.5%</);
  assert.match(h.elements.get('research-trades').innerHTML,/SELL · Short/);assert.match(h.elements.get('research-open-positions').innerHTML,/BUY · Long/);assert.match(h.elements.get('research-gap-notes').innerHTML,/3 recorded decision/);assert.match(h.elements.get('research-gap-notes').innerHTML,/halt &lt;sessions&gt;/);
  assert.match(h.elements.get('research-scope').innerHTML,/Actual candle range/);assert.match(h.elements.get('research-scope').innerHTML,/Requested range/);
  h.elements.get('research-interval').value='day';h.elements.get('research-interval').events.change();assert.match(h.elements.get('research-metrics-body').innerHTML,/>3%</);assert.equal(h.elements.get('research-interval').value,'day');
  h.setResearch(primary);assert.equal(h.elements.get('research-interval').value,'day');assert.match(h.elements.get('research-metrics-body').innerHTML,/>3%</);
});

test('failed prerequisite details are requirements rather than success claims; unavailable resource values remain dashes',async()=>{
  const h=await harness();h.setState({readiness:{ready:false,checks:[{key:'machine_capacity',ok:false,detail:'journal_disk_capacity'}]},resources:{disk_free_mib:null,memory_free_mib:null,event_loop_delay_ms:null}});
  assert.equal(h.elements.get('readiness-status').textContent,'Entry prerequisites pending');assert.match(h.elements.get('readiness-checks').innerHTML,/Required: journal_disk_capacity/);assert.equal(h.elements.get('resource-disk-free').textContent,'—');assert.equal(h.elements.get('resource-loop-delay').textContent,'—');
});
