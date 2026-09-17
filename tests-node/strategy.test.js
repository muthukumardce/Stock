import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Candle, CandleBook, Signal, atr, intraday_signal, swing_signal, position_size} from '../src/strategy.js';

function intradayBars() {
  const start = new Date('2026-09-17T09:15:00+05:30');
  const bars = Array.from({length: 20}, (_, i) => new Candle(new Date(+start + 300_000 * i),
    100 + i * 0.05, 100.3 + i * 0.05, 99.9 + i * 0.05, 100.2 + i * 0.05, 1000));
  bars.push(new Candle(new Date(+start + 6_000_000), 101, 101.8, 100.95, 101.75, 2500));
  return bars;
}

test('intraday breakout requires contiguous candles, relative volume and a strong close', () => {
  const bars = intradayBars();
  const [signal, reason] = intraday_signal(bars);
  assert.equal(reason, 'candidate');
  assert(signal.stop < signal.reference && signal.reference < signal.target);
  assert.equal(signal.strategy, 'intraday');
  assert.equal(signal.score, 2.5);
  assert.equal(intraday_signal(bars.slice(1))[1], 'warming_up');
  bars.at(-1).volume = 500;
  assert.equal(intraday_signal(bars)[1], 'insufficient_relative_volume');
  bars.at(-1).time = new Date(+bars.at(-1).time + 300_000);
  assert.equal(intraday_signal(bars)[1], 'candle_gap');
});

test('first partial candle never counts, gaps invalidate history and deltas accumulate', () => {
  const book = new CandleBook();
  book.update('2026-09-17 09:17:00', 100, 10000);
  book.update('2026-09-17 09:19:45', 101, 11000);
  assert.equal(book.update('2026-09-17 09:20:00', 102, 11500), null);
  book.update('2026-09-17 09:24:45', 103, 12500);
  const closed = book.update('2026-09-17 09:25:00', 104, 13000);
  assert.equal(closed.volume, 1500);
  assert.equal(closed.time.toISOString(), '2026-09-17T03:50:00.000Z');
  assert.equal(book.bars.length, 1);
  book.update('2026-09-17 09:35:00', 105, 14000);
  assert.equal(book.bars.length, 0);
});

test('invalid, out-of-order and no-trade ticks cannot contaminate candle prices', () => {
  const book = new CandleBook();
  book.update('2026-09-17 09:20:00', 100, 1000);
  const initial = structuredClone(book.current);
  book.update('2026-09-17 09:20:01', 999, 1000);
  assert.equal(book.current.close, initial.close);
  book.update('2026-09-17 09:19:00', 999, 900);
  book.update('2026-09-17 09:20:02', NaN, 2000);
  book.update('bad time', 100, 2000);
  assert.deepEqual({...book.current}, initial);
  book.update('2026-09-18 09:15:00', 101, 100);
  assert.equal(book.current.volume, 0);
  assert.equal(book.complete, false);
});

test('late boundary arrival excludes a candle rather than inventing completeness', () => {
  const book = new CandleBook();
  book.update('2026-09-17 09:15:00', 100, 1000);
  book.update('2026-09-17 09:19:50', 100, 2000);
  book.update('2026-09-17 09:20:45', 100, 2100);
  book.update('2026-09-17 09:24:50', 100, 3000);
  assert.equal(book.update('2026-09-17 09:25:00', 100, 3100), null);
  assert.equal(book.bars.length, 0);
});

test('position sizing respects cash, capital, risk and two-sided fee allowance', () => {
  assert.equal(position_size(100000, 1000, 100, 98, 0.0025, 0.1), 9);
  assert.equal(position_size(100000, 100000, 100, 100, 0.0025, 0.1), 0);
  assert.equal(position_size(100000, 100000, NaN, 95, 0.0025, 0.1), 0);
  assert.equal(position_size(100000, 100000, 100, 98, 0.0002, 0.1), 9);
  assert.equal(position_size(100000, 100000, 100, 98, 0.01, 0.001), 0);
});

test('swing uses completed long history and rejects split-like discontinuities', () => {
  const start = new Date('2026-01-01T00:00:00+05:30');
  const bars = Array.from({length: 54}, (_, i) => new Candle(new Date(+start + i * 86400000),
    100 + i * 0.1, 100.4 + i * 0.1, 99.8 + i * 0.1, 100.3 + i * 0.1, 1000));
  bars.push(new Candle(new Date(+start + 54 * 86400000), 105.2, 106.6, 105, 106.5, 2500));
  assert.equal(swing_signal(bars)[0].strategy, 'swing');
  assert.equal(swing_signal(bars.slice(0, 20))[1], 'warming_up_daily');
  bars[25].open = 50;
  assert.equal(swing_signal(bars)[1], 'daily_discontinuity');
});

test('ATR includes gaps and signal object constructor preserves all fields', () => {
  const bars = [new Candle('2026-01-01', 100, 101, 99, 100, 1000),
    new Candle('2026-01-02', 110, 111, 109, 110, 1000)];
  assert.equal(atr(bars, 1), 11);
  assert.equal(atr(bars), 0);
  const data = {strategy: 'swing', reference: 110, stop: 100, target: 135, score: 3, reason: 'test'};
  assert.deepEqual({...new Signal(data)}, data);
  assert.equal(bars[0].time.toISOString(), '2025-12-31T18:30:00.000Z');
});
