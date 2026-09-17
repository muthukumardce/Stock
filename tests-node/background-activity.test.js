import test from 'node:test';
import assert from 'node:assert/strict';
import {BackgroundActivity} from '../src/background-activity.js';
import {KiteBroker} from '../src/broker.js';

test('a retired history pass cannot overwrite a replacement pass or shutdown status',()=>{
  const monitor=new BackgroundActivity(()=>new Date('2026-09-17T10:00:00Z'));
  const old=monitor.begin('intraday_history',{message:'Downloading OLD.',current_item:'OLD',total:20});
  const next=monitor.begin('intraday_history',{message:'Downloading NEW.',current_item:'NEW',total:10});
  old({status:'failed',failed:1});
  assert.equal(monitor.snapshot().find(t=>t.id==='intraday_history').current_item,'NEW');
  next({status:'waiting',completed:3,message:'Waiting for retry.'});
  const task=monitor.snapshot().find(t=>t.id==='intraday_history');
  assert.equal(task.current_item,null);assert.equal(task.completed,3);assert.equal(task.total,10);
  task.completed=99;assert.equal(monitor.snapshot().find(t=>t.id==='intraday_history').completed,3);
  monitor.stop();next({status:'running',current_item:'NEW'});
  assert.equal(monitor.snapshot().find(t=>t.id==='intraday_history').status,'stopped');
});

test('account download progress identifies a pending read and does not count it before success',async()=>{
  const progress=[],reads=[];let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const broker={call:async key=>{reads.push(key);if(key==='holdings')await pending;return {};}};
  const task=KiteBroker.prototype.account.call(broker,step=>progress.push(step));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(reads,['margins','holdings']);
  assert.equal(progress.at(-1).phase,'holdings');assert.equal(progress.at(-1).completed,1);
  release();await task;
  assert.equal(progress.at(-1).completed,5);assert.equal(progress.at(-1).phase,'reconcile');
  assert.equal(JSON.stringify(progress).includes('access_token'),false);
});
