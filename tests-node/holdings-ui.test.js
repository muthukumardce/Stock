import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function element(){return {hidden:false,disabled:false,textContent:'',innerHTML:'',value:'',dataset:{},style:{},elements:new Proxy({},{get:(target,key)=>target[key]||=element()}),classList:{toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){},querySelector:()=>element()};}
async function harness(){
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],element()])),requests=[];
  const initial={connected:true,configured:true,status:'paused',mode:'paper',signals:[],account:{holdings:[]}};
  const context=vm.createContext({console,URL,URLSearchParams,Intl,AbortController,Date,
    document:{visibilityState:'visible',getElementById:id=>elements.get(id),querySelectorAll:()=>[],addEventListener(){}},
    window:{addEventListener(){}},location:{hostname:'localhost',pathname:'/',hash:'',search:'',assign(){}},history:{replaceState(){}},navigator:{},setTimeout:()=>1,clearTimeout(){},
    createLiveView:()=>({start(){},stop(){}}),
    async fetch(url,options){
      requests.push({url,method:options?.method||'GET'});
      const data=url==='/api/session'?{csrf:'holdings-csrf'}:url==='/api/config'?{fields:[],values:{},urls:{}}:url.startsWith('/api/state')?{state:initial,events:[]}:null;
      assert.notEqual(data,null,`Unexpected request ${url}`);return {ok:true,status:200,json:async()=>structuredClone(data)};
    },
  });
  vm.runInContext(script,context,{filename:'public/app.js'});for(let i=0;i<30;i++)await Promise.resolve();
  vm.runInContext("showPage('holdings')",context);
  return {requests,render(state){context.nextState={...initial,...state};vm.runInContext('render(nextState)',context);return elements.get('holdings-body').innerHTML;}};
}
const holding=(tradingsymbol,exchange='NSE')=>({tradingsymbol,exchange,quantity:10,average_price:100,last_price:101});

test('holdings show visible escaped status reasons, separate exchange decisions and exit-only scope',async()=>{
  const h=await harness(),body=h.render({account:{holdings:[holding('SAME'),holding('SAME','BSE'),holding('NOHISTORY'),holding('RECOVERY')]},holdings_signals:[
    {symbol:'SAME',exchange:'NSE',managed:true,status:'hold',reason:'Daily trend is intact.'},
    {symbol:'SAME',exchange:'BSE',managed:false,status:'unsupported',reason:'Unsupported <instrument> & exchange.'},
    {symbol:'NOHISTORY',exchange:'NSE',managed:false,status:'history_unavailable',reason:'History will retry automatically.'},
    {symbol:'RECOVERY',exchange:'NSE',managed:true,status:'exit_candidate',scope:'recovery_only',reason:'Trend weakened.',scope_reason:'Existing exposure is exit-only.'},
  ]});
  const rows=body.match(/<tr>.*?<\/tr>/g);assert.equal(rows.length,4);
  assert.match(rows[0],/>Managed<.*>Hold</);assert.match(rows[1],/>Observe only<.*>Unsupported</);
  assert.match(rows[1],/<small>Unsupported &lt;instrument&gt; &amp; exchange\.<\/small>/);assert.doesNotMatch(rows[1],/<instrument>/);
  assert.match(rows[2],/>No usable history</);assert.match(rows[2],/<small>History will retry automatically\.<\/small>/);
  assert.match(rows[3],/>Exit only<.*>Exit candidate</);assert.match(rows[3],/Trend weakened\. Existing exposure is exit-only\./);
  assert.doesNotMatch(body,/>Analysing</);assert.ok(h.requests.every(request=>request.method==='GET'));
});

test('holdings distinguish unavailable eligibility, pending history and feed from a missing status',async()=>{
  const h=await harness(),body=h.render({account:{holdings:[holding('ELIGIBILITY'),holding('HISTORY'),holding('QUOTE'),holding('MISSING')]},holdings_signals:[
    {symbol:'ELIGIBILITY',exchange:'NSE',status:'universe_unavailable',reason:'Eligibility verification unavailable.'},
    {symbol:'HISTORY',exchange:'NSE',status:'warming_up',reason:'Waiting for completed daily history.'},
    {symbol:'QUOTE',exchange:'NSE',status:'awaiting_market_data',reason:'Waiting for a fresh quote.'},
  ]});
  assert.match(body,/>Eligibility unavailable</);assert.match(body,/>Waiting for daily history</);assert.match(body,/>Waiting for market data</);
  assert.match(body,/>Awaiting status</);assert.doesNotMatch(body,/>Analysing</);
  const disconnected=h.render({connected:false,account:{holdings:[holding('MISSING')]}});
  assert.match(disconnected,/Connect Zerodha to refresh holding analysis\./);
});
