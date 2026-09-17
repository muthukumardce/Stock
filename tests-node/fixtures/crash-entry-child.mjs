import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {TradingEngine} from '../../src/trading.js';
import {Store} from '../../src/storage.js';
import {ProcessLock} from '../../src/security.js';
import {Signal} from '../../src/strategy.js';
import {dateIST,monotonic} from '../../src/util.js';

export const NOW=new Date('2026-09-17T12:00:00+05:30');
export const SYMBOL='CRASHTEST';
export const TOKEN=22;
export function settings(directory){return {
  trading_mode:'live',live_trading_enabled:true,intraday_short_enabled:true,
  data_dir:directory,kite_api_key:'synthetic-crash-key',kite_user_id:'AB1234',
  max_position_pct:.01,risk_per_trade_pct:.0025,daily_loss_pct:.01,max_positions:5,
  entry_cutoff:'14:45',exit_time:'15:10',max_spread_pct:.003,min_daily_turnover:10000,
};}
export function options(broker){return {now:()=>NOW,backgroundLoops:false,brokerFactory:()=>broker,
  equityUniverse:{resolve:async instruments=>({instruments:instruments.map(i=>({...i,entry_eligible:true})),summary:{status:'verified'}})},
  analyticsFactory:()=>({worker_limit:1,batch_size:1,snapshot:()=>({}),close:async()=>{},analyze:async()=>[]})};}
export function entrySignal(side){const signal=new Signal('intraday',100,side==='SELL'?102:98,side==='SELL'?96:104,'Synthetic crash recovery setup',2);signal.side=side;return signal;}
export function emptyAccount(){return {orders:[],trades:[],holdings:[],positions:{net:[]},margins:{equity:{available:{cash:100000,live_balance:100000}}}};}
export function instrument(){return {instrument_token:TOKEN,exchange:'NSE',segment:'NSE',instrument_type:'EQ',tradingsymbol:SYMBOL,tick_size:.05};}
export function freshTick(){return {instrument_token:TOKEN,exchange_timestamp:NOW,last_price:100,volume_traded:100000,
  depth:{buy:[{price:99.95,quantity:10000}],sell:[{price:100.05,quantity:10000}]}};}
export function acceptedAccount(intent){
  const account=emptyAccount(),parentId='accepted-'+intent.side,quantity=intent.quantity;
  const shared={exchange:'NSE',tradingsymbol:SYMBOL,product:'MIS',variety:'co',quantity};
  account.orders=[{...shared,order_id:parentId,tag:intent.tag,transaction_type:intent.side,
    status:'COMPLETE',filled_quantity:quantity,pending_quantity:0,average_price:intent.entry},
  {...shared,order_id:'stop-'+intent.side,parent_order_id:parentId,transaction_type:intent.side==='SELL'?'BUY':'SELL',
    status:'TRIGGER PENDING',filled_quantity:0,pending_quantity:quantity,average_price:0,trigger_price:intent.stop}];
  account.positions.net=[{exchange:'NSE',tradingsymbol:SYMBOL,product:'MIS',quantity:(intent.side==='SELL'?-1:1)*quantity,average_price:intent.entry,last_price:intent.entry}];
  account.trades=[{order_id:parentId,trade_id:'synthetic-entry',tradingsymbol:SYMBOL,transaction_type:intent.side,quantity,average_price:intent.entry}];
  return account;
}

async function childMain(directory,side){
  // This process has no graceful shutdown/signal hooks. The parent terminates
  // exactly this child while its simulated broker acknowledgement is pending.
  assert.ok(['BUY','SELL'].includes(side));
  globalThis.fetch=()=>{throw new Error('Network forbidden in crash fixture');};
  net.Socket.prototype.connect=function(){throw new Error('Sockets forbidden in crash fixture');};
  const deadline=setTimeout(()=>{console.error('Crash fixture was not terminated before its deadline');process.exit(93);},25000);
  const lock=new ProcessLock(path.join(directory,'server-owner.sqlite3'));lock.acquire();
  const filename=path.join(directory,'stockpilot.sqlite3'),store=new Store(filename);
  const engine=new TradingEngine(settings(directory),store,options());
  engine.connected=engine.running=true;engine.status='running';engine.user_id='AB1234';
  engine.universe={[TOKEN]:instrument()};engine.quotes={[TOKEN]:{...freshTick(),received_at:monotonic()}};
  engine.account=emptyAccount();engine._update_capital(true);engine._account_at=monotonic();
  engine._profile_verified=engine._recovery_account_verified=true;engine.day=dateIST(NOW);
  Object.assign(engine.recovery,{phase:'ready',blocked:false});
  let submissions=0;
  const acceptWithoutAcknowledgement=async(symbol,quantity,entry,stop,tag)=>{
    submissions++;assert.equal(submissions,1);assert.equal(symbol,SYMBOL);
    const durable=store.get('bot_state_live'),intent=durable.intents[tag];
    assert.equal(intent.state,'submitting');assert.equal(intent.side,side);
    assert.deepEqual([intent.quantity,intent.entry,intent.stop],[quantity,entry,stop]);
    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
    assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous,2);
    assert.equal(process.listenerCount('SIGINT'),0);assert.equal(process.listenerCount('SIGTERM'),0);
    const account=acceptedAccount(intent);
    process.send({type:'accepted-without-acknowledgement',pid:process.pid,intent,account,submissions,
      wal_bytes:fs.statSync(filename+'-wal').size},error=>{if(error)process.exit(94);});
    return new Promise(()=>{});
  };
  engine.broker={buy_cover:acceptWithoutAcknowledgement,sell_cover:acceptWithoutAcknowledgement};
  await engine._enter_locked(TOKEN,entrySignal(side));
  clearTimeout(deadline);throw new Error('Crash fixture unexpectedly received an acknowledgement');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  childMain(process.argv[2],process.argv[3]).catch(error=>{console.error(error.message);process.exit(95);});
}
