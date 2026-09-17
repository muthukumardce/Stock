import test from 'node:test';
import assert from 'node:assert/strict';
import { HoldingsAuthorization,authorizedQuantity } from '../src/holdings-authorization.js';

const NOW=new Date('2026-09-17T12:00:00+05:30');
class MemoryStore{
  data={};events=[];secrets=[];
  get(key,fallback){return structuredClone(this.data[key]??fallback);}
  set(key,value){this.data[key]=structuredClone(value);}
  event(...args){this.events.push(args);}
  add_secret(value){this.secrets.push(value);}
}
const holding=overrides=>({exchange:'NSE',product:'CNC',tradingsymbol:'TEST',isin:'INE002A01018',quantity:10,used_quantity:2,collateral_quantity:0,authorised_quantity:10,authorised_date:'2026-09-17 00:00:00',...overrides});
const profile={meta:{demat_consent:'consent'}};
function fixture(){const store=new MemoryStore();let at=new Date(NOW);const service=new HoldingsAuthorization(store,()=>at);return {store,service,advance:ms=>at=new Date(+at+ms)};}
test('authorization quantity is current-day, settled, unpledged and net of used shares',()=>{
  assert.equal(authorizedQuantity(holding(),NOW),8);
  assert.equal(authorizedQuantity(holding({authorised_quantity:5}),NOW),3);
  assert.equal(authorizedQuantity(holding({collateral_quantity:4}),NOW),4);
  for(const row of [{authorised_date:'2026-09-16'},{authorised_date:'2026-09-18'},{authorised_date:'bad'},{authorised_quantity:NaN},{used_quantity:-1},{discrepancy:true},{product:'MTF'},{quantity:0,t1_quantity:10}])assert.equal(authorizedQuantity(holding(row),NOW),0);
  assert.equal(authorizedQuantity(holding({authorised_date:'2026-02-30'}),new Date('2026-03-02T12:00:00+05:30')),0);
});
test('requirements persist across restart but clear only from fresh broker authorization or changed ownership',()=>{
  const {store,service}=fixture(),h=holding({authorised_quantity:0});
  service.require({symbol:'TEST',quantity:8,holding:h});service.require({symbol:'TEST',quantity:8,holding:h});assert.equal(store.events.length,1);
  const restored=new HoldingsAuthorization(store,()=>NOW);assert.equal(restored.snapshot().required,true);
  restored.reconcile([h],profile,new Set(['TEST']));assert.equal(restored.snapshot().required,true);
  restored.reconcile([holding()],profile,new Set(['TEST']));assert.equal(restored.snapshot().required,false);
  service.require({symbol:'TEST',quantity:8,holding:h});service.reconcile([h],profile,new Set());assert.equal(service.snapshot().required,false);
});
test('broker rejection cannot be cleared by polling stale permission fields or a callback hint',()=>{
  const {service}=fixture(),h=holding();service.require({symbol:'TEST',quantity:8,holding:h,broker_rejected:true});
  service.reconcile([h],profile,new Set(['TEST']));assert.equal(service.isBlocked('TEST'),true);
  service.require({symbol:'TEST',quantity:8,holding:h});assert.equal(service.isBlocked('TEST'),true);
  service.reconcile([holding({authorised_quantity:0})],profile,new Set(['TEST']),{userConfirmed:true});assert.equal(service.isBlocked('TEST'),true);
  service.reconcile([h],profile,new Set(['TEST']),{userConfirmed:true});assert.equal(service.snapshot().required,false);
});
test('official authorization request contains known holdings only, caches rapid duplicate clicks and exposes no OTP input',async()=>{
  const {service,store}=fixture(),h=holding({authorised_quantity:0});service.require({symbol:'TEST',quantity:8,holding:h});
  const calls=[],broker={call:async(...args)=>{calls.push(args);return {request_id:'private-request-id'};}};
  const result=await service.start(broker,'app-key',[h]);assert.equal(result.authorization_url,'https://kite.zerodha.com/connect/portfolio/authorise/holdings/app-key/private-request-id');
  assert.deepEqual(calls,[['authorise_holdings',{instruments:[{isin:h.isin,quantity:10}]}]]);
  assert.equal(result.authorization.required,true);assert.equal(result.authorization.status,'awaiting_user');
  await service.start(broker,'app-key',[h]);assert.equal(calls.length,1);
  assert.doesNotMatch(JSON.stringify(store.events),/private-request-id|app-key/);assert.ok(store.secrets.includes('private-request-id'));
  assert.equal(Object.hasOwn(service.snapshot(),'authorization_url'),false);
});

test('a broker rejection stays latched while managed exposure has no usable settled holding',()=>{
  const {service}=fixture(),h=holding();service.require({symbol:'TEST',quantity:8,holding:h,broker_rejected:true});
  for(const rows of [[],[holding({quantity:0})],[holding({used_quantity:10})],[holding({collateral_quantity:10})]]){
    service.reconcile(rows,profile,new Set(['TEST']));assert.equal(service.isBlocked('TEST'),true);
    service.reconcile(rows,profile,new Set(['TEST']),{userConfirmed:true});assert.equal(service.isBlocked('TEST'),true);
  }
  service.reconcile([],profile,new Set());assert.equal(service.snapshot().required,false);
});
test('fresh ownership changes cannot authorize a larger stale quantity',async()=>{
  const {service}=fixture(),h=holding({authorised_quantity:0});service.require({symbol:'TEST',quantity:8,holding:h});let calls=0;
  const broker={call:async()=>{calls++;return {request_id:'id'};}};
  await assert.rejects(service.start(broker,'key',[holding({quantity:3})]),/quantities could not be verified/);assert.equal(calls,0);
  service.reconcile([holding({quantity:3,authorised_quantity:0})],profile,new Set(['TEST']));
  assert.equal(service.snapshot().items[0].quantity,1);
});
test('authorization batches are bounded to 100 verified ISINs and remaining requirements stay visible',async()=>{
  const {service}=fixture(),holdings=[];
  for(let n=0;n<101;n++){const h=holding({tradingsymbol:'TEST'+n,isin:'INE'+String(n).padStart(9,'0'),authorised_quantity:0});holdings.push(h);service.require({symbol:h.tradingsymbol,quantity:8,holding:h});}
  let sent;const result=await service.start({call:async(_method,payload)=>{sent=payload.instruments;return {request_id:'id'};}},'key',holdings);
  assert.equal(sent.length,100);assert.equal(result.request_count,100);assert.equal(result.total_count,101);assert.equal(service.snapshot().items.length,101);
});
test('unknown permissions never imply a successful OTP; API failures can be retried explicitly',async()=>{
  const {service,advance}=fixture(),h=holding({authorised_quantity:0});service.require({symbol:'TEST',quantity:8,holding:h});
  let calls=0;const broker={call:async()=>{if(++calls===1)throw new Error('network');return {request_id:'next-id'};}};
  await assert.rejects(service.start(broker,'key',[h]),/Open Kite/);assert.equal(service.snapshot().status,'unavailable');
  await assert.rejects(service.start(broker,'key',[h]),/wait a few seconds/);assert.equal(calls,1);
  advance(6000);assert.match((await service.start(broker,'key',[h])).authorization_url,/next-id$/);assert.equal(service.snapshot().required,true);
});
