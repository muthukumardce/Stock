import test from 'node:test';
import assert from 'node:assert/strict';
import {validPreviousIntradaySeed} from '../src/intraday-seed.js';

const rows=(date='2026-09-21',length=72)=>Array.from({length},(_,i)=>({time:new Date(Date.parse(date+'T09:15:00+05:30')+i*300000),open:100,high:101,low:99,close:100,volume:1000}));

test('accepts observed regular-session and CAS-shaped indicator histories after rollout',()=>{
  assert.equal(validPreviousIntradaySeed(rows(), '2026-09-22'),true);
  assert.equal(validPreviousIntradaySeed(rows('2026-09-21',75),'2026-09-22'),true);
  assert.equal(validPreviousIntradaySeed(rows('2026-08-03'),'2026-08-04'),true);
  assert.equal(validPreviousIntradaySeed(rows('2026-07-31'),'2026-08-03'),false);
  assert.equal(validPreviousIntradaySeed(rows('2026-07-31',75),'2026-08-03'),true);
});

test('CAS-shaped history still rejects internal gaps, missing opening, stale, future and malformed data',()=>{
  const gap=rows();gap.splice(10,1);
  const malformed=rows();malformed[8].volume=-1;
  for(const data of [[],null,gap,malformed,rows().slice(1),rows().slice(0,-1),rows('2026-09-21',73),rows('2026-09-21',74),rows('2026-09-14'),rows('2026-09-22'),rows('2026-09-23')])
    assert.equal(validPreviousIntradaySeed(data,'2026-09-22'),false);
  assert.equal(validPreviousIntradaySeed(rows(),'invalid'),false);
});
