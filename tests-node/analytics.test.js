import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {AnalyticsPool, analyze_batch, technical_metrics} from '../src/analytics.js';
import {Candle,STRATEGY_VERSION,STRATEGY_FAMILIES} from '../src/strategy.js';

function records() {
  const at = new Date('2026-09-17T09:15:00+05:30');
  const bars = Array.from({length: 21}, (_, i) => new Candle(new Date(+at + 300_000 * i), 100, 101, 99, 100 + i / 100, 1000));
  return [{token: 123, strategy: 'intraday', bars, bar_time: bars.at(-1).time.toISOString(), queued_at: 1, generation: 0,analysis_id:17}];
}

test('CPU capacity counts all logical CPUs and workers start lazily', async () => {
  const pool = new AnalyticsPool(0, 4, 32, {logical_cpus: 192});
  assert.equal(pool.worker_limit, 188);
  assert.equal(pool.workers.size, 0);
  assert.equal(pool.snapshot().execution_workers, 1);
  await pool.close();
});

test('automatic workers honor usable CPU restrictions while reporting full hardware capacity',async()=>{
  const pool=new AnalyticsPool(0,4,32,{logical_cpus:192,available_cpus:16});
  assert.equal(pool.worker_limit,12);assert.equal(pool.snapshot().logical_cpus,192);assert.equal(pool.snapshot().capacity.available_cpus,16);await pool.close();
});

test('real worker thread roundtrip matches deterministic direct calculation', async () => {
  const pool = new AnalyticsPool(2);
  try {
    const batch = records();
    const results = await Promise.all([pool.analyze(batch), pool.analyze(batch), pool.analyze(batch)]);
    assert.deepEqual(results, Array(3).fill(analyze_batch(batch)));
    assert.equal(results[0][0].analysis_id,17);
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
  batch[0].bars.forEach((bar,i)=>{bar.time=new Date(Date.parse('2026-08-01T00:00:00+05:30')+i*86400000);});
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
  assert(Object.values(result).filter(value=>typeof value==='number').every(Number.isFinite));
  assert.equal(result.macd_histogram,null);assert.equal(result.adx14,null);assert.equal(result.data_valid,true);
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

test('worker propagates enhanced options, rejection evidence, catalogue and strategy version',async()=>{
  const batch=records(),first=batch[0].bars[0];
  batch[0].bars=Array.from({length:40},(_,i)=>new Candle(new Date(+first.time+i*300000),100,101,99,100,1000));
  batch[0].strategy_options={enhanced_signals:true,...Object.fromEntries(Object.values(STRATEGY_FAMILIES).map(key=>[key,false]))};
  const pool=new AnalyticsPool(1);
  try{
    const [result]=await pool.analyze(batch);assert.deepEqual(result,analyze_batch(batch)[0]);
    assert.equal(result.reason,'no_setups_enabled');assert.equal(result.explanation.mode,'enhanced');assert.equal(result.strategy_version,STRATEGY_VERSION);
    assert.equal(result.metrics.session_vwap_complete,true);assert(result.metrics.patterns.some(row=>row.id==='doji'));
    assert.equal(result.decision.exit,false);assert.equal(pool.snapshot().strategy_version,STRATEGY_VERSION);
  }finally{await pool.close();}
});
test('malformed candle data yields an explicit rejection without false holding diagnostics',()=>{
  const batch=records();batch[0].strategy='swing';batch[0].bars.at(-1).volume=NaN;
  const [result]=analyze_batch(batch);assert.equal(result.signal,null);assert.equal(result.reason,'invalid_bar_data');assert.equal(result.metrics.data_valid,false);assert.equal(result.holding,null);
});
test('a genuinely stalled worker times out and queued work completes on its replacement',async()=>{
  let created=0;
  const pool=new AnalyticsPool(1,4,32,{job_timeout_ms:250,workerFactory:(url,options)=>{
    created++;return new Worker(created===1?new URL('data:text/javascript,import%20%7BparentPort%7D%20from%20%22node%3Aworker_threads%22%3BparentPort.on(%22message%22%2C()%3D%3E%7B%7D)%3B'):url,options);
  }});
  try{
    const first=pool.analyze(records()),second=pool.analyze(records()),result=await Promise.allSettled([first,second]);
    assert.equal(result[0].status,'rejected');assert.match(result[0].reason.message,/timed out/);assert.equal(result[1].status,'fulfilled');
    assert.deepEqual(result[1].value,analyze_batch(records()));assert.equal(pool.active_jobs,0);assert.equal(created,2);
    assert([...pool.workers].every(slot=>slot.job_timer===null));
  }finally{await pool.close();}
});
test('actual workers enforce causal context timestamps and return separate long/short decisions',async()=>{
  const batch=records();batch[0].strategy_options={enhanced_signals:true};
  batch[0].context={as_of:new Date(+batch[0].bars.at(-1).time+299999)};
  const pool=new AnalyticsPool(1);
  try{
    const [result]=await pool.analyze(batch);assert.equal(result.reason,'unfinished_signal_candle');assert.equal(result.signal,null);
    assert.equal(result.metrics.data_valid,false);assert.equal(result.metrics.data_issue,'unfinished_signal_candle');
    assert.deepEqual(Object.keys(result.decisions_by_side),['BUY','SELL']);assert.equal(result.decisions_by_side.SELL.exit,false);
  }finally{await pool.close();}
});
