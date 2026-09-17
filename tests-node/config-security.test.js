import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ConfigManager, DEFAULTS, FIELDS } from '../src/config.js';
import { Fernet, strictJSON, verifyPassword, ProcessLock } from '../src/security.js';
import { Store } from '../src/storage.js';
import { requestContext } from '../src/http-context.js';

const HASH='$argon2id$v=19$m=65536,t=3,p=4$VMU0lS4iHSmQ1iYO3vilQw$STATLHnZvG42lqShST2dJnmzbG52cNmgNoqnIzjGfiE';
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockpilot-security-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:3}));return dir;}
test('only three Kite credentials are needed; other settings persist and env does not override saved values',async t=>{
  const dir=temp(t);fs.writeFileSync(path.join(dir,'.env'),"KITE_API_KEY='test-key'\nKITE_API_SECRET='test-secret'\nKITE_USER_ID='ab1234'\n");
  const manager=new ConfigManager(dir,{});let initial='';const cfg=await manager.load({onInitialPassword:value=>initial=value});
  assert.ok(initial.length>=24);assert.ok(await verifyPassword(cfg.admin_password_hash,initial));assert.equal(cfg.kite_user_id,'AB1234');assert.equal(cfg.port,3000);assert.equal(cfg.analytics_workers,0);assert.equal(cfg.trading_mode,'paper');
  assert.equal(cfg.publicValues().public_url,undefined);assert.equal(cfg.publicValues().paper_capital,undefined);assert.equal(cfg.publicValues().data_dir,'data');
  manager.save({port:3100,analytics_reserve_cpus:2});
  const reload=await new ConfigManager(dir,{PORT:'9999',KITE_API_KEY:'changed-key'}).load({onInitialPassword:()=>assert.fail('Existing password must not regenerate')});
  assert.equal(reload.port,3100);assert.equal(reload.kite_api_key,'changed-key');assert.equal(reload.analytics_reserve_cpus,2);assert.equal(reload.admin_password_hash,cfg.admin_password_hash);
  assert.doesNotMatch(fs.readFileSync(manager.filename,'utf8'),/test-key|test-secret/);
  assert.deepEqual(Object.keys(reload.publicValues()).sort(),Object.keys(DEFAULTS).sort());
});
test('research CPU scheduling defaults safely, persists either mode and rejects unsupported values atomically',async t=>{
  const dir=temp(t),manager=new ConfigManager(dir,{}),initial=await manager.load({password:'Affinity-config-test-password!'});
  assert.equal(initial.research_cpu_affinity,'pinned');assert.equal(initial.publicValues().research_cpu_affinity,'pinned');
  assert.deepEqual(FIELDS.find(field=>field.key==='research_cpu_affinity'),{key:'research_cpu_affinity',label:'Research CPU scheduling',type:'select',choices:['pinned','automatic']});
  for(const mode of ['automatic','pinned']){manager.save({research_cpu_affinity:mode});const restored=await new ConfigManager(dir,{}).load();assert.equal(restored.research_cpu_affinity,mode);}
  const before=fs.readFileSync(manager.filename,'utf8');
  for(const mode of ['auto','exclusive',true,null,0])assert.throws(()=>manager.save({research_cpu_affinity:mode}),/Research CPU scheduling/);
  assert.equal(fs.readFileSync(manager.filename,'utf8'),before);
  const legacy=JSON.parse(before);delete legacy.research_cpu_affinity;fs.writeFileSync(manager.filename,JSON.stringify(legacy));
  assert.equal((await new ConfigManager(dir,{}).load()).research_cpu_affinity,'pinned');
});
test('legacy auth keys and directory import once; invalid config save leaves stored settings intact',async t=>{
  const dir=temp(t),key='AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const manager=new ConfigManager(dir,{ADMIN_PASSWORD_HASH:HASH,SESSION_SECRET:'s'.repeat(40),TOKEN_ENCRYPTION_KEY:key,DATA_DIR:'journal',PUBLIC_URL:'https://old.example',PAPER_CAPITAL:'999999'});
  const cfg=await manager.load();assert.equal(cfg.admin_password_hash,HASH);assert.equal(cfg.token_encryption_key,key);assert.equal(cfg.data_dir,path.join(dir,'journal'));
  assert.equal(manager.saved.public_url,undefined);assert.equal(manager.saved.paper_capital,undefined);
  const before=fs.readFileSync(manager.filename,'utf8');assert.throws(()=>manager.save({port:NaN}));assert.equal(fs.readFileSync(manager.filename,'utf8'),before);
});

test('private data paths cannot enter publicly served files through direct, missing or linked descendants',async t=>{
  const dir=temp(t),manager=new ConfigManager(dir,{});await manager.load({password:'Static-path-test-password!'});
  const before=fs.readFileSync(manager.filename,'utf8');
  for(const data_dir of ['public',path.join('public','not-created','journal')])assert.throws(()=>manager.save({data_dir}),/outside publicly served/);
  fs.mkdirSync(path.join(dir,'public'));fs.symlinkSync(path.join(dir,'public'),path.join(dir,'public-alias'),process.platform==='win32'?'junction':'dir');
  for(const data_dir of ['public-alias',path.join('public-alias','new','journal')])assert.throws(()=>manager.save({data_dir}),/outside publicly served/);
  assert.equal(fs.readFileSync(manager.filename,'utf8'),before);
  assert.equal(manager.candidate({data_dir:'public-private'}).data_dir,path.join(dir,'public-private'));
});
test('native Fernet and Argon2 accept fixtures written by Python and reject tampering',async()=>{
  const cipher=new Fernet('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='),fixture='gAAAAABqqy0m8Lh_bQQ_vXguCv53cTMZA6SzHhhAOur8PPIUCXQvhf8hli4opcIuC1i96p5Cl5zsBL6yShht1doE1FMceOu9_Z_GGN_iDFsoO4hZs9CoA-U=';
  assert.equal(cipher.decrypt(fixture),'Node migration fixture');const token=cipher.encrypt('unicode ₹ payload');assert.equal(cipher.decrypt(token),'unicode ₹ payload');
  const tampered=Buffer.from(token,'base64');tampered[30]^=1;assert.throws(()=>cipher.decrypt(tampered.toString('base64')));assert.throws(()=>new Fernet('invalid'));
  assert.ok(await verifyPassword(HASH,'a-long-test-password-only'));assert.equal(await verifyPassword(HASH,'wrong'),false);
});
test('strict parser rejects duplicate keys, invalid UTF-8, oversized numbers and deep nesting',()=>{
  for(const raw of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','[1e999]','[NaN]','truefalse','[1,]','{"x":1,}','"unterminated','['.repeat(102)+'0'+']'.repeat(102)])assert.throws(()=>strictJSON(Buffer.from(raw)));
  assert.throws(()=>strictJSON(Buffer.from([0x22,0xc3,0x22])));
  const result=strictJSON(Buffer.from('{"__proto__":{"polluted":true},"value":[true,null,-1.2e2]}'));
  assert.equal(Object.getPrototypeOf(result),null);assert.equal({}.polluted,undefined);assert.deepEqual(result.value,[true,null,-120]);
});
test('SQLite journals, sessions, events and redaction survive reopen',t=>{
  const filename=path.join(temp(t),'test.sqlite3');let store=new Store(filename,['private-secret']);
  store.set('bot_state_live',{positions:{ABC:{quantity:3}}});store.new_session('digest','csrf',Date.now()/1000+60);store.event('sample','private-secret',{access_token:'secret',nested:{password:'password'},safe:42});store.close();
  store=new Store(filename);assert.equal(store.get('bot_state_live').positions.ABC.quantity,3);assert.equal(store.session('digest').csrf,'csrf');assert.equal(store.events()[0].data.safe,42);assert.doesNotMatch(JSON.stringify(store.events()),/private-secret|"secret"|"password":"password"/);assert.throws(()=>store.set('bad',NaN));store.revoke_sessions();assert.equal(store.session('digest'),null);store.close();
});
test('process ownership is released by the OS when a Node process crashes',{timeout:15000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockpilot-security-'));
  const filename=path.join(dir,'owner.sqlite3'),url=new URL('../src/security.js',import.meta.url).href;
  // An empty interval does not retain an eval module's local owner. Keep the
  // native SQLite connection reachable until this child is deliberately killed.
  const script=`import {ProcessLock} from ${JSON.stringify(url)};const lock=new ProcessLock(${JSON.stringify(filename)});lock.acquire();setInterval(()=>{if(!lock.db)process.exit(2);},1000);process.send({type:'lock-ready',pid:process.pid});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  child.stderr.resume();
  const lock=new ProcessLock(filename);
  const crash=async()=>{
    if(child.pid===undefined||child.exitCode!==null||child.signalCode!==null)return;
    const exited=once(child,'exit',{signal:AbortSignal.timeout(5000)});
    child.kill('SIGKILL');await exited;
  };
  t.after(async()=>{lock.release();try{await crash();}finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:3});}});
  const ready=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('Lock owner did not signal readiness within 5 seconds')),5000);
    const message=value=>{if(value?.type==='lock-ready'&&value.pid===child.pid)finish();};
    const exited=()=>finish(new Error('Lock owner exited before acquiring ownership'));
    const failed=error=>finish(error);
    function finish(error){clearTimeout(timer);child.off('message',message);child.off('exit',exited);child.off('error',failed);error?reject(error):resolve(true);}
    child.on('message',message);child.once('exit',exited);child.once('error',failed);
  });
  assert.equal(ready,true);assert.throws(()=>lock.acquire(),/Another StockPilot/);
  await crash();lock.acquire();lock.release();
});
test('proxy metadata is accepted only from loopback and Cloudflare HTTPS',()=>{
  const headers={host:'dashboard.example.org','cf-ray':'aabbccddeeff1234-BOM','x-forwarded-proto':'https','cf-connecting-ip':'203.0.113.1'};
  assert.throws(()=>requestContext({headers,socket:{remoteAddress:'192.168.1.2'}}));
  assert.equal(requestContext({headers,socket:{remoteAddress:'127.0.0.1'}}).origin,'https://dashboard.example.org');
  for(const host of ['example.org/evil','user@example.org','example.org,evil.org'])assert.throws(()=>requestContext({headers:{...headers,host},socket:{remoteAddress:'127.0.0.1'}}));
});
