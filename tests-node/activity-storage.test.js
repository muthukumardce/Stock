import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/storage.js';

test('clear activity persists its cursor, keeps order recovery and sessions, and never reuses event IDs',t=>{
  const dir=mkdtempSync(join(tmpdir(),'stock-activity-'));let store=new Store(join(dir,'test.sqlite3'));
  t.after(()=>{store.close();assert.ok(dir.startsWith(join(tmpdir(),'stock-activity-')));rmSync(dir,{recursive:true,force:true});});
  const journal={intents:{EB1:{state:'unknown',order_id:'123'}},positions:{TEST:{quantity:5}}};
  store.set('bot_state_live',journal);store.set('strategy_settings',{manage_existing_holdings:'ignore'});store.new_session('session','csrf',Date.now()/1000+60);
  store.event('order_intent','Protected order submitted');const last=store.event('order_unknown','Check the broker',{},'error');
  assert.deepEqual(store.clear_events(),{deleted:2,event_floor:last});
  assert.deepEqual(store.latest_events(),[]);assert.deepEqual(store.events(0),[]);
  assert.deepEqual(store.get('bot_state_live'),journal);assert.ok(store.session('session'));
  assert.deepEqual(store.get('strategy_settings'),{manage_existing_holdings:'ignore'});
  store.close();store=new Store(join(dir,'test.sqlite3'));assert.equal(store.event_floor(),last);
  assert.deepEqual(store.clear_events(),{deleted:0,event_floor:last});
  const next=store.event('paper_fill','New fill');assert.ok(next>last);assert.equal(store.events(last)[0].id,next);
});

test('saved legacy errors gain actionable help when read without storing raw diagnostic text',t=>{
  const store=new Store(':memory:',['synthetic-secret']);t.after(()=>store.close());
  store.event('order_rejected','Rejected synthetic-secret',{kind:'PermissionException',http_status:403,operation:'cover_entry'},'error');
  const event=store.latest_events()[0];assert.match(event.help.steps.join(' '),/Profile → IP Whitelist/);
  assert.equal(event.help.links[0].url,'https://developers.kite.trade/');assert.doesNotMatch(JSON.stringify(event),/synthetic-secret/);
});
