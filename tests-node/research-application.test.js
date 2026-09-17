import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigManager} from '../src/config.js';
import {Mutex} from '../src/util.js';
import {createResearchApplier} from '../src/research-application.js';

const HASH='$argon2id$v=19$m=65536,t=3,p=4$VMU0lS4iHSmQ1iYO3vilQw$STATLHnZvG42lqShST2dJnmzbG52cNmgNoqnIzjGfiE';
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'stock-tuning-apply-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3}));
  const manager=new ConfigManager(root,{ADMIN_PASSWORD_HASH:HASH}),settings=await manager.load(),events=[];
  const engine={connected:true,running:false,status:'paused',_lock:new Mutex(),invalidations:0,positions:[],pending:[],
    snapshot(){return {positions:this.positions,pending_orders:this.pending};},
    _invalidate_decisions(){this.invalidations++;},
    start(){throw new Error('Research must not start trading');},flatten(){throw new Error('Research must not place orders');}};
  let allowed=true;
  const apply=createResearchApplier({settings,manager,engine,store:{event:(...args)=>events.push(args)},canApply:()=>allowed});
  return {settings,manager,engine,events,apply,setAllowed:value=>allowed=value};
}

test('validated parameters persist in paper and live modes without changing risk, execution permissions or paused state',async t=>{
  for(const mode of ['paper','live']){
    const f=await fixture(t);f.settings.trading_mode=mode;f.settings.live_trading_enabled=false;
    const before=f.settings.publicValues();
    const result=await f.apply({parameters:{min_signal_score:65,min_adx:21},isCurrent:()=>true});
    assert.equal(result.status,'applied');assert.equal(f.manager.candidate({}).min_signal_score,65);
    assert.equal(f.engine.invalidations,1);assert.equal(f.engine.running,false);assert.equal(f.engine.status,'paused');
    const after=f.settings.publicValues();
    for(const key of Object.keys(before))if(!['min_signal_score','min_adx'].includes(key))assert.equal(after[key],before[key],`${key} must stay fixed`);
    assert.deepEqual(result.changes,[{key:'min_signal_score',before:60,after:65},{key:'min_adx',before:18,after:21}]);
    assert.equal(f.events.at(-1)[0],'research.parameters_applied');
  }
});

test('open positions or pending orders defer parameter application without cancelling exposure',async t=>{
  const f=await fixture(t);
  for(const field of ['positions','pending']){
    f.engine[field]=[{symbol:'INFY'}];
    assert.equal((await f.apply({parameters:{min_adx:21},isCurrent:()=>true})).status,'waiting');
    assert.equal(f.settings.min_adx,18);assert.equal(f.manager.candidate({}).min_adx,18);assert.equal(f.engine[field].length,1);
    f.engine[field]=[];
  }
  assert.equal(f.engine.invalidations,0);
});

test('stale context and disabled application cannot change settings',async t=>{
  const f=await fixture(t),parameters={min_adx:21};
  assert.equal((await f.apply({parameters,isCurrent:()=>false})).status,'stale');
  f.setAllowed(false);assert.equal((await f.apply({parameters,isCurrent:()=>true})).status,'stale');
  f.settings.research_tuning_apply=false;
  assert.equal((await f.apply({parameters,isCurrent:()=>true})).status,'disabled');
  assert.equal(f.manager.candidate({}).min_adx,18);assert.equal(f.engine.invalidations,0);
});

test('result cannot change risk, cost assumptions, live permissions or invalid parameter values',async t=>{
  const f=await fixture(t);
  for(const parameters of [{risk_per_trade_pct:.1},{research_fee_rate:0},{live_trading_enabled:true},{intraday_short_enabled:true},{min_adx:NaN},{}]){
    assert.equal((await f.apply({parameters,isCurrent:()=>true})).status,'not_applied');
  }
  await assert.rejects(f.apply({parameters:{min_adx:1000},isCurrent:()=>true}),/min_adx/);
  assert.equal(f.engine.invalidations,0);assert.equal(f.settings.min_adx,18);
});

test('context is rechecked after waiting for the execution lock',async t=>{
  const f=await fixture(t);let unlock;
  const holding=f.engine._lock.run(()=>new Promise(resolve=>{unlock=resolve;}));
  await Promise.resolve();let current=true;
  const applying=f.apply({parameters:{min_adx:21},isCurrent:()=>current});
  current=false;unlock();await holding;
  assert.equal((await applying).status,'stale');assert.equal(f.engine.invalidations,0);
});

test('failed durable save leaves active settings and analytics generation unchanged',async t=>{
  const f=await fixture(t);f.manager.save=()=>{throw new Error('Disk unavailable');};
  await assert.rejects(f.apply({parameters:{min_adx:21},isCurrent:()=>true}),/Disk unavailable/);
  assert.equal(f.settings.min_adx,18);assert.equal(f.engine.invalidations,0);
});

test('manual application is independent of the automatic toggle and still enforces exposure and authority checks',async t=>{
  const f=await fixture(t);f.settings.research_tuning_apply=false;
  const request={parameters:{min_adx:21},isCurrent:()=>true,source:'manual'};
  f.engine.pending=[{symbol:'INFY'}];assert.equal((await f.apply(request)).status,'waiting');assert.equal(f.engine.invalidations,0);
  f.engine.pending=[];f.setAllowed(false);assert.equal((await f.apply(request)).status,'stale');
  f.setAllowed(true);assert.equal((await f.apply({...request,parameters:{live_trading_enabled:true}})).status,'not_applied');
  const applied=await f.apply(request);assert.equal(applied.status,'applied');assert.equal(applied.source,'manual');assert.equal(f.settings.min_adx,21);assert.equal(f.settings.research_tuning_apply,false);
  assert.equal(f.events.at(-1)[2].source,'manual');assert.equal(f.engine.running,false);
});
