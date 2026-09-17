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
  let live,release=null,holdNext=false;
  const append=count=>{for(let i=0;i<count;i++){const id=ledger.length+1;ledger.push({id,timestamp:'2026-09-17T06:30:00Z',kind:id===125?'paper_fill':'synthetic',level:'info',message:`Event ${id}`,data:{}});}};
  append(initial);
  const state={connected:false,configured:true,status:'disconnected',mode:'paper',signals:[]};
  const context=vm.createContext({console,URL,URLSearchParams,Intl,AbortController,Date,
    document:{visibilityState:'visible',getElementById:id=>elements.get(id),querySelectorAll:()=>[],addEventListener(){}},
    window:{addEventListener(){}},location:{hostname:'example.trycloudflare.com',pathname:'/',hash:'',search:'',assign(){}},history:{replaceState(){}},navigator:{},setTimeout:()=>1,clearTimeout(){},
    createLiveView:options=>{live=options;return {start(){},stop(){}};},
    async fetch(url){
      requests.push(url);let data;
      if(url==='/api/session')data={csrf:'activity-csrf'};
      else if(url==='/api/config')data={fields:[],values:{},urls:{}};
      else if(url.startsWith('/api/state')){
        const after=new URL(url,'http://localhost').searchParams.get('after');
        const events=after===null?ledger.slice(-500):ledger.filter(row=>row.id>Number(after)).slice(0,500);
        data={state,events,event_cursor:events.at(-1)?.id??Number(after??0)};
        if(holdNext){holdNext=false;await new Promise(resolve=>{release=resolve;});}
      }else throw new Error(`Unexpected activity request ${url}`);
      return {ok:true,status:200,json:async()=>structuredClone(data)};
    },
  });
  vm.runInContext(script,context,{filename:'public/app.js'});await flush();
  const run=code=>vm.runInContext(code,context);
  return {requests,append,run,live,ids:()=>Array.from(run('events.map(row=>row.id)')),hold(){holdNext=true;},release(){release();},
    async poll(){const data=await live.fetchState({});live.onUpdate(data);},
    stream(from,to){live.onUpdate({state,events:ledger.filter(row=>row.id>=from&&row.id<=to)});}};
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
