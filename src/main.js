import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Settings, DEFAULTS, FIELDS } from './config.js';
import { Store } from './storage.js';
import { ProcessLock, LoginLimiter, Fernet, digest_token, randomSecret, constantEqual, verifyPassword, hashPassword, strictJSON } from './security.js';
import { Mutex, isoIST, dateIST, parseTime } from './util.js';
import { ResourceMonitor } from './resources.js';
import { requestContext } from './http-context.js';
import { setImmediate as yieldIO } from 'node:timers/promises';

const STATIC=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const COOKIE='stockpilot_session';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export const defaultStrategies=()=>({intraday_enabled:true,swing_enabled:false,intraday_allocation_pct:1,swing_allocation_pct:0,manage_existing_holdings:'selected',managed_symbols:[]});
function failure(code,message){return Object.assign(new Error(message),{status:code});}
function cookie(req){const part=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='));return part?part.slice(COOKIE.length+1):'';}
function plainObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function waitDrain(res){return new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});}
export async function exchangeToken(cfg,requestToken){
  const response=await fetch('https://api.kite.trade/session/token',{method:'POST',headers:{'X-Kite-Version':'3','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({api_key:cfg.kite_api_key,request_token:requestToken,checksum:sha(cfg.kite_api_key+requestToken+cfg.kite_api_secret)}),signal:AbortSignal.timeout(15000)});
  const result=await response.json();if(!response.ok||result.status!=='success'||!result.data?.access_token)throw new Error('Broker authentication failed');return result.data;
}
export async function createApp(options={}){
  const cfg=options.settings instanceof Settings?options.settings:new Settings(options.settings);
  cfg.validate();const manager=options.configManager;
  const lock=new ProcessLock(path.join(cfg.data_dir,'server-owner.sqlite3'));
  lock.acquire();let store,engine,sampler;const streams=new Set();let closing=false;
  try{
    store=new Store(path.join(cfg.data_dir,'stockpilot.sqlite3'),[cfg.kite_api_key,cfg.kite_api_secret,cfg.session_secret,cfg.token_encryption_key,cfg.admin_password_hash]);
    const Engine=options.engineFactory||(await import('./trading.js')).TradingEngine;engine=new Engine(cfg,store);
    const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
    const state={settings:cfg,store,engine,resources:new ResourceMonitor(),cipher:new Fernet(cfg.token_encryption_key),limiter:new LoginLimiter(store),control:new Mutex(),loginLock:new Mutex(),postbackLock:new Mutex(),lastPostback:-Infinity,restartRequired:false};
    app.state=state;
    const fingerprint=digest_token(cfg.admin_username+':'+cfg.admin_password_hash,cfg.session_secret);
    if(store.get('admin_fingerprint')!==fingerprint){store.revoke_sessions();store.set('admin_fingerprint',fingerprint);}
    if(store.get('strategy_settings')===null)store.set('strategy_settings',defaultStrategies());
    store.event('server.started','Node.js server started. New entries remain paused until Start Trading.',{mode:cfg.trading_mode});
    const saved=store.get('kite_session');
    if(saved){try{const session=JSON.parse(state.cipher.decrypt(saved));if(session.expires>Date.now()/1000&&session.user_id.toUpperCase()===cfg.kite_user_id.toUpperCase()){store.add_secret(session.access_token);await engine.connect(session.access_token,session.user_id);store.event('session.restored','Zerodha monitoring restored. New entries are paused.');}else store.delete('kite_session');}catch{store.event('session.restore_failed','Reconnect to Zerodha. The saved session could not be restored.',{},'warning');}}
    sampler=setInterval(()=>{if(closing)return;const view=engine.snapshot();if(view.connected&&Number.isFinite(view.equity))store.sample(cfg.trading_mode,view.equity);},30000);sampler.unref();
    app.use((req,res,next)=>{
      res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://kite.zerodha.com"});
      if(closing)return next(failure(503,'Server is shutting down'));
      try{req.context=requestContext(req);}catch{return next(failure(400,'Use localhost or an HTTPS Cloudflare tunnel'));}
      if(req.context.secure)res.set('Strict-Transport-Security','max-age=31536000');
      if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
        const postback=req.method==='POST'&&req.path==='/api/kite/postback';
        if(!postback&&(req.get('origin')||'').replace(/\/$/,'')!==req.context.origin)return next(failure(403,'Invalid request origin'));
        const length=req.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>32768))return next(failure(413,'Request too large'));
      }
      next();
    });
    app.use(express.raw({type:()=>true,limit:32768}));
    app.use((req,res,next)=>{if(req.body?.length){try{req.body=strictJSON(req.body);}catch{return next(failure(400,'Invalid JSON payload'));}}else req.body={};next();});
    function authenticated(req,mutation=false){const value=cookie(req),session=value?store.session(digest_token(value,cfg.session_secret)):null;if(!session)throw failure(401,'Sign in to continue');if(mutation&&!constantEqual(req.get('x-csrf-token')||'',session.csrf))throw failure(403,'Invalid session protection token');return session;}
    function ready(){if(state.restartRequired)throw failure(409,'Settings saved. Restart the server before trading.');if(fs.existsSync(path.join(cfg.data_dir,'maintenance.lock')))throw failure(409,'Server maintenance is in progress');if(!cfg.configured)throw failure(409,'Set KITE_API_KEY, KITE_API_SECRET and KITE_USER_ID in .env first');if(cfg.trading_mode==='live'&&!cfg.live_trading_enabled)throw failure(409,'Enable live execution in Settings');}
    function snapshot(){const view=engine.snapshot();return {...store.redact(view),configured:cfg.configured,resources:state.resources.snapshot(),strategy_settings:view.strategy_settings||store.get('strategy_settings'),holdings_authorization:view.mode==='live'?engine.holdings_authorization?.snapshot():null,limits:{capital:view.capital||0,risk_per_trade_pct:cfg.risk_per_trade_pct,daily_loss_pct:cfg.daily_loss_pct,max_positions:cfg.max_positions,max_position_pct:cfg.max_position_pct,entry_cutoff:cfg.entry_cutoff,exit_time:cfg.exit_time},server_time:isoIST(),maintenance:state.restartRequired||fs.existsSync(path.join(cfg.data_dir,'maintenance.lock')),restart_required:state.restartRequired};}
    app.get('/health',(_req,res)=>res.json({status:'ok',safe_to_stop:engine.snapshot().safe_to_stop===true}));
    app.get(['/','/settings'],(req,res)=>{try{authenticated(req);}catch{return res.redirect(303,'/login');}res.sendFile(path.join(STATIC,'index.html'));});
    app.get('/login',(_req,res)=>res.sendFile(path.join(STATIC,'login.html')));
    app.post('/api/login',async(req,res)=>{
      const {username,password}=req.body;if(typeof username!=='string'||username.length>128||typeof password!=='string'||password.length>512)throw failure(422,'Enter a username and password');
      const result=await state.loginLock.run(async()=>{const ip=req.context.ip;if(!state.limiter.check(ip))throw failure(429,'Too many sign-in attempts. Try again in 15 minutes.');if(!constantEqual(username,cfg.admin_username)||!await verifyPassword(cfg.admin_password_hash,password)){state.limiter.failure(ip);store.event('auth.failed','An unsuccessful dashboard sign-in was recorded.',{},'warning');throw failure(401,'Incorrect username or password');}const token=randomSecret(),csrf=randomSecret(32);store.new_session(digest_token(token,cfg.session_secret),csrf,Date.now()/1000+43200);store.event('auth.login','Administrator signed in.');return token;});
      res.set('Set-Cookie',`${COOKIE}=${result}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${req.context.secure?'; Secure':''}`).json({ok:true});
    });
    app.get('/api/session',(req,res)=>{const session=authenticated(req);res.json({username:cfg.admin_username,csrf:session.csrf,expires:session.expires});});
    app.post('/api/logout',(req,res)=>{store.drop_session(authenticated(req,true).digest);store.event('auth.logout','Administrator signed out. Trading state is unchanged.');res.set('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.context.secure?'; Secure':''}`).json({ok:true});});
    app.get('/api/state',(req,res)=>{authenticated(req);res.json({state:snapshot(),events:store.latest_events(),equity_history:store.samples(cfg.trading_mode)});});
    app.get('/api/events',(req,res)=>{authenticated(req);res.json(store.events(Math.max(0,Number(req.query.after)||0)));});
    app.get('/api/events/export',async(req,res)=>{const session=authenticated(req);res.type('application/x-ndjson').set('Content-Disposition','attachment; filename="stockpilot-audit.ndjson"');let after=0;while(!closing&&!res.destroyed&&store.session(session.digest)){const batch=store.events(after,500);if(!batch.length)break;for(const event of batch){if(res.destroyed)break;if(!res.write(JSON.stringify(event)+'\n'))await waitDrain(res);}after=batch.at(-1).id;await yieldIO();}res.end();});
    app.get('/api/stream',(req,res)=>{const session=authenticated(req);if(streams.size>=8)throw failure(429,'Too many live dashboard connections');res.set({'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});res.flushHeaders();let cursor=Math.max(0,Number(req.query.after)||0);const update=()=>{if(closing||res.writableLength>262144)return res.end();if(!store.session(session.digest)){res.write('event: expired\ndata: {}\n\n');return res.end();}if(res.writableNeedDrain)return;const events=store.events(cursor);if(events.length)cursor=events.at(-1).id;res.write('event: update\ndata: '+JSON.stringify({state:snapshot(),events})+'\n\n');};const timer=setInterval(update,2000);streams.add(res);res.on('close',()=>{clearInterval(timer);streams.delete(res);});update();});
    app.put('/api/settings',async(req,res)=>{
      authenticated(req,true);const v=req.body,defaults=defaultStrategies();if(!plainObject(v)||Object.keys(v).some(k=>!Object.hasOwn(defaults,k)))throw failure(422,'Invalid strategy settings');const values={...defaults,...v};
      if(!['selected','all'].includes(values.manage_existing_holdings)||!Array.isArray(values.managed_symbols)||values.managed_symbols.length>500||values.managed_symbols.some(s=>typeof s!=='string'||!/^[A-Z0-9&.-]{1,40}$/.test(s)))throw failure(422,'Choose valid NSE holding symbols');
      if(typeof values.intraday_enabled!=='boolean'||typeof values.swing_enabled!=='boolean'||!['intraday','swing'].every(s=>Number.isFinite(values[s+'_allocation_pct'])&&values[s+'_allocation_pct']>=0&&values[s+'_allocation_pct']<=1&&(!values[s+'_enabled']||values[s+'_allocation_pct']>0))||values.intraday_allocation_pct+values.swing_allocation_pct>1.000000001)throw failure(422,'Strategy allocations must total at most 100% of available trading funds');
      await state.control.run(async()=>{const view=engine.snapshot();if(state.restartRequired||view.status==='running'||view.positions?.length||view.pending_orders?.length)throw failure(409,'Pause entries and resolve managed exposure before changing settings');values.managed_symbols=[...new Set(values.managed_symbols)].sort();store.set('strategy_settings',values);store.event('settings.changed','Trading strategies and holding permissions updated.',values);});res.json({ok:true,settings:values});
    });
    app.post('/api/trading/start',async(req,res)=>{
      const session=authenticated(req,true);
      const result=await state.control.run(async()=>{
        authenticated(req,true);ready();
        if(engine.snapshot().connected){await engine.start();return {ok:true};}
        const nonce=randomSecret(32);store.set('oauth:'+session.digest,{nonce,origin:req.context.origin,expires:Date.now()/1000+600});
        store.event('session.login_requested','Start Trading requested. Waiting for Zerodha sign-in.');
        return {redirect_url:'https://kite.zerodha.com/connect/login?'+new URLSearchParams({v:'3',api_key:cfg.kite_api_key,redirect_params:new URLSearchParams({state:nonce}).toString()})};
      });res.json(result);
    });
    app.get('/auth/kite/callback',async(req,res)=>{
      let session;try{session=authenticated(req);}catch{return res.redirect(303,'/login?error=expired');}
      const target=await state.control.run(async()=>{
        const pending=store.get('oauth:'+session.digest);
        if(!pending||pending.origin!==req.context.origin||pending.expires<Date.now()/1000||!constantEqual(pending.nonce,req.query.state||'')){
          store.event('session.rejected','A Zerodha callback failed its session check.',{},'warning');return '/?error=callback';
        }
        store.delete('oauth:'+session.digest);const token=req.query.request_token;
        if(typeof token!=='string'||!token||token.length>1024||req.query.status!=='success')return '/?error=kite_login';
        store.add_secret(token);
        try{
          authenticated(req);ready();const result=await (options.exchangeToken||exchangeToken)(cfg,token);
          if(String(result.user_id).toUpperCase()!==cfg.kite_user_id.toUpperCase()){
            store.event('session.wrong_account','Zerodha login rejected: client ID did not match.',{},'error');return '/?error=wrong_account';
          }
          store.add_secret(result.access_token);
          const expiry=parseTime(dateIST(new Date(Date.now()+86400000))+'T06:00:00').getTime()/1000;
          store.set('kite_session',state.cipher.encrypt(JSON.stringify({access_token:result.access_token,user_id:result.user_id,expires:expiry})));
          await engine.connect(result.access_token,result.user_id);store.event('session.connected','Zerodha monitoring is active.');await engine.start();return '/';
        }catch{
          store.event('session.start_failed','Zerodha session could not start trading. Check account recovery status.',{},'error');return '/?error=start';
        }
      });res.redirect(303,target);
    });
    app.post('/api/trading/pause',async(req,res)=>{authenticated(req,true);await state.control.run(()=>engine.pause());res.json({ok:true});});
    app.post('/api/trading/flatten',async(req,res)=>{authenticated(req,true);await state.control.run(()=>engine.flatten());res.json({ok:true});});
    function authorizationRequest(req,refresh=false){
      authenticated(req,true);
      if(!plainObject(req.body)||Object.keys(req.body).some(key=>!refresh||key!=='user_confirmed')||refresh&&Object.hasOwn(req.body,'user_confirmed')&&typeof req.body.user_confirmed!=='boolean')throw failure(422,'Complete TPIN and OTP only on the official Zerodha/CDSL page');
      if(state.restartRequired)throw failure(409,'Restart the server before checking holdings authorization');
    }
    app.post('/api/holdings/authorization/start',async(req,res)=>{
      authorizationRequest(req);
      const result=await state.control.run(()=>{authorizationRequest(req);return engine.start_holdings_authorization();});res.json(result);
    });
    let lastAuthorizationCheck=-Infinity;
    app.post('/api/holdings/authorization/refresh',async(req,res)=>{
      authorizationRequest(req,true);
      const result=await state.control.run(async()=>{
        authorizationRequest(req,true);
        if(!req.body.user_confirmed&&Date.now()-lastAuthorizationCheck<3000)return engine.holdings_authorization?.snapshot();
        lastAuthorizationCheck=Date.now();return engine.refresh_holdings_authorization(req.body.user_confirmed===true);
      });res.json({authorization:result});
    });
    app.post('/api/kite/postback',async(req,res)=>{
      if(!cfg.configured)throw failure(503,'Kite account is not configured');const p=req.body;
      if(!plainObject(p)||typeof p.order_id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(p.order_id)||typeof p.order_timestamp!=='string'||!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(p.order_timestamp)||!parseTime(p.order_timestamp)||isoIST(parseTime(p.order_timestamp)).slice(0,19).replace('T',' ')!==p.order_timestamp||typeof p.user_id!=='string'||!/^[A-Za-z0-9]{1,32}$/.test(p.user_id)||typeof p.checksum!=='string'||!/^[a-f0-9]{64}$/i.test(p.checksum))throw failure(400,'Invalid Kite postback payload');
      if(!constantEqual(sha(p.order_id+p.order_timestamp+cfg.kite_api_secret),p.checksum.toLowerCase())||!constantEqual(p.user_id.toUpperCase(),cfg.kite_user_id.toUpperCase()))throw failure(403,'Invalid Kite postback authentication');
      const canonical=v=>Array.isArray(v)?v.map(canonical):plainObject(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
      const signature=sha(JSON.stringify(canonical(p)));await state.postbackLock.run(async()=>{const now=Date.now()/1000;const seen=store.get('kite_postback_receipts',[]).filter(i=>i.received_at>now-86400);if(!seen.some(i=>i.signature===signature)){store.event('kite.postback_received','Kite notification received. Order state is verified separately with Zerodha.',{order_id:p.order_id,order_timestamp:p.order_timestamp});store.set('kite_postback_receipts',[...seen,{signature,received_at:now}].slice(-2048));if(now-state.lastPostback>=15){engine.request_reconciliation();state.lastPostback=now;}}});res.json({status:'success'});
    });
    app.get('/api/config',(req,res)=>{authenticated(req);const origin=req.context.origin;res.json({values:manager?manager.candidate({}).publicValues():cfg.publicValues(),fields:FIELDS.filter(f=>f.key!=='admin_username'),admin_username:cfg.admin_username,restart_required:state.restartRequired,security_keys_generated:true,urls:{dashboard:origin,redirect:origin+'/auth/kite/callback',postback:origin+'/api/kite/postback'}});});
    app.put('/api/config',async(req,res)=>{
      authenticated(req,true);if(!manager)throw failure(409,'Settings storage is unavailable');if(!plainObject(req.body)||Object.keys(req.body).some(k=>!Object.hasOwn(DEFAULTS,k)||k==='admin_username'))throw failure(422,'Unknown application setting');
      const next=manager.candidate(req.body);
      await state.control.run(async()=>{const view=engine.snapshot();if(state.restartRequired)throw failure(409,'Restart the server before saving further application settings');if(view.status==='running'||view.positions?.length||view.pending_orders?.length||view.unmanaged_live_exposure)throw failure(409,'Pause entries and resolve managed exposure before changing application settings');
        const destination=path.join(next.data_dir,'stockpilot.sqlite3');if(next.data_dir!==cfg.data_dir&&fs.existsSync(destination))throw failure(409,'Choose a data directory without an existing StockPilot database');
        state.restartRequired=true;await engine.shutdown();
        if(next.data_dir!==cfg.data_dir){fs.mkdirSync(next.data_dir,{recursive:true,mode:0o700});store.db.prepare('VACUUM INTO ?').run(destination);}
        manager.save(req.body);store.event('config.changed','Application settings saved. Server restart required.',req.body);
      });res.json({ok:true,restart_required:true,message:'Saved. Stop the server with Ctrl+C, then run npm start to apply these settings.'});
    });
    app.put('/api/admin',async(req,res)=>{
      authenticated(req,true);if(!manager)throw failure(409,'Settings storage is unavailable');const {username,password,current_password,rotate_keys=false}=req.body;
      if(typeof rotate_keys!=='boolean'||typeof username!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(username)||typeof password!=='string'||password.length>512||password&&password.length<14)throw failure(422,'Use a valid username and a password of at least 14 characters');
      await state.loginLock.run(async()=>{
        authenticated(req,true);
        if(typeof current_password!=='string'||current_password.length>512||!await verifyPassword(cfg.admin_password_hash,current_password))throw failure(403,'Current administrator password is incorrect');
        const changes={admin_username:username};if(password)changes.admin_password_hash=await hashPassword(password);
        if(rotate_keys){const saved=store.get('kite_session');let decoded=null;if(saved)decoded=state.cipher.decrypt(saved);changes.session_secret=randomSecret();changes.token_encryption_key=crypto.randomBytes(32).toString('base64');const cipher=new Fernet(changes.token_encryption_key);manager.save(changes);Object.assign(cfg,changes);state.cipher=cipher;if(decoded)store.set('kite_session',cipher.encrypt(decoded));}
        else{manager.save(changes);Object.assign(cfg,changes);}
        store.add_secret(cfg.admin_password_hash);store.add_secret(cfg.session_secret);store.add_secret(cfg.token_encryption_key);store.revoke_sessions();store.set('admin_fingerprint',digest_token(cfg.admin_username+':'+cfg.admin_password_hash,cfg.session_secret));store.event('auth.changed','Administrator credentials/security settings updated. Dashboard sessions revoked.');
      });
      res.set('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`).json({ok:true,login_required:true});
    });
    app.use('/static',express.static(STATIC,{etag:false,maxAge:0}));
    app.use((_req,_res,next)=>next(failure(404,'Not found')));
    app.use((err,_req,res,_next)=>{if(res.headersSent)return res.end();const status=err.type==='entity.too.large'?413:err.status||409;res.status(status).json({detail:status>=500?'Server request failed; inspect the activity log.':store.redact(err.message||'Request failed')});});
    app.shutdown=async()=>{if(closing)return;closing=true;clearInterval(sampler);for(const res of streams)res.end();try{await state.control.run(()=>engine.shutdown());store.event('server.stopped','Server stopped. Broker orders remain at Zerodha.',{},'warning');}finally{store.close();lock.release();}};
    return app;
  }catch(error){clearInterval(sampler);try{await engine?.shutdown();}finally{store?.close();lock.release();}throw error;}
}
