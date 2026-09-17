import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {backupApplication,runOfflineResearch} from '../src/offline-tools.js';
import {Store} from '../src/storage.js';
import {Fernet,ProcessLock} from '../src/security.js';
import {DEFAULTS} from '../src/config.js';

function temporary(t,beforeCleanup=()=>{}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stock-offline-'));
  t.after(()=>{beforeCleanup();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  return directory;
}
function fixture(t,{external=false}={}){
  let store;
  const parent=temporary(t,()=>{try{store?.close();}catch{}}),root=path.join(parent,'app'),data=external?path.join(parent,'external-data'):path.join(root,'data');
  fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.mkdirSync(data,{recursive:true});
  const settings={...DEFAULTS,data_dir:external?data:'data',admin_password_hash:'$argon2id$fixture',session_secret:'s'.repeat(48),token_encryption_key:Buffer.alloc(32,17).toString('base64')};
  const configuration=JSON.stringify(settings,null,2)+'\n',credentials="KITE_API_KEY='fixture-api-key'\nKITE_API_SECRET='fixture-private-secret'\nKITE_USER_ID='AB1234'\n";
  fs.writeFileSync(path.join(root,'config','settings.json'),configuration);fs.writeFileSync(path.join(root,'.env'),credentials);
  store=new Store(path.join(data,'stockpilot.sqlite3'));const cipher=new Fernet(settings.token_encryption_key);
  const journal={positions:{INFY:{quantity:4,entry:100}},intents:{one:{state:'unknown'}},capital:100000};
  store.set('bot_state_live',journal);store.set('kite_session',cipher.encrypt('fixture-access-token'));
  return {parent,root,data,settings,configuration,credentials,store,cipher,journal};
}
function candles(){return {interval:'5minute',symbols:{INFY:Array.from({length:75},(_,i)=>{
  const price=i<20?100:100.6;
  return {time:new Date(+new Date('2026-09-17T09:15:00+05:30')+i*300000).toISOString(),
    open:i===20?100.1:price,high:i===20?100.6:price+.1,low:i===20?100.1:price-.1,close:price,volume:i===20?3000:1000};
})}};}

test('stopped-server backup preserves exact configuration, credentials and a consistent decryptable journal',async t=>{
  const f=fixture(t),destination=path.join(f.parent,'backup');
  const before=f.store.get('bot_state_live'),result=await backupApplication(f.root,destination);
  assert.equal(result.integrity,'ok');assert.equal(result.destination,fs.realpathSync(destination));
  assert.equal(fs.readFileSync(path.join(destination,'config','settings.json'),'utf8'),f.configuration);
  assert.equal(fs.readFileSync(path.join(destination,'.env'),'utf8'),f.credentials);
  const db=new DatabaseSync(path.join(destination,'data','stockpilot.sqlite3'),{readOnly:true});
  try{
    const get=key=>JSON.parse(db.prepare('SELECT value FROM kv WHERE key=?').get(key).value);
    assert.deepEqual(get('bot_state_live'),f.journal);
    const restoredSettings=JSON.parse(fs.readFileSync(path.join(destination,'config','settings.json'),'utf8'));
    assert.equal(new Fernet(restoredSettings.token_encryption_key).decrypt(get('kite_session')),'fixture-access-token');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{db.close();}
  assert.deepEqual(f.store.get('bot_state_live'),before);
  const manifest=JSON.parse(fs.readFileSync(path.join(destination,'manifest.json'),'utf8'));
  assert.equal(manifest.original_data_directory,fs.realpathSync(f.data));assert.match(manifest.restore,/matching settings/);
  assert.deepEqual(Object.keys(manifest.files).sort(),['.env','config/settings.json','data/stockpilot.sqlite3']);
  if(process.platform!=='win32')for(const filename of [...result.files,'manifest.json'])assert.equal(fs.statSync(path.join(destination,filename)).mode&0o777,0o600);
  assert.equal(JSON.stringify(result).includes('fixture-private-secret'),false);
});

test('backup excludes logs, caches, owner locks, unrelated databases and source dependencies',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.data,'debug.log'),'private log');fs.writeFileSync(path.join(f.data,'unrelated.sqlite3'),'unrelated');
  fs.mkdirSync(path.join(f.root,'node_modules'));fs.writeFileSync(path.join(f.root,'node_modules','do-not-copy'),'dependency');
  const destination=path.join(f.parent,'backup');await backupApplication(f.root,destination);
  assert.deepEqual(fs.readdirSync(destination).sort(),['.env','config','data','manifest.json']);
  assert.deepEqual(fs.readdirSync(path.join(destination,'data')),['stockpilot.sqlite3']);
  assert.deepEqual(fs.readdirSync(path.join(destination,'config')),['settings.json']);
});

test('an active server owner prevents backup before any destination is created',async t=>{
  const f=fixture(t),lock=new ProcessLock(path.join(f.data,'server-owner.sqlite3')),destination=path.join(f.parent,'backup');
  lock.acquire();try{await assert.rejects(backupApplication(f.root,destination),/Another StockPilot process/);}finally{lock.release();}
  assert.equal(fs.existsSync(destination),false);assert.deepEqual(f.store.get('bot_state_live'),f.journal);
});

test('backup refuses existing destinations and descendants of the real configured data directory',async t=>{
  const f=fixture(t,{external:true}),existing=path.join(f.parent,'existing');fs.mkdirSync(existing);fs.writeFileSync(path.join(existing,'keep'),'unchanged');
  await assert.rejects(backupApplication(f.root,existing),/must not already exist/);
  await assert.rejects(backupApplication(f.root,path.join(f.data,'recursive-backup')),/outside the data/);
  await assert.rejects(backupApplication(f.root,path.join(f.root,'config','backup')),/outside the data/);
  assert.equal(fs.readFileSync(path.join(existing,'keep'),'utf8'),'unchanged');
  const destination=path.join(f.parent,'external-backup');await backupApplication(f.root,destination);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination,'manifest.json'),'utf8')).original_data_directory,fs.realpathSync(f.data));
});

test('backup cannot publish credentials through public directories or directory aliases',async t=>{
  const f=fixture(t),publicDirectory=path.join(f.root,'public');fs.mkdirSync(publicDirectory);
  fs.symlinkSync(publicDirectory,path.join(f.root,'public-alias'),process.platform==='win32'?'junction':'dir');
  for(const base of [publicDirectory,path.join(f.root,'public-alias')]){
    const destination=path.join(base,'private-backup');
    await assert.rejects(backupApplication(f.root,destination),/outside publicly served/);
    assert.equal(fs.existsSync(destination),false);
  }
  assert.deepEqual(fs.readdirSync(publicDirectory),[]);
});

test('backup rejects differing effective Kite environment overrides without exporting or logging secrets',async t=>{
  const f=fixture(t);
  for(const key of ['KITE_API_KEY','KITE_API_SECRET','KITE_USER_ID']){
    const destination=path.join(f.parent,'override-'+key),secret='distinct-process-secret';
    await assert.rejects(backupApplication(f.root,destination,{environment:{[key]:secret}}),error=>{
      assert.match(error.message,/override differs from \.env/);assert.equal(error.message.includes(secret),false);return true;
    });
    assert.equal(fs.existsSync(destination),false);
  }
  const destination=path.join(f.parent,'matching-overrides');
  await backupApplication(f.root,destination,{environment:{KITE_API_KEY:' fixture-api-key ',KITE_API_SECRET:'fixture-private-secret',KITE_USER_ID:'ab1234'}});
  assert.equal(fs.readFileSync(path.join(destination,'.env'),'utf8'),f.credentials);
  const manifest=JSON.parse(fs.readFileSync(path.join(destination,'manifest.json'),'utf8'));
  assert.match(manifest.credentials_source,/Process and service environment secrets are not exported/);
});

test('failed database backup removes only its new files and releases the stopped-server lock',async t=>{
  const f=fixture(t),destination=path.join(f.parent,'bad-backup');f.store.close();
  fs.writeFileSync(path.join(f.data,'stockpilot.sqlite3'),'invalid sqlite');
  await assert.rejects(backupApplication(f.root,destination));assert.equal(fs.existsSync(destination),false);
  const lock=new ProcessLock(path.join(f.data,'server-owner.sqlite3'));lock.acquire();lock.release();
  assert.equal(fs.readFileSync(path.join(f.root,'.env'),'utf8'),f.credentials);
});

test('offline research requires explicit capital and exports exclusively without loading account configuration',async t=>{
  const directory=temporary(t),input=path.join(directory,'candles.json'),output=path.join(directory,'report.json');fs.writeFileSync(input,JSON.stringify(candles()));
  await assert.rejects(runOfflineResearch(input,output,undefined),/explicit positive capital/);assert.equal(fs.existsSync(output),false);
  const result=await runOfflineResearch(input,output,25000),report=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.equal(result.baseline_trades,1);assert.equal(report.baseline.metrics.initial_capital,25000);
  assert.equal(report.enhanced.metrics.initial_capital,25000);assert.equal(fs.existsSync(path.join(directory,'config')),false);
  const bytes=fs.readFileSync(output);await assert.rejects(runOfflineResearch(input,output,25000),/must not already exist/);
  assert.deepEqual(fs.readFileSync(output),bytes);
});

test('offline import bounds and diagnostics do not expose text from malformed private input',async t=>{
  const directory=temporary(t),input=path.join(directory,'private.json'),output=path.join(directory,'report.json');
  fs.writeFileSync(input,'{"secret":"fixture-private-secret",invalid');
  await assert.rejects(runOfflineResearch(input,output,10000),error=>/Cannot import dataset/.test(error.message)&&!error.message.includes('fixture-private-secret'));
  fs.truncateSync(input,64*1024*1024+1);await assert.rejects(runOfflineResearch(input,output,10000),/64 MiB/);
  assert.equal(fs.existsSync(output),false);
});

test('research CLI rejects missing capital and never prints credential contents from malformed data',t=>{
  const directory=temporary(t),input=path.join(directory,'private.json'),output=path.join(directory,'report.json');fs.writeFileSync(input,'fixture-private-secret');
  const cli=path.resolve('src/cli.js'),missing=spawnSync(process.execPath,[cli,'research',input,output],{encoding:'utf8'});
  assert.equal(missing.status,1);assert.match(missing.stderr,/<capital>/);
  const invalid=spawnSync(process.execPath,[cli,'research',input,output,'10000'],{encoding:'utf8'});
  assert.equal(invalid.status,1);assert.equal((invalid.stdout+invalid.stderr).includes('fixture-private-secret'),false);
  assert.equal(fs.existsSync(output),false);
});
