import test from 'node:test';
import assert from 'node:assert/strict';
import {entryRewardRisk} from '../src/entry-risk.js';

const long = {side:'BUY',entry:100,stop:98,target:104,fee_rate:.001,exit_slippage_rate:.0005};
const near = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);

test('long economics deduct both fill costs from reward and add them to stop risk',()=>{
  const result=entryRewardRisk(long);
  near(result.target_exit,103.948); near(result.stop_exit,97.951);
  near(result.reward_per_share,3.744052); near(result.risk_per_share,2.246951);
  near(result.reward_risk,3.744052/2.246951); assert.equal(result.ok,true);
  assert.equal(result.entry,100,'Entry is already executable; no second entry slippage charge');
});

test('short economics buy back with adverse slippage and charge costs on both fills',()=>{
  const result=entryRewardRisk({...long,side:'SELL',stop:102,target:96});
  near(result.target_exit,96.048); near(result.stop_exit,102.051);
  near(result.reward_per_share,3.755952); near(result.risk_per_share,2.253051);
  near(result.reward_risk,3.755952/2.253051); assert.equal(result.ok,true);
});

test('the minimum is inclusive and adverse entry movement rejects both directions',()=>{
  for(const side of ['BUY','SELL']){
    const sign=side==='BUY'?1:-1,inputs={...long,side,stop:100-sign*2,target:100+sign*3,fee_rate:0,exit_slippage_rate:0};
    assert.equal(entryRewardRisk(inputs).ok,true);
    assert.equal(entryRewardRisk({...inputs,entry:100+sign*.01}).reason,'entry_reward_risk_too_low');
    assert.equal(entryRewardRisk({...inputs,min_reward_risk:2}).ok,false);
  }
});

test('a positive gross target with no profit left after costs cannot authorize entry',()=>{
  const result=entryRewardRisk({...long,target:100.1});
  assert.ok(result.reward_per_share<0); assert.equal(result.ok,false);
  assert.equal(result.reason,'entry_reward_risk_too_low');
});

test('malformed prices, directions, cost assumptions and thresholds fail closed',()=>{
  for(const change of [{side:'HOLD'},{entry:NaN},{entry:'100'},{stop:Infinity},{target:0},{stop:101},
    {target:99},{fee_rate:-.01},{fee_rate:Infinity},{exit_slippage_rate:NaN},{exit_slippage_rate:.06},
    {min_reward_risk:0},{min_reward_risk:null},{min_reward_risk:NaN},{min_reward_risk:11}]){
    const result=entryRewardRisk({...long,...change});
    assert.equal(result.ok,false);assert.equal(result.reason,'invalid_entry_economics');
  }
});
