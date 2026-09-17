import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fork} from 'node:child_process';
import {TradingEngine} from '../src/trading.js';
import {Store} from '../src/storage.js';
import {ProcessLock} from '../src/security.js';
import {SYMBOL,TOKEN,settings,options,instrument,freshTick,entrySignal} from './fixtures/crash-entry-child.mjs';

function bounded(promise,timeout,message){
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),timeout);})]).finally(()=>clearTimeout(timer));
}
function launch(directory,side){
  // No inherited Kite credentials or NODE_OPTIONS. The helper replaces fetch
  // and socket connections, and uses only the synthetic broker below.
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(key)));
  const child=fork(path.join(import.meta.dirname,'fixtures','crash-entry-child.mjs'),[directory,side],{
    cwd:directory,env,execArgv:[],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,
  });
  let stderr='',spawnError;
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4096);});
  child.on('error',error=>{spawnError=error;});
  const completed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,stderr,error:spawnError})));
  const ready=new Promise((resolve,reject)=>{
    const message=value=>{if(value?.type==='accepted-without-acknowledgement'){cleanup();resolve(value);}};
    const error=err=>{cleanup();reject(err);};
    const closed=()=>{cleanup();reject(new Error('Crash child closed before durable submission: '+stderr));};
    function cleanup(){child.off('message',message);child.off('error',error);child.off('close',closed);}
    child.on('message',message);child.once('error',error);child.once('close',closed);
  });
  return {child,ready,completed};
}
async function terminateOwnChild(handle){
  if(!handle)return;
  if(handle.child.exitCode===null&&handle.child.signalCode===null){
    assert.ok(Number.isSafeInteger(handle.child.pid)&&handle.child.pid>0);
    handle.child.kill('SIGKILL');
  }
  return bounded(handle.completed,5000,'The exact crash-test child did not terminate');
}
class RecoveryBroker {
  constructor(account){this.current=structuredClone(account);this.mutations=[];this.reads=[];}
  async account(){this.reads.push('account');return structuredClone(this.current);}
  async call(method,...args){
    this.reads.push(method);
    if(method==='profile')return {user_id:'AB1234',meta:{demat_consent:'physical'}};
    if(method==='instruments')return [instrument()];
    if(method==='get_gtts'||method==='historical_data')return [];
    if(method==='order_history')return this.current.orders.filter(order=>order.order_id===args[0]).map(order=>structuredClone(order));
    if(Object.hasOwn(this.current,method))return structuredClone(this.current[method]);
    this.mutations.push(method);throw new Error('Unexpected broker operation during crash recovery: '+method);
  }
  async buy_cover(){this.mutations.push('buy_cover');throw new Error('Duplicate cover BUY during recovery');}
  async sell_cover(){this.mutations.push('sell_cover');throw new Error('Duplicate cover SELL during recovery');}
  async cancel_cover(){this.mutations.push('cancel_cover');throw new Error('Unexpected cover cancellation during recovery');}
  async stream(tokens,_ticks,_orders,status){this.reads.push('stream');status(0,true,tokens);}
  async close(){}
}
function expectClose(actual,expected){assert.ok(Math.abs(actual-expected)<1e-8,`${actual} differs from ${expected}`);}

for(const side of ['BUY','SELL'])test(`${side} cover ownership and P&L survive an actual process kill before broker acknowledgement`,{timeout:30000},async t=>{
  let external=0;
  t.mock.method(globalThis,'fetch',()=>{external++;throw new Error('Network forbidden by process crash test');});
  t.mock.method(net.Socket.prototype,'connect',function(){external++;throw new Error('Sockets forbidden by process crash test');});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockpilot-crash-'));
  const filename=path.join(directory,'stockpilot.sqlite3'),lockfile=path.join(directory,'server-owner.sqlite3');
  let running,owner,store,engine;
  const closeEngine=async()=>{
    try{await engine?.shutdown();}finally{engine=null;try{store?.close();}finally{store=null;owner?.release();owner=null;}}
  };
  t.after(async()=>{
    await terminateOwnChild(running);await closeEngine();
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('stockpilot-crash-'));
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:3});
  });
  running=launch(directory,side);
  const accepted=await bounded(running.ready,12000,'Crash child did not reach a durable broker intent');
  assert.equal(accepted.pid,running.child.pid);assert.equal(accepted.submissions,1);
  assert.equal(accepted.intent.state,'submitting');assert.equal(accepted.intent.order_id,undefined);
  assert.equal(accepted.intent.side,side);assert.ok(accepted.intent.quantity>=4);assert.ok(accepted.wal_bytes>0);
  const competitor=new ProcessLock(lockfile);
  try{assert.throws(()=>competitor.acquire(),/Another StockPilot process/);}finally{competitor.release();}

  // SIGKILL/TerminateProcess bypasses JS shutdown and SQLite close. This is a
  // process-crash test; it does not simulate storage-controller/power failure.
  assert.equal(running.child.kill('SIGKILL'),true);
  const terminal=await bounded(running.completed,5000,'Killed crash child still owns its handles');
  assert.equal(terminal.error,undefined);assert.equal(terminal.signal,'SIGKILL');
  assert.ok(fs.statSync(filename+'-wal').size>0);
  const broker=new RecoveryBroker(accepted.account),intent=accepted.intent,q=intent.quantity,direction=side==='SELL'?-1:1;
  const reopen=()=>{
    owner=new ProcessLock(lockfile);owner.acquire(); // The OS released the killed owner's lock.
    store=new Store(filename);assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    engine=new TradingEngine(settings(directory),store,options(broker));
  };
  reopen();
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
  const persisted=store.get('bot_state_live');assert.equal(persisted.intents[intent.tag].state,'submitting');
  assert.equal(persisted.intents[intent.tag].order_id,undefined);assert.ok(persisted.traded.includes(SYMBOL));
  assert.equal(store.events().filter(event=>event.kind==='order_intent').length,1);
  assert.equal(store.events().some(event=>event.kind==='server.stopped'||event.kind==='disconnected'),false);
  assert.equal(engine.running,false);assert.equal(engine._unresolved_intents(),true);
  expectClose(engine._exposure(),intent.entry*q);

  await engine.connect('synthetic-recovery-session','AB1234');
  assert.equal(engine.intents[intent.tag].order_id,'accepted-'+side);
  assert.equal(engine.intents[intent.tag].state,'open');assert.equal(engine.positions[SYMBOL].side,side);
  assert.equal(engine.positions[SYMBOL].quantity,q);assert.equal(engine.account.positions.net[0].quantity,direction*q);
  assert.equal(engine.positions[SYMBOL].stop,intent.stop);assert.equal(engine.running,false);
  expectClose(engine._exposure(),intent.entry*q);expectClose(engine.realised,0);
  engine._on_ticks([freshTick()]);await engine.start();
  assert.equal(engine.recovery.blocked,false);
  assert.equal(await engine._enter_locked(TOKEN,entrySignal(side)),'already_owned_or_traded_today');
  assert.deepEqual(broker.mutations,[]);

  const partial=2,firstExit=intent.entry+direction;
  const child=broker.current.orders[1];Object.assign(child,{status:'OPEN',filled_quantity:partial,pending_quantity:q-partial,average_price:firstExit});
  broker.current.positions.net[0].quantity=direction*(q-partial);
  await engine._refresh_account_locked();
  const partialPnl=direction*(firstExit-intent.entry)*partial-(intent.entry+firstExit)*partial*.001;
  expectClose(engine.realised,partialPnl);assert.equal(engine.positions[SYMBOL].quantity,q-partial);
  await engine._refresh_account_locked();expectClose(engine.realised,partialPnl);
  await closeEngine();reopen();expectClose(engine.realised,partialPnl);
  await engine.connect('synthetic-second-session','AB1234');
  expectClose(engine.realised,partialPnl);assert.equal(engine.positions[SYMBOL].quantity,q-partial);
  assert.equal(engine.account.positions.net[0].quantity,direction*(q-partial));

  const lastExit=intent.entry+direction*2,cumulativeExit=(firstExit*partial+lastExit*(q-partial))/q;
  Object.assign(broker.current.orders[1],{status:'COMPLETE',filled_quantity:q,pending_quantity:0,average_price:cumulativeExit});
  broker.current.positions.net=[];
  await engine._refresh_account_locked();
  const fullPnl=direction*((firstExit-intent.entry)*partial+(lastExit-intent.entry)*(q-partial))-(intent.entry*q+firstExit*partial+lastExit*(q-partial))*.001;
  expectClose(engine.realised,fullPnl);assert.deepEqual(engine.positions,{});assert.equal(engine.intents[intent.tag].state,'closed');
  expectClose(engine._exposure(),0);await engine._refresh_account_locked();expectClose(engine.realised,fullPnl);
  await closeEngine();reopen();await engine.connect('synthetic-third-session','AB1234');
  expectClose(engine.realised,fullPnl);assert.deepEqual(engine.positions,{});assert.equal(engine._unresolved_intents(),false);
  engine._on_ticks([freshTick()]);await engine.start();
  assert.equal(await engine._enter_locked(TOKEN,entrySignal(side)),'already_owned_or_traded_today');
  assert.equal(store.events().filter(event=>event.kind==='order_intent').length,1);
  assert.equal(store.events().filter(event=>event.kind==='intent_closed').length,1);
  assert.deepEqual(broker.mutations,[]);assert.equal(external,0);
});
