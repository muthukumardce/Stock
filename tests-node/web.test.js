import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { ConfigManager, Settings } from '../src/config.js';
import { createApp, defaultStrategies } from '../src/main.js';
import { Fernet } from '../src/security.js';
import { TradingEngine } from '../src/trading.js';

const PASSWORD='a-long-test-password-only';
const HASH='$argon2id$v=19$m=65536,t=3,p=4$VMU0lS4iHSmQ1iYO3vilQw$STATLHnZvG42lqShST2dJnmzbG52cNmgNoqnIzjGfiE';
class Engine {
  constructor(settings,store){this.settings=settings;this.store=store;this.connected=false;this.status='disconnected';this.universe={};this.positions=[];this.pending=[];this.starts=0;this.notifications=0;}
  async connect(token,user){this.token=token;this.user=user;this.connected=true;this.status='monitoring';}
  async start(){this.starts++;this.status='running';}
  async pause(){this.status='paused';}
  async flatten(){this.positions=[];this.status='paused';}
  async shutdown(){this.connected=false;this.status='stopped';}
  request_reconciliation(){this.notifications++;}
  snapshot(){return {mode:this.settings.trading_mode,status:this.status,connected:this.connected,positions:this.positions,pending_orders:this.pending,capital:75000,equity:75000,account:{},safe_to_stop:!this.positions.length};}
}
async function fixture(t,{root,environment={},exchangeToken,engineFactory=Engine,researchFactory}={}) {
  const directory=root||fs.mkdtempSync(path.join(os.tmpdir(),'stockpilot-web-'));
  const manager=new ConfigManager(directory,{ADMIN_PASSWORD_HASH:HASH,KITE_API_KEY:'testapikey',KITE_API_SECRET:'testapisecret',KITE_USER_ID:'AB1234',...environment});
  const settings=await manager.load();
  const app=await createApp({settings,configManager:manager,engineFactory,researchFactory,exchangeToken:exchangeToken||(async()=>({user_id:'AB1234',access_token:'test-access-token-private'}))});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  let cookie='',csrf='';
  const request=(url,method='GET',body,headers={})=>new Promise((resolve,reject)=>{
    const payload=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
    const req=http.request(origin+url,{method,headers:{...(payload!==undefined?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...(cookie?{cookie}:{}),...(method!=='GET'?{origin,'x-csrf-token':csrf}:{}),...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));res.on('error',reject);});req.on('error',reject);req.end(payload);
  });
  const login=async(headers={})=>{const r=await request('/api/login','POST',{username:'admin',password:PASSWORD},headers);assert.equal(r.status,200,await r.clone().text());cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await (await request('/api/session','GET',undefined,headers)).json()).csrf;return r;};
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;server.close();await app.shutdown();server.closeAllConnections();};
  t.after(async()=>{await close();if(!root)fs.rmSync(directory,{recursive:true,force:true,maxRetries:3});});
  return {root:directory,manager,settings,app,engine:app.state.engine,store:app.state.store,origin,request,login,close,get cookie(){return cookie;}};
}
test('login, origin, CSRF, static dashboard, logout and audit redaction',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/state')).status,401);
  assert.equal((await f.request('/')).headers.get('location'),'/login');
  assert.equal((await f.request('/api/login','POST',{username:'admin',password:PASSWORD},{origin:''})).status,403);
  const result=await f.login();assert.match(result.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);assert.doesNotMatch(result.headers.get('set-cookie'),/Secure/);
  assert.equal((await f.request('/settings')).status,200);assert.match(await (await f.request('/static/app.js')).text(),/config-form/);
  assert.equal((await f.request('/api/trading/pause','POST',{}, {'x-csrf-token':''})).status,403);
  assert.equal((await f.request('/api/trading/pause','POST',{}, {origin:'https://evil.example'})).status,403);
  f.store.event('test','testapisecret test-access-token-private',{access_token:'hidden'});
  assert.doesNotMatch(await (await f.request('/api/events/export')).text(),/testapisecret|"access_token":"hidden"/);
  assert.equal((await f.request('/api/logout','POST',{})).status,200);assert.equal((await f.request('/api/session')).status,401);
});

test('state polling retains contiguous bounded activity pages and rejects malformed cursors',async t=>{
  const f=await fixture(t);await f.login();
  const initial=await (await f.request('/api/state')).json(),cursor=initial.event_cursor;
  assert.equal(cursor,initial.events.at(-1).id);
  const expected=Array.from({length:750},(_,i)=>f.store.event(i===125?'paper_fill':'synthetic',`Activity ${i}`));
  const first=await (await f.request(`/api/state?after=${cursor}&limit=999999`)).json();
  assert.deepEqual(first.events.map(event=>event.id),expected.slice(0,500));
  assert.equal(first.event_cursor,expected[499]);
  assert.equal(first.events.some(event=>event.kind==='paper_fill'),true);
  const second=await (await f.request(`/api/state?after=${first.event_cursor}`)).json();
  assert.deepEqual(second.events.map(event=>event.id),expected.slice(500));
  const empty=await (await f.request(`/api/state?after=${second.event_cursor}`)).json();
  assert.deepEqual(empty.events,[]);assert.equal(empty.event_cursor,second.event_cursor);
  const latest=await (await f.request('/api/state')).json();
  assert.deepEqual(latest.events.map(event=>event.id),expected.slice(-500));
  for(const value of ['', '-1', '1.5', '1e3', 'NaN', 'Infinity', '9007199254740992', '1&after=2']){
    assert.equal((await f.request(`/api/state?after=${value}`)).status,422,value);
  }
  assert.equal((await f.request('/api/state?after=0')).status,200);
});

test('Clear All requires authenticated CSRF, clears the export and shares a durable deletion cursor without changing trading state',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/api/events','DELETE',{})).status,401);await f.login();
  f.store.set('bot_state_live',{intents:{EB1:{state:'unknown'}}});f.engine.positions=[{symbol:'TEST',quantity:5}];
  const last=f.store.event('order_unknown','An acknowledged order must remain managed',{},'error');
  assert.equal((await f.request('/api/events','DELETE',{}, {'x-csrf-token':'bad'})).status,403);
  assert.equal((await f.request('/api/events','DELETE',{}, {origin:'https://evil.example'})).status,403);
  assert.equal((await f.request('/api/events','DELETE',{level:'info'})).status,422);
  assert.equal(f.store.latest_events().at(-1).id,last);
  const cleared=await (await f.request('/api/events','DELETE',{})).json();assert.equal(cleared.ok,true);assert.equal(cleared.event_floor,last);assert.ok(cleared.deleted>0);
  assert.equal(await (await f.request('/api/events/export')).text(),'');
  const view=await (await f.request('/api/state?after=0')).json();assert.deepEqual(view.events,[]);assert.equal(view.event_floor,last);assert.equal(view.event_cursor,last);
  assert.deepEqual(f.engine.positions,[{symbol:'TEST',quantity:5}]);assert.equal(f.store.get('bot_state_live').intents.EB1.state,'unknown');
  const next=f.store.event('account_trade','A new trade');assert.ok(next>last);
  assert.deepEqual((await (await f.request(`/api/state?after=${last}`)).json()).events.map(event=>event.id),[next]);
});

test('research cooldown is enforced over HTTP and background status carries safe diagnostics without a full report',async t=>{
  const f=await fixture(t);await f.login();
  const next=new Date(Date.now()+600000).toISOString();
  f.store.set('research_rate_limit',{next_retry_at:next});
  const diagnostic={code:'rate_limit',message:'History cooldown testapisecret',http_status:429,phase:'collection',symbol:'INFY',retryable:true,next_retry_at:next};
  Object.assign(f.app.state.research.state,{status:'failed',message:'History cooldown',error:diagnostic,issues:[diagnostic],report:{private_marker:'DO_NOT_INCLUDE_LARGE_REPORT'}});
  const view=f.engine.snapshot.bind(f.engine);f.engine.snapshot=()=>({...view(),api_limits:{status:'cooldown',categories:[{category:'historical',status:'cooldown',retry_after_seconds:600}]}});
  const response=await f.request('/api/trading/pause','POST',{});assert.equal(response.status,200);
  const blocked=await f.request('/api/research/start','POST',{});assert.equal(blocked.status,429);assert.match((await blocked.json()).detail,/rate limited until/);
  const state=(await (await f.request('/api/state')).json()).state;
  assert.equal(state.background.research.error.code,'rate_limit');assert.equal(state.background.research.error.http_status,429);assert.ok(Math.abs(Date.parse(state.background.research.error.next_retry_at)-Date.parse(next))<100);assert.ok(state.background.research.cooldown.next_retry_at);
  assert.equal(state.api_limits.categories[0].category,'historical');assert.equal(state.background.research.issues.length,1);
  assert.doesNotMatch(JSON.stringify(state),/testapisecret|DO_NOT_INCLUDE_LARGE_REPORT/);assert.equal(f.engine.starts,0);
});

test('research endpoints are authenticated read-only jobs with CSRF and no arbitrary dataset or credentials',async t=>{
  const f=await fixture(t);let starts=0,cancels=0;
  f.app.state.research.start=()=>{starts++;return {status:'collecting',progress:0,report:null};};
  f.app.state.research.cancel=async()=>{cancels++;return {status:'cancelled',report:null};};
  f.app.state.research.status=()=>({status:'idle',report:null});
  assert.equal((await f.request('/api/research')).status,401);assert.equal((await f.request('/api/research/start','POST',{})).status,401);
  await f.login();assert.equal((await f.request('/api/research')).status,200);
  assert.equal((await f.request('/api/research/start','POST',{}, {'x-csrf-token':'bad'})).status,403);
  assert.equal((await f.request('/api/research/start','POST',{access_token:'must-not-be-accepted'})).status,422);
  assert.equal((await f.request('/api/research/start','POST',{symbols:{TEST:[]}})).status,422);
  assert.equal((await f.request('/api/research/start','POST',{})).status,200);assert.equal(starts,1);assert.equal(f.engine.starts,0);
  assert.equal((await f.request('/api/research/cancel','POST',{})).status,200);assert.equal(cancels,1);
  f.app.state.restartRequired=true;assert.equal((await f.request('/api/research/start','POST',{})).status,409);assert.equal(starts,1);
  assert.doesNotMatch(JSON.stringify(f.store.events()),/must-not-be-accepted/);
});

test('Research page sizes persist without pausing trading or granting arbitrary settings access',async t=>{
  const f=await fixture(t),values={research_symbols:150};
  assert.equal((await f.request('/api/research/settings','PUT',values)).status,401);await f.login();
  assert.equal((await f.request('/api/research/settings','PUT',values,{'x-csrf-token':'bad'})).status,403);
  assert.equal((await f.request('/api/research/settings','PUT',{...values,risk_per_trade_pct:.05})).status,422);
  for(const invalid of [{...values,research_symbols:1001},{...values,research_symbols:-1}])assert.equal((await f.request('/api/research/settings','PUT',invalid)).status,409);
  assert.equal((await f.request('/api/research/settings','PUT',{...values,research_symbols:'150'})).status,422);
  f.engine.status='running';f.engine.positions=[{symbol:'INFY'}];const risk=f.settings.risk_per_trade_pct;
  const saved=await f.request('/api/research/settings','PUT',values);assert.equal(saved.status,200);assert.deepEqual((await saved.json()).settings,values);
  for(const mode of ['invalid',null,1])assert.equal((await f.request('/api/research/settings','PUT',{...values,research_cpu_affinity:mode})).status,422);
  const affinityValues={...values,research_cpu_affinity:'automatic'},affinitySaved=await f.request('/api/research/settings','PUT',affinityValues);
  assert.equal(affinitySaved.status,200);assert.deepEqual((await affinitySaved.json()).settings,affinityValues);
  assert.equal(f.settings.research_cpu_affinity,'automatic');assert.equal(f.manager.candidate({}).research_cpu_affinity,'automatic');
  assert.equal(f.settings.research_symbols,150);assert.equal(f.manager.candidate({}).research_tuning_trials,undefined);assert.equal(f.settings.risk_per_trade_pct,risk);
  assert.equal(f.engine.status,'running');assert.equal(f.engine.positions.length,1);assert.equal(f.app.state.restartRequired,false);assert.equal(f.engine.starts,0);
  f.app.state.research.state.status='running';assert.equal((await f.request('/api/research/settings','PUT',values)).status,409);f.app.state.research.state.status='idle';
  assert.equal((await f.request('/api/research/settings','PUT',{research_symbols:0})).status,200);assert.equal(f.manager.candidate({}).research_symbols,0);
  f.app.state.restartRequired=true;assert.equal((await f.request('/api/research/settings','PUT',values)).status,409);
});

test('all enhanced controls have editable defaults and invalid combinations are rejected before saving',async t=>{
  const f=await fixture(t);await f.login();const config=await (await f.request('/api/config')).json();
  assert.equal(config.values.enhanced_signals,true);assert.equal(config.values.auto_research,true);assert.equal(config.values.research_symbols,20);
  for(const key of ['min_signal_score','enable_reversion','max_correlation','loss_cooldown_minutes'])assert.ok(config.fields.some(field=>field.key===key));
  assert.equal((await f.request('/api/config','PUT',{min_rsi:80,max_rsi:50})).status,409);
  assert.equal((await f.request('/api/config','PUT',{min_gap_pct:.02,max_gap_pct:.02})).status,409);
  assert.equal((await f.request('/api/config','PUT',Object.fromEntries(Object.keys(config.values).filter(k=>k.startsWith('enable_')).map(k=>[k,false])))).status,409);
  assert.equal((await f.request('/api/config','PUT',{research_symbols:999999})).status,409);
  assert.equal((await f.request('/api/config','PUT',{min_signal_score:65,research_symbols:10})).status,200);
  assert.equal(f.manager.candidate({}).min_signal_score,65);assert.equal(f.settings.min_signal_score,60);
});

test('retired research parameter controls and apply endpoint cannot mutate strategy settings',async t=>{
  const f=await fixture(t);await f.login();const before=f.settings.min_signal_score;
  const config=await (await f.request('/api/config')).json();
  assert.ok(config.fields.some(field=>field.key==='research_workers'));
  for(const key of ['research_tuning','research_tuning_apply','research_tuning_trials','research_tuning_seconds','research_tuning_workers']){
    assert.equal(Object.hasOwn(config.values,key),false);assert.ok(!config.fields.some(field=>field.key===key));
    assert.equal((await f.request('/api/config','PUT',{[key]:true})).status,422);
    assert.equal((await f.request('/api/research/settings','PUT',{research_symbols:20,[key]:true})).status,422);
  }
  assert.equal((await f.request('/api/research/apply','POST',{report_id:'old',parameter_set_id:'P2'})).status,404);
  assert.equal(f.settings.min_signal_score,before);assert.equal(f.engine.starts,0);
  const migrated=new Settings({research_tuning:true,research_tuning_apply:true,research_tuning_workers:6,min_signal_score:63});
  assert.equal(migrated.research_workers,6);assert.equal(migrated.min_signal_score,63);assert.equal(migrated.research_tuning,undefined);
  assert.equal(new Settings({research_workers:4,research_tuning_workers:6}).research_workers,4);
});
test('Cloudflare origin and secure cookies are automatic; untrusted hosts and spoofed proxy metadata fail',async t=>{
  const f=await fixture(t),headers={host:'my-tunnel.trycloudflare.com','cf-ray':'aabbccddeeff1234-BOM','x-forwarded-proto':'https','cf-connecting-ip':'203.0.113.8',origin:'https://my-tunnel.trycloudflare.com'};
  assert.equal((await f.request('/login','GET',undefined,{host:'evil.example','x-forwarded-proto':'https'})).status,400);
  assert.equal((await f.request('/login','GET',undefined,{...headers,'x-forwarded-proto':'http'})).status,400);
  const result=await f.login(headers);assert.match(result.headers.get('set-cookie'),/; Secure/);
  const cfg=await (await f.request('/api/config','GET',undefined,headers)).json();
  assert.equal(cfg.urls.redirect,'https://my-tunnel.trycloudflare.com/auth/kite/callback');
  assert.equal(cfg.urls.postback,'https://my-tunnel.trycloudflare.com/api/kite/postback');
  for(const key of ['public_url','app_env','paper_capital','live_capital','session_secret','token_encryption_key','kite_api_secret'])assert.equal(Object.hasOwn(cfg.values,key),false);
  assert.equal((await f.request('/api/trading/pause','POST',{}, {...headers,origin:'https://another.example'})).status,403);
});
test('body size and duplicate/nonfinite JSON checks protect login and public postbacks',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/login','POST',' '.repeat(40000))).status,413);
  for(const raw of ['{"a":1,"a":2}','{"a":1e999}','{"a":NaN}','{"nested":{"x":1,"x":2}}','{} trailing'])assert.equal((await f.request('/api/kite/postback','POST',raw)).status,400);
});
test('login throttling survives a process restart and ignores forged forwarded IP',async t=>{
  const f=await fixture(t);
  for(let i=0;i<5;i++)assert.equal((await f.request('/api/login','POST',{username:'admin',password:'incorrect'},{'x-forwarded-for':`203.0.113.${i}`})).status,401);
  await f.close();const g=await fixture(t,{root:f.root});
  assert.equal((await g.request('/api/login','POST',{username:'admin',password:PASSWORD})).status,429);
  await g.close();
});
test('OAuth is session-bound, one use, account-bound and encrypts persisted tokens; restart monitors only',async t=>{
  let exchanges=0;const f=await fixture(t,{exchangeToken:async()=>{exchanges++;return {user_id:'AB1234',access_token:'broker-private-token'};}});await f.login();
  const start=await (await f.request('/api/trading/start','POST',{})).json();
  const nonce=new URLSearchParams(new URL(start.redirect_url).searchParams.get('redirect_params')).get('state');
  assert.equal((await f.request('/auth/kite/callback?status=success&request_token=private-request&state=wrong')).headers.get('location'),'/?error=callback');
  const callback=`/auth/kite/callback?status=success&request_token=private-request&state=${nonce}`;
  assert.equal((await f.request(callback,'GET',undefined,{host:'alternate.trycloudflare.com','cf-ray':'aabbccddeeff1234-BOM','x-forwarded-proto':'https'})).headers.get('location'),'/?error=callback');assert.equal(exchanges,0);
  assert.equal((await f.request(callback)).headers.get('location'),'/');assert.equal(f.engine.starts,1);assert.equal(exchanges,1);
  assert.equal((await f.request(callback)).headers.get('location'),'/?error=callback');assert.equal(exchanges,1);
  const encrypted=f.store.get('kite_session');assert.doesNotMatch(encrypted,/broker-private-token/);assert.equal(JSON.parse(new Fernet(f.settings.token_encryption_key).decrypt(encrypted)).access_token,'broker-private-token');
  assert.doesNotMatch(await (await f.request('/api/events/export')).text(),/broker-private-token|private-request/);
  await f.close();const g=await fixture(t,{root:f.root});assert.equal(g.engine.connected,true);assert.equal(g.engine.starts,0);await g.close();
});
test('wrong broker account never starts and does not persist an access token',async t=>{
  const f=await fixture(t,{exchangeToken:async()=>({user_id:'OTHER',access_token:'secret'})});await f.login();
  const {redirect_url}=await (await f.request('/api/trading/start','POST',{})).json(),nonce=new URLSearchParams(new URL(redirect_url).searchParams.get('redirect_params')).get('state');
  assert.equal((await f.request(`/auth/kite/callback?status=success&request_token=x&state=${nonce}`)).headers.get('location'),'/');
  const {state}=await (await f.request('/api/state')).json();assert.equal(state.startup.status,'failed');assert.match(state.startup.message,/client ID did not match/);assert.equal(f.store.get('kite_session'),null);assert.equal(f.engine.starts,0);
});

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function waitStartup(f,status){
  for(let attempt=0;attempt<100;attempt++){
    const {state}=await (await f.request('/api/state')).json();
    if(state.startup.status===status)return state;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail(`Startup did not reach ${status}`);
}
async function oauthCallback(f){
  const {redirect_url}=await (await f.request('/api/trading/start','POST',{})).json();
  const nonce=new URLSearchParams(new URL(redirect_url).searchParams.get('redirect_params')).get('state');
  return `/auth/kite/callback?status=success&request_token=private-request&state=${nonce}`;
}

test('OAuth returns the dashboard and readable progress while token exchange is pending; duplicate starts reuse the job',{timeout:5000},async t=>{
  const exchange=deferred();t.after(()=>exchange.resolve());let exchanges=0;
  const f=await fixture(t,{exchangeToken:async()=>{exchanges++;await exchange.promise;return {user_id:'AB1234',access_token:'broker-private-token'};}});await f.login();
  const callback=await oauthCallback(f);
  assert.equal((await f.request(callback)).headers.get('location'),'/');
  let state=(await (await f.request('/api/state')).json()).state;
  assert.equal(state.startup.status,'running');assert.equal(state.startup.phase,'authenticating');assert.equal(state.startup.completed,0);assert.equal(f.engine.starts,0);
  const repeated=await f.request('/api/trading/start','POST',{});assert.equal(repeated.status,202);assert.equal((await repeated.json()).startup.started_at,state.startup.started_at);
  assert.equal((await f.request(callback)).headers.get('location'),'/?error=callback');assert.equal(exchanges,1);
  const initialRevision=state.startup.revision,operation=state.startup.operation_id;
  exchange.resolve();state=await waitStartup(f,'complete');assert.equal(f.engine.starts,1);assert.equal(state.startup.completed,state.startup.total);assert.ok(state.startup.revision>initialRevision);assert.equal(state.startup.operation_id,operation);
  assert.doesNotMatch(JSON.stringify(state),/private-request|broker-private-token/);
});

test('slow account connection reports real stages and Pause prevents the pending OAuth startup from arming',{timeout:5000},async t=>{
  const connection=deferred();t.after(()=>connection.resolve());
  class SlowEngine extends Engine{
    async connect(token,user,{onProgress}){onProgress({phase:'holdings',message:'Downloading current holdings.',completed:3,total:10});await connection.promise;await super.connect(token,user);}
    async pause(){await connection.promise;await super.pause();}
  }
  const f=await fixture(t,{engineFactory:SlowEngine});await f.login();await f.request(await oauthCallback(f));
  const state=(await (await f.request('/api/state')).json()).state;
  assert.equal(state.startup.phase,'holdings');assert.match(state.startup.message,/Downloading current holdings/);assert.equal(state.startup.completed,4);assert.equal(state.startup.total,13);
  assert.equal((await f.request('/health')).status,200);
  const pause=await f.request('/api/trading/pause','POST',{});assert.equal(pause.status,202);assert.equal((await pause.json()).startup.phase,'cancelling');
  connection.resolve();await waitStartup(f,'cancelled');assert.equal(f.engine.starts,0);assert.equal(f.engine.status,'paused');
});

test('connected Start responds before reconciliation ends, stays single-flight, and cancellation is visible before arming',{timeout:5000},async t=>{
  const reconciliation=deferred();t.after(()=>reconciliation.resolve());let attempts=0;
  class SlowStartEngine extends Engine{
    async start({onProgress,isCancelled}){attempts++;onProgress({phase:'account',message:'Reconciling broker orders.',completed:0,total:2});await reconciliation.promise;if(isCancelled())return;await super.start();}
  }
  const f=await fixture(t,{engineFactory:SlowStartEngine});await f.login();f.engine.connected=true;
  const start=await f.request('/api/trading/start','POST',{});assert.equal(start.status,202);
  assert.equal((await (await f.request('/api/state')).json()).state.startup.message,'Reconciling broker orders.');
  assert.equal((await f.request('/api/trading/start','POST',{})).status,202);assert.equal(attempts,1);
  assert.equal((await f.request('/api/trading/pause','POST',{})).status,202);
  reconciliation.resolve();await waitStartup(f,'cancelled');assert.equal(f.engine.starts,0);
});

test('Pause also invalidates an outstanding Zerodha login before its callback can start trading',async t=>{
  let exchanges=0;const f=await fixture(t,{exchangeToken:async()=>{exchanges++;return {user_id:'AB1234',access_token:'secret'};}});await f.login();
  const callback=await oauthCallback(f);assert.equal((await f.request('/api/trading/pause','POST',{})).status,200);
  assert.equal((await f.request(callback)).headers.get('location'),'/?error=callback');assert.equal(exchanges,0);assert.equal(f.engine.starts,0);
});

test('failed background startup exposes a safe failure and can retry without leaking broker responses',async t=>{
  let attempts=0;
  class FailingEngine extends Engine{
    async start({onProgress}){attempts++;onProgress({phase:'account',message:'Downloading current funds.',completed:0,total:2});if(attempts===1)throw new Error('unsafe upstream response private-request broker-private-token');await super.start();}
  }
  const f=await fixture(t,{engineFactory:FailingEngine});await f.login();f.engine.connected=true;
  assert.equal((await f.request('/api/trading/start','POST',{})).status,202);
  const failed=await waitStartup(f,'failed');assert.equal(failed.startup.completed,0);assert.match(failed.startup.message,/could not start/);assert.doesNotMatch(JSON.stringify(failed),/unsafe upstream|private-request|broker-private-token/);
  assert.equal((await f.request('/api/trading/start','POST',{})).status,202);const retried=await waitStartup(f,'complete');assert.equal(f.engine.starts,1);assert.ok(retried.startup.revision>failed.startup.revision);assert.notEqual(retried.startup.operation_id,failed.startup.operation_id);assert.equal(retried.startup.lifecycle_id,failed.startup.lifecycle_id);
  await f.close();const g=await fixture(t,{root:f.root});await g.login();const restarted=(await (await g.request('/api/state')).json()).state;
  assert.notEqual(restarted.startup.lifecycle_id,retried.startup.lifecycle_id);assert.equal(restarted.startup.revision,0);await g.close();
});

test('saved-session restoration serves the dashboard while downloads run and never automatically enables entries',{timeout:5000},async t=>{
  const connection=deferred();t.after(()=>connection.resolve());
  const f=await fixture(t);f.store.set('kite_session',new Fernet(f.settings.token_encryption_key).encrypt(JSON.stringify({access_token:'saved-private-token',user_id:'AB1234',expires:Date.now()/1000+3600})));await f.close();
  class RestoringEngine extends Engine{
    async connect(token,user,{onProgress}){onProgress({phase:'instruments',message:'Downloading NSE instruments.',completed:7,total:10});await connection.promise;await super.connect(token,user);}
  }
  const g=await fixture(t,{root:f.root,engineFactory:RestoringEngine});await g.login();
  let state=(await (await g.request('/api/state')).json()).state;assert.equal(state.startup.status,'running');assert.equal(state.startup.phase,'instruments');assert.equal(g.engine.starts,0);
  connection.resolve();state=await waitStartup(g,'complete');assert.match(state.startup.message,/remain paused/);assert.equal(g.engine.connected,true);assert.equal(g.engine.starts,0);await g.close();
});

test('shutdown cancels a pending startup and waits for it without arming or writing after store closure',{timeout:5000},async t=>{
  const exchange=deferred();t.after(()=>exchange.resolve());
  const f=await fixture(t,{exchangeToken:async()=>{await exchange.promise;return {user_id:'AB1234',access_token:'late-token'};}});await f.login();await f.request(await oauthCallback(f));
  const shuttingDown=f.app.shutdown();exchange.resolve();await shuttingDown;assert.equal(f.engine.starts,0);assert.equal(f.engine.connected,false);assert.equal(f.app.state.startup.status,'cancelled');
});

test('read-only research failure does not misreport successful trading startup as failed',async t=>{
  const f=await fixture(t);await f.login();f.app.state.research.maybeStart=async()=>{throw new Error('Temporary research failure');};
  await f.request(await oauthCallback(f));const state=await waitStartup(f,'complete');assert.equal(f.engine.starts,1);assert.equal(state.status,'running');
  assert.ok(f.store.latest_events().some(event=>event.kind==='research.retry_wait'));
});

function postback(change={}){const value={order_id:'260917001',order_timestamp:'2026-09-17 09:40:00',user_id:'AB1234',status:'COMPLETE',...change};value.checksum=crypto.createHash('sha256').update(value.order_id+value.order_timestamp+'testapisecret').digest('hex');return value;}
test('postbacks only request reconciliation, deduplicate durably and never trust unsigned order fields',async t=>{
  const f=await fixture(t),p=postback({average_price:123,filled_quantity:500});
  for(let i=0;i<2;i++)assert.equal((await f.request('/api/kite/postback','POST',p,{origin:''})).status,200);
  assert.equal(f.engine.notifications,1);assert.equal(f.engine.starts,0);assert.equal(f.store.get('kite_postback_receipts').length,1);
  const event=f.store.latest_events().find(e=>e.kind==='kite.postback_received');assert.deepEqual(event.data,{order_id:p.order_id,order_timestamp:p.order_timestamp});
  assert.equal((await f.request('/api/kite/postback','POST',{...p,status:'REJECTED'})).status,200);assert.equal(f.engine.notifications,1);assert.equal(f.store.get('kite_postback_receipts').length,2);
  await f.close();const g=await fixture(t,{root:f.root});assert.equal((await g.request('/api/kite/postback','POST',p)).status,200);assert.equal(g.engine.notifications,0);await g.close();
});
test('malformed postbacks, other accounts and bad checksums are rejected',async t=>{
  const f=await fixture(t);
  for(const p of [postback({order_timestamp:'2026-02-30 09:40:00'}),postback({order_id:'../../abc'}),{...postback(),checksum:'bad'},[],null])assert.equal((await f.request('/api/kite/postback','POST',p)).status,400);
  for(const p of [postback({user_id:'OTHER'}),{...postback(),checksum:'0'.repeat(64)}])assert.equal((await f.request('/api/kite/postback','POST',p)).status,403);
  assert.equal(f.engine.notifications,0);
});
test('strategy allocations use percentages without a configured rupee capital and block changes during live exposure',async t=>{
  const f=await fixture(t);await f.login();const values={...defaultStrategies(),intraday_allocation_pct:.7,swing_enabled:true,swing_allocation_pct:.3};
  assert.equal((await f.request('/api/settings','PUT',values)).status,200);assert.deepEqual(f.store.get('strategy_settings'),values);
  assert.equal((await f.request('/api/settings','PUT',{...values,swing_allocation_pct:.5})).status,422);
  assert.equal((await f.request('/api/settings','PUT','{"__proto__":{}}')).status,422);
  f.engine.settings.trading_mode='live';f.engine.positions=[{symbol:'ABC'}];assert.equal((await f.request('/api/settings','PUT',values)).status,409);
});

test('ignore existing stocks policy persists and cannot be enabled over pending orders or managed live exposure',async t=>{
  const f=await fixture(t);await f.login();const values={...defaultStrategies(),manage_existing_holdings:'ignore',managed_symbols:['TEST']};
  assert.equal((await f.request('/api/settings','PUT',values)).status,200);
  assert.deepEqual(f.store.get('strategy_settings'),values);
  assert.equal((await f.request('/api/settings','PUT',{...values,manage_existing_holdings:'invalid'})).status,422);
  f.engine.pending=[{symbol:'TEST'}];assert.equal((await f.request('/api/settings','PUT',values)).status,409);
  f.engine.pending=[];f.engine.settings.trading_mode='live';f.engine.positions=[{symbol:'TEST'}];assert.equal((await f.request('/api/settings','PUT',values)).status,409);
});

test('settings report the current blocker consistently in state and both save endpoints',async t=>{
  const f=await fixture(t);await f.login();
  const base=f.engine.snapshot.bind(f.engine);
  for(const [extra,restart,code,expected] of [
    [{entries_enabled:true},false,'entries_enabled',/Automatic entries are still enabled/],
    [{mode:'live',positions:[{symbol:'LIVE1'}]},false,'live_positions',/LIVE1/],
    [{delivery:{positions:{DELIVERY1:{status:'protected'}}}},false,'live_positions',/DELIVERY1/],
    [{pending_orders:[{symbol:'PENDING1'}]},false,'pending_orders',/PENDING1/],
    [{unmanaged_live_exposure:true},false,'saved_live_exposure',/Saved live positions or orders/],
    [{},true,'restart_required',/earlier application-settings change/],
  ]){
    f.engine.snapshot=()=>({...base(),...extra});f.app.state.restartRequired=restart;
    const {state}=await (await f.request('/api/state')).json();
    assert.equal(state.settings_blocker.code,code);assert.match(state.settings_blocker.message,expected);
    for(const [endpoint,payload] of [['/api/settings',defaultStrategies()],['/api/config',{min_signal_score:64}]]){
      const response=await f.request(endpoint,'PUT',payload);assert.equal(response.status,409,code);
      assert.equal((await response.json()).detail,state.settings_blocker.message);
    }
    assert.equal(f.engine.status,'disconnected');
  }
});

test('paused paper journals survive strategy changes, application saves, migration and mode changes',async t=>{
  for(const config of [{min_signal_score:64},{data_dir:'retained-paper',trading_mode:'live',live_trading_enabled:true}])await t.test(JSON.stringify(config),async t=>{
    const f=await fixture(t,{engineFactory:TradingEngine});await f.login();
    const positions={TEST:{symbol:'TEST',token:123,quantity:15,entry:100,last:102,stop:98,strategy:'intraday',mode:'paper',side:'BUY'}};
    Object.assign(f.engine,{positions:structuredClone(positions),realised:47,capital:75000,status:'paused'});f.engine._persist();
    const journal=f.store.get('bot_state_paper');
    const {state}=await (await f.request('/api/state')).json();assert.equal(state.entries_enabled,false);assert.equal(state.settings_blocker,null);
    const values={...defaultStrategies(),manage_existing_holdings:'ignore'};
    assert.equal((await f.request('/api/settings','PUT',values)).status,200);assert.deepEqual(f.store.get('bot_state_paper'),journal);
    assert.equal((await f.request('/api/config','PUT',config)).status,200);assert.deepEqual(f.store.get('bot_state_paper'),journal);
    assert.equal(f.engine.broker,null);assert.equal(f.engine.running,false);
    await f.close();
    const g=await fixture(t,{root:f.root,engineFactory:TradingEngine});
    try{
      assert.deepEqual(g.store.get('bot_state_paper'),journal);assert.deepEqual(g.store.get('strategy_settings'),values);
      assert.equal(g.engine.running,false);assert.equal(g.engine.broker,null);
      if(config.trading_mode==='live')assert.deepEqual(g.engine.positions,{});
      else assert.deepEqual(g.engine.positions,positions);
    }finally{await g.close();}
  });
});
test('Settings persist defaults, reject old env-only fields and require restart without trading exposure',async t=>{
  const f=await fixture(t);await f.login();
  const research=f.app.state.research;assert.equal(research.automatic,true);assert.equal(research.timer.hasRef(),false);
  for(const values of [{public_url:'https://example.org'},{paper_capital:1000},{port:0},{risk_per_trade_pct:2}])assert.ok((await f.request('/api/config','PUT',values)).status>=400);
  f.engine.status='running';assert.equal((await f.request('/api/config','PUT',{port:3100})).status,409);f.engine.status='paused';
  const result=await f.request('/api/config','PUT',{port:3100,analytics_workers:0});assert.equal(result.status,200,await result.clone().text());
  assert.equal(research.closed,true);assert.equal(research.timer,null);assert.equal(research.status().automation.status,'stopped');
  await research.maybeStart();assert.throws(()=>research.start(),/shutting down/);
  assert.equal((await f.request('/api/trading/start','POST',{})).status,409);assert.equal((await (await f.request('/api/config')).json()).values.port,3100);
  await f.close();const g=await fixture(t,{root:f.root});assert.equal(g.settings.port,3100);await g.close();
});
test('changing data directory snapshots journals and sessions before the next startup',async t=>{
  const f=await fixture(t);await f.login();f.store.set('durable-test',{value:42});
  assert.equal((await f.request('/api/config','PUT',{data_dir:'new-data'})).status,200);
  assert.ok(fs.existsSync(path.join(f.root,'data','stockpilot.sqlite3')));await f.close();
  const g=await fixture(t,{root:f.root});assert.equal(g.store.get('durable-test').value,42);await g.close();
});
test('admin credential and key rotation revokes sessions and preserves encrypted broker login',async t=>{
  const f=await fixture(t);await f.login();const saved=JSON.stringify({access_token:'private-broker-login',user_id:'AB1234',expires:Date.now()/1000+3600});f.store.set('kite_session',new Fernet(f.settings.token_encryption_key).encrypt(saved));const oldKey=f.settings.token_encryption_key;
  assert.equal((await f.request('/api/admin','PUT',{username:'newadmin',password:'new-long-test-password',current_password:'wrong',rotate_keys:true})).status,403);
  assert.equal((await f.request('/api/admin','PUT',{username:'newadmin',password:'new-long-test-password',current_password:PASSWORD,rotate_keys:true})).status,200);
  assert.notEqual(f.settings.token_encryption_key,oldKey);assert.equal(new Fernet(f.settings.token_encryption_key).decrypt(f.store.get('kite_session')),saved);
  assert.equal((await f.request('/api/session')).status,401);
  assert.equal((await f.request('/api/login','POST',{username:'newadmin',password:'new-long-test-password'})).status,200);
  assert.doesNotMatch(JSON.stringify(f.store.latest_events()),/private-broker-login|new-long-test-password/);
});
test('second server cannot own the journal; shutdown releases ownership',async t=>{
  const f=await fixture(t);await assert.rejects(createApp({settings:f.settings,engineFactory:Engine}),/Another StockPilot/);
  await f.close();const g=await fixture(t,{root:f.root});assert.ok(g.app);await g.close();
});
test('concurrent admin changes cannot reuse a session revoked by the first change',async t=>{
  const f=await fixture(t);await f.login();const change={username:'newadmin',password:'another-long-test-password',current_password:PASSWORD,rotate_keys:false};
  const replies=await Promise.all([f.request('/api/admin','PUT',change),f.request('/api/admin','PUT',{...change,username:'secondadmin'})]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,401]);assert.equal(f.settings.admin_username,replies[0].status===200?'newadmin':'secondadmin');
});
test('large audit export streams every page with backpressure',async t=>{
  const f=await fixture(t);await f.login();for(let i=0;i<1200;i++)f.store.event('large_test','record '+i,{detail:'x'.repeat(300)});
  const text=await (await f.request('/api/events/export')).text(),rows=text.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows.filter(r=>r.kind==='large_test').length,1200);assert.ok(rows.every((r,i)=>i===0||r.id>rows[i-1].id));
});
test('holdings authorization routes enforce login, CSRF and official-flow-only input',async t=>{
  const f=await fixture(t);let started=0,checked=[];
  f.engine.start_holdings_authorization=async()=>{started++;return {authorization_url:'https://kite.zerodha.com/connect/portfolio/authorise/holdings/test-key/request-id'};};
  f.engine.refresh_holdings_authorization=async confirmed=>{checked.push(confirmed);return {required:false,status:'verified',items:[]};};
  f.engine.holdings_authorization={snapshot:()=>({required:true,status:'required',items:[{symbol:'TEST',quantity:4}]})};
  assert.equal((await f.request('/api/holdings/authorization/start','POST',{})).status,401);
  await f.login();
  assert.equal((await f.request('/api/holdings/authorization/start','POST',{}, {'x-csrf-token':''})).status,403);
  assert.equal((await f.request('/api/holdings/authorization/start','POST',{otp:'123456',tpin:'123456'})).status,422);
  assert.equal((await f.request('/api/holdings/authorization/refresh','POST',{status:'success'})).status,422);
  assert.equal((await f.request('/api/holdings/authorization/refresh','POST',{user_confirmed:'yes'})).status,422);
  const result=await f.request('/api/holdings/authorization/start','POST',{});assert.equal(result.status,200);assert.equal(started,1);
  await f.request('/api/holdings/authorization/refresh','POST',{});await f.request('/api/holdings/authorization/refresh','POST',{user_confirmed:true});assert.deepEqual(checked,[false,true]);
  assert.doesNotMatch(JSON.stringify(f.store.latest_events()),/123456/);
});
test('live dashboard exposes safe authorization instructions without the broad secret redactor hiding them',async t=>{
  const f=await fixture(t,{environment:{TRADING_MODE:'live',LIVE_TRADING_ENABLED:'true'}});await f.login();
  const safe={required:true,status:'required',items:[{symbol:'TEST',quantity:4,reason:'Permission required'}],message:'Complete the official flow'};
  f.engine.holdings_authorization={snapshot:()=>safe};const result=await (await f.request('/api/state')).json();assert.deepEqual(result.state.holdings_authorization,safe);
});
