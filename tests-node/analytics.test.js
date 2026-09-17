import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AnalyticsPool, analyze_batch, technical_metrics} from '../src/analytics.js';
import {Candle} from '../src/strategy.js';

function records() {
  const at = new Date('2026-09-17T09:15:00+05:30');
  const bars = Array.from({length: 21}, (_, i) => new Candle(new Date(+at + 300_000 * i), 100, 101, 99, 100 + i / 100, 1000));
  return [{token: 123, strategy: 'intraday', bars, bar_time: bars.at(-1).time.toISOString(), queued_at: 1, generation: 0}];
}

test('CPU capacity counts all logical CPUs and workers start lazily', async () => {
  const pool = new AnalyticsPool(0, 4, 32, {logical_cpus: 192});
  assert.equal(pool.worker_limit, 188);
  assert.equal(pool.workers.size, 0);
  assert.equal(pool.snapshot().execution_workers, 1);
  await pool.close();
});

test('real worker thread roundtrip matches deterministic direct calculation', async () => {
  const pool = new AnalyticsPool(2);
  try {
    const batch = records();
    const results = await Promise.all([pool.analyze(batch), pool.analyze(batch), pool.analyze(batch)]);
    assert.deepEqual(results, Array(3).fill(analyze_batch(batch)));
    const metrics = pool.snapshot();
    assert.equal(metrics.completed_jobs, 3);
    assert.equal(metrics.completed_symbols, 3);
    assert.equal(metrics.active_jobs, 0);
    assert.equal(metrics.live_workers, 2);
  } finally { await pool.close(); }
  assert.equal(pool.workers.size, 0);
  await assert.rejects(pool.analyze(records()), /closed/);
});

test('analysis preserves generation for stale-result filtering and holding exit diagnostics', () => {
  const batch = records();
  Object.assign(batch[0], {strategy: 'swing', generation: 123});
  const result = analyze_batch(batch)[0];
  assert.equal(result.generation, 123);
  assert.equal(result.reason, 'warming_up_daily');
  assert.equal(result.holding.trend_exit, false);
  assert.equal(result.metrics.rsi14, 100);
  assert.equal(result.metrics.efficiency_ratio, 1);
  assert.equal(result.metrics.trend_r_squared, 1);
});

test('flat-series metrics are finite with a neutral RSI', () => {
  const bars = records()[0].bars;
  bars.forEach(bar => { bar.close = 100; });
  const result = technical_metrics(bars);
  assert.equal(result.rsi14, 50);
  assert.equal(result.efficiency_ratio, 0);
  assert.equal(result.return_volatility, 0);
  assert(Object.values(result).every(Number.isFinite));
});

test('malformed worker jobs reject without poisoning the pool', async () => {
  const pool = new AnalyticsPool(1);
  try {
    await assert.rejects(pool.analyze([{strategy: 'unknown'}]), /Unknown analysis strategy/);
    assert.deepEqual(await pool.analyze(records()), analyze_batch(records()));
    assert.equal(pool.active_jobs, 0);
    assert.equal(pool.completed_jobs, 1);
  } finally { await pool.close(); }
});

test('bounded backlog and close reject pending work predictably', async () => {
  const pool = new AnalyticsPool(1);
  const jobs = Array.from({length: 4}, () => pool.analyze(records()));
  const result = Promise.allSettled(jobs);
  await pool.close();
  const settled = await result;
  assert(settled.every(job => job.status === 'rejected'));
  assert.match(settled.at(-1).reason.message, /queue is full/);
  assert.equal(pool.active_jobs, 0);
});

test('a terminated worker rejects its job and queued work continues in a replacement', async () => {
  const pool = new AnalyticsPool(1);
  try {
    const interrupted = pool.analyze(records());
    const queued = pool.analyze(records());
    const settled = Promise.allSettled([interrupted, queued]);
    const [{worker}] = [...pool.workers];
    await worker.terminate();
    const results = await settled;
    assert.equal(results[0].status, 'rejected');
    assert.match(results[0].reason.message, /worker exited/);
    assert.equal(results[1].status, 'fulfilled');
    assert.deepEqual(results[1].value, analyze_batch(records()));
    assert.equal(pool.active_jobs, 0);
    assert.equal(pool.completed_jobs, 1);
  } finally { await pool.close(); }
});
