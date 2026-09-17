import test from 'node:test';
import assert from 'node:assert/strict';
import {PATTERN_CATALOGUE,detect_patterns} from '../src/patterns.js';
const bar=(open,high,low,close)=>({open,high,low,close,volume:100});
const down=[bar(111,112,109,110),bar(109,110,107,108),bar(107,108,105,106)];
const ids=bars=>detect_patterns(bars).map(row=>row.id);
const mirror=rows=>rows.map(row=>bar(220-row.open,220-row.low,220-row.high,220-row.close));
test('catalogue explicitly defines 42 unique formations and heuristic metadata',()=>{
  assert.equal(PATTERN_CATALOGUE.length,42);assert.equal(new Set(PATTERN_CATALOGUE.map(row=>row.id)).size,42);
  assert(PATTERN_CATALOGUE.every(row=>row.definition&&['bullish','bearish','neutral'].includes(row.direction)&&row.bars>=1));
});
test('identical long-shadow geometry changes interpretation with prior trend',()=>{
  const hammer=bar(104,105.1,100,105);
  assert(ids([...down,hammer]).includes('hammer'));assert(!ids([hammer]).includes('hammer'));
  const up=mirror(down);assert(ids([...up,hammer]).includes('hanging_man'));assert(!ids([...up,hammer]).includes('hammer'));
  assert(ids(mirror([...down,hammer])).includes('shooting_star'));
});
test('engulfing requires opposite body containment and prior reversal context',()=>{
  const formation=[...down,bar(104,104.2,101.8,102),bar(101.9,104.2,101.5,104.1)];
  assert(ids(formation).includes('bullish_engulfing'));assert(ids(mirror(formation)).includes('bearish_engulfing'));
  assert(!ids(formation.slice(-2)).includes('bullish_engulfing'));
  assert(!ids([...down,formation.at(-2),bar(102.5,104.2,102.4,104.1)]).includes('bullish_engulfing'));
});
test('star and three-candle continuation confirmation use completed geometry',()=>{
  const star=[...down,bar(104,104.2,99.8,100),bar(99,99.3,98.7,99.02),bar(99.5,103.2,99.4,103)];
  assert(ids(star).includes('morning_doji_star'));assert(ids(mirror(star)).includes('evening_doji_star'));
  assert(!ids(star.slice(0,-1)).includes('morning_star'));
  const soldiers=[...down,bar(103,105.1,102.9,105),bar(104,106.1,103.9,106),bar(105,107.1,104.9,107)];
  assert(ids(soldiers).includes('three_white_soldiers'));assert(ids(mirror(soldiers)).includes('three_black_crows'));
});
test('inside bars and doji are neutral; malformed and zero-range candles give no directional signal',()=>{
  const inside=[bar(100,103,97,102),bar(101,102,99,101)];
  const found=detect_patterns(inside);assert(found.some(row=>row.id==='inside_bar'));assert(found.every(row=>row.direction==='neutral'));
  assert.deepEqual(detect_patterns([bar(100,99,98,100)]),[]);assert.deepEqual(detect_patterns([bar(100,100,100,100)]),[]);assert.deepEqual(detect_patterns([]),[]);
});
