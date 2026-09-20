import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const script=fs.readFileSync(path.join(import.meta.dirname,'../public/app.js'),'utf8');
const html=fs.readFileSync(path.join(import.meta.dirname,'../public/index.html'),'utf8');
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function element(){return {hidden:false,disabled:false,textContent:'',innerHTML:'',value:'',dataset:{},style:{},elements:new Proxy({},{get:(target,key)=>target[key]||=element()}),classList:{toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){},querySelector:()=>element()};}
async function harness(initial=100){
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],element()])),requests=[],ledger=[];
  let live,release=null,holdNext=false,floor=0,clearFailed=false,clearCalls=0;
  const append=count=>{for(let i=0;i<count;i++){const id=ledger.length+1;ledger.push({id,timestamp:'2026-09-17T06:30:00Z',kind:id===125?'paper_fill':'synthetic',level:'info',message:`Event ${id}`,data:{}});}};
  append(initial);
  const state={connected:false,configured:true,status:'disconnected',mode:'paper',signals:[]};
  const context=vm.createContext({console,URL,URLSearchParams,Intl,AbortController,Date,
    document:{visibilityState:'visible',getElementById:id=>elements.get(id),querySelectorAll:()=>[],addEventListener(){}},
    window:{addEventListener(){}},location:{hostname:'example.trycloudflare.com',pathname:'/',hash:'',search:'',assign(){}},history:{replaceState(){}},navigator:{},setTimeout:()=>1,clearTimeout(){},
    createLiveView:options=>{live=options;return {start(){},stop(){}};},
    async fetch(url,options){
      requests.push(url);let data;
      if(url==='/api/session')data={csrf:'activity-csrf'};
      else if(url==='/api/config')data={fields:[],values:{},urls:{}};
      else if(url==='/api/events'&&options.method==='DELETE'){
        clearCalls++;assert.equal(options.headers['X-CSRF-Token'],'activity-csrf');
        if(clearFailed)return {ok:false,status:500,json:async()=>({detail:'Unable to clear activity. Try again.'})};
        floor=ledger.at(-1)?.id||0;data={ok:true,event_floor:floor,deleted:floor};
      }else if(url.startsWith('/api/state')){
        const after=new URL(url,'http://localhost').searchParams.get('after');
        const current=ledger.filter(row=>row.id>floor),events=after===null?current.slice(-500):current.filter(row=>row.id>Number(after)).slice(0,500);
        data={state,events,event_floor:floor,event_cursor:Math.max(floor,events.at(-1)?.id??Number(after??0))};
        if(holdNext){holdNext=false;await new Promise(resolve=>{release=resolve;});}
      }else throw new Error(`Unexpected activity request ${url}`);
      return {ok:true,status:200,json:async()=>structuredClone(data)};
    },
  });
  vm.runInContext(script,context,{filename:'public/app.js'});await flush();
  const run=code=>vm.runInContext(code,context);
  return {requests,append,run,live,elements,ids:()=>Array.from(run('events.map(row=>row.id)')),hold(){holdNext=true;},release(){release();},failClear(){clearFailed=true;},get clearCalls(){return clearCalls;},
    async poll(){const data=await live.fetchState({});live.onUpdate(data);},
    stream(from,to,event_floor=floor){live.onUpdate({state,events:ledger.filter(row=>row.id>=from&&row.id<=to),event_floor});}};
}

test('polling preserves bursts beyond 100 events and action refresh continues bounded pages',async()=>{
  const h=await harness();h.append(250);await h.poll();
  assert.equal(h.requests.at(-1),'/api/state?after=100');
  assert.deepEqual(h.ids(),Array.from({length:350},(_,i)=>i+1));
  assert.equal(h.run("events.some(row=>row.kind==='paper_fill')"),true);
  h.append(750);await h.poll();
  assert.equal(h.requests.at(-1),'/api/state?after=350');assert.equal(h.live.after(),850);
  await h.run('refresh()');
  assert.equal(h.requests.at(-1),'/api/state?after=850');assert.equal(h.live.after(),1100);
  assert.deepEqual(h.ids(),Array.from({length:500},(_,i)=>i+601));
  await h.poll();assert.equal(h.ids().length,500);assert.equal(h.live.after(),1100);
});

test('overlapping stream, polling and action refresh deduplicate without moving the activity cursor backwards',async()=>{
  const h=await harness();h.append(250);h.hold();const pending=h.poll();await flush();
  h.stream(101,200);assert.equal(h.live.after(),200);
  await h.run('refresh()');assert.equal(h.requests.at(-1),'/api/state?after=200');assert.equal(h.live.after(),350);
  h.release();await pending;
  assert.equal(h.live.after(),350);assert.deepEqual(h.ids(),Array.from({length:350},(_,i)=>i+1));
  h.stream(101,150);assert.equal(h.live.after(),350);assert.equal(h.ids().length,350);
});

test('Clear All clears every filter and stale polling/stream responses cannot restore deleted activity',async()=>{
  const h=await harness();h.run("showPage('activity');$('event-level').value='error';$('event-search').value='TEST';");
  h.hold();const pending=h.poll();await flush();
  const first=h.run('clearActivity()'),second=h.run('clearActivity()');await Promise.all([first,second]);assert.equal(h.clearCalls,1);
  assert.deepEqual(h.ids(),[]);assert.equal(h.live.after(),100);
  h.append(2);h.stream(101,102);h.release();await pending;h.stream(1,100,0);
  assert.deepEqual(h.ids(),[101,102]);assert.equal(h.live.after(),102);
  h.stream(1,102,102);assert.deepEqual(h.ids(),[],'A clear from another browser is reflected even without new events');
  h.append(1);await h.poll();assert.deepEqual(h.ids(),[103]);
});

test('a failed Clear All keeps activity and shows an actionable error',async()=>{
  const h=await harness();h.failClear();await h.run('clearActivity()');
  assert.equal(h.ids().length,100);assert.match(h.elements.get('activity-error').textContent,/Unable to clear/);
  assert.equal(h.elements.get('clear-activity').disabled,false);
});

test('activity troubleshooting is visible, escaped and limited to known destinations',async()=>{
  const h=await harness(0);h.run("showPage('activity');addEvents([{id:1,timestamp:'2026-09-17T06:30:00Z',level:'error',kind:'order_rejected',message:'Rejected',data:{},help:{steps:['Check <settings>'],links:[{label:'IP Whitelist',url:'https://developers.kite.trade/'},{label:'Bad',url:'javascript:alert(1)'},{label:'Maximum positions',page:'settings',target:'config-max_positions'}]}}])");
  const markup=h.elements.get('activity-list').innerHTML;
  assert.match(markup,/What to check/);assert.match(markup,/Check &lt;settings&gt;/);assert.match(markup,/data-help-target="config-max_positions"/);assert.match(markup,/https:\/\/developers.kite.trade\//);assert.doesNotMatch(markup,/javascript:|alert\(1\)/);
});
