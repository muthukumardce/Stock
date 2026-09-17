import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_COMPARISON_RUNTIME_MS,MAX_RESEARCH_RUNTIME_MS,runBacktest, compareStrategies, parseDataset } from '../src/backtest.js';
import { ResearchService } from '../src/research.js';
import { Candle, intraday_signal, swing_signal, daily_holding_exit } from '../src/strategy.js';

const zeroCosts = { fee_rate: 0, slippage_rate: 0 };
const breakoutOnly = { enhanced_signals:true, enable_breakout:true, enable_pullback:false, enable_reversion:false,
  enable_opening_range:false, enable_opening_drive:false, enable_gap_continuation:false, enable_gap_reversal:false,
  enable_vwap_reclaim:false, enable_vwap_rejection:false, enable_volatility_squeeze:false, enable_relative_strength:false,
  higher_timeframe_filter:false };
function session(date = '2026-09-14', changes = {}) {
  const start = +new Date(date + 'T09:15:00+05:30');
  return Array.from({ length: 75 }, (_, i) => {
    const price = i < 20 ? 100 : 100.6;
    const row = i === 20 ? { open: 100.1, high: 100.6, low: 100.1, close: 100.6, volume: 3000 }
      : { open: price, high: price + 0.1, low: price - 0.1, close: price, volume: 1000 };
    return { time: new Date(start + i * 300000).toISOString(), ...row, ...(changes[i] ?? {}) };
  });
}
function dataset(rows = session(), symbols = ['INFY']) { return { interval: '5minute', symbols: Object.fromEntries(symbols.map(s => [s, structuredClone(rows)])) }; }

function enhancedBreakoutSession({short=false,technical=false}={}) {
  const start = +new Date('2026-09-17T09:15:00+05:30'), bars = [];
  for (let i = 0; i < 34; i++) {
    const close = 100 + i * .02 + Math.sin(i * .8) * .2, open = bars.at(-1)?.close ?? close - .1;
    bars.push(new Candle(new Date(start + i * 300000), open, Math.max(open, close) + .05, Math.min(open, close) - .05, close, 1000));
  }
  const previous = bars.at(-2), high = Math.max(...bars.slice(-21,-1).map(b=>b.high));
  Object.assign(bars.at(-1),{open:previous.close-.02,close:high+.2,high:high+.22,low:previous.close-.04,volume:4000});
  const reference=bars.at(-1).close;
  for (let i=34;i<75;i++) {
    const close=reference+(technical?(i<=44?(i-33)*.02:.22-(i-44)*.015):0),open=bars.at(-1).close;
    bars.push(new Candle(new Date(start+i*300000),open,Math.max(open,close)+.01,Math.min(open,close)-.01,close,1000));
  }
  return short?bars.map(b=>new Candle(b.time,200-b.open,200-b.low,200-b.high,200-b.close,b.volume)):bars;
}

test('closed-bar signal enters at next candle open and closes intraday on schedule', () => {
  const bars = session('2026-09-14', { 21: { open: 100.8, high: 100.9, low: 100.5, close: 100.6 } });
  const result = runBacktest(dataset(bars), zeroCosts);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.signal_time, bars[21].time); assert.equal(trade.entry_time, bars[21].time);
  assert.equal(trade.entry, 100.8); assert.equal(trade.reason, 'intraday_scheduled_close');
  assert.equal(trade.exit_time, new Date('2026-09-14T15:10:00+05:30').toISOString());
  assert.equal(result.open_positions.length, 0);
});

test('future close cannot affect an earlier entry decision or size', () => {
  const a = dataset(), b = structuredClone(a);
  b.symbols.INFY[30] = { ...b.symbols.INFY[30], open: 100.9, high: 102, low: 100.8, close: 101.9 };
  const first = runBacktest(a, zeroCosts).trades[0], second = runBacktest(b, zeroCosts).trades[0];
  for (const field of ['entry_time', 'entry', 'quantity', 'signal_time', 'score']) assert.equal(first[field], second[field]);
});

test('stop precedes target when a single candle touches both', () => {
  const result = runBacktest(dataset(session('2026-09-14', { 22: { open: 100.6, low: 99, high: 103, close: 101 } })), zeroCosts);
  assert.equal(result.trades[0].reason, 'stop_before_target_ambiguous_bar');
  assert.ok(result.trades[0].pnl < 0);
});

test('a stop gapping below its boundary fills at the worse open', () => {
  const result = runBacktest(dataset(session('2026-09-14', { 22: { open: 98, low: 97.5, high: 98.5, close: 98 } })), zeroCosts);
  assert.equal(result.trades[0].reason, 'stop_gap'); assert.equal(result.trades[0].exit, 98);
});

test('costs are charged on both fills and slippage is adverse', () => {
  const clean = runBacktest(dataset(), zeroCosts), costly = runBacktest(dataset(), { fee_rate: .001, slippage_rate: .0005 });
  const t = costly.trades[0];
  assert.ok(t.entry > clean.trades[0].entry); assert.ok(t.exit < clean.trades[0].exit);
  assert.ok(t.entry_fee > 0 && t.exit_fee > 0);
  assert.ok(Math.abs(t.pnl - ((t.exit - t.entry) * t.quantity - t.entry_fee - t.exit_fee)) < 1e-5);
  assert.ok(costly.metrics.net_pnl < clean.metrics.net_pnl);
  assert.ok(Math.abs(costly.metrics.costs_paid - t.entry_fee - t.exit_fee) < 1e-5);
});

test('one bankroll is shared by simultaneous symbol candidates with deterministic tie breaks', () => {
  const result = runBacktest(dataset(session(), ['TCS', 'INFY']), { ...zeroCosts, initial_capital: 1000, max_position_pct: 1, risk_per_trade_pct: 1, max_positions: 10 });
  assert.equal(result.trades.length, 1); assert.equal(result.trades[0].symbol, 'INFY');
  assert.ok(result.equity.every(p => p.cash >= -1e-8));
  const reversed = dataset(session(), ['INFY', 'TCS']);
  assert.deepEqual(result, runBacktest(reversed, { ...zeroCosts, initial_capital: 1000, max_position_pct: 1, risk_per_trade_pct: 1, max_positions: 10 }));
});

test('simultaneous candidates rank by their actual signal score before allocating scarce cash', () => {
  const data = dataset(session(), ['INFY', 'TCS']); data.symbols.TCS[20].volume = 8000;
  const result = runBacktest(data, { ...zeroCosts, initial_capital: 1000, max_position_pct: 1, risk_per_trade_pct: 1, max_positions: 1 });
  assert.equal(result.trades.length, 1); assert.equal(result.trades[0].symbol, 'TCS');
});

test('an unobserved intraday exit preserves the earlier entry and resolves only at the next observed opening', () => {
  const rows = [...session('2026-09-14').slice(0, 40), ...session('2026-09-15')];
  const result = runBacktest(dataset(rows), zeroCosts);
  assert.equal(result.dataset.excluded_intraday_symbol_sessions, 0);
  assert.equal(result.trades[0].entry_time, session('2026-09-14')[21].time);
  assert.equal(result.trades[0].exit_time, session('2026-09-15')[0].time);
  assert.equal(result.trades[0].reason, 'stop_gap');
  assert.equal(result.trades[0].exit, session('2026-09-15')[0].open);
  assert.equal(result.trades[0].data_gap, true);
  assert.equal(result.data_quality.gap_count, 1);
  assert.ok(result.caveats.some(v => v.includes('no session was excluded using future candle availability')));
});

test('later missing candles cannot erase an earlier entry and close only at an observed opening', () => {
  const rows = session(); rows.splice(35, 1);
  const result = runBacktest(dataset(rows), zeroCosts);
  const reference = runBacktest(dataset(), zeroCosts).trades[0];
  assert.equal(result.trades.length, 1); assert.equal(result.open_positions.length, 0);
  assert.equal(result.trades[0].entry_time, reference.entry_time); assert.equal(result.trades[0].quantity, reference.quantity);
  assert.equal(result.trades[0].exit_time, session()[36].time); assert.equal(result.trades[0].exit, session()[36].open);
  assert.equal(result.trades[0].reason, 'intraday_data_gap_exit'); assert.equal(result.trades[0].data_gap, true);
});

test('missing candles known before a candidate block later entries in that symbol-session', () => {
  const rows = session(); rows.splice(5, 1);
  const result = runBacktest(dataset(rows), zeroCosts);
  assert.equal(result.trades.length, 0); assert.equal(result.open_positions.length, 0);
  assert.equal(result.data_quality.affected_symbol_sessions, 1);
  assert.ok(result.decisions.entries_blocked_after_data_gap > 0);
});

test('ending data before an intraday exit leaves marked unresolved exposure without a fabricated fill', () => {
  const rows = session().slice(0,40), result = runBacktest(dataset(rows), zeroCosts);
  assert.equal(result.trades.length, 0); assert.equal(result.open_positions.length, 1);
  assert.equal(result.open_positions[0].status, 'unresolved_missing_exit');
  assert.equal(result.open_positions[0].last, rows.at(-1).close);
  assert.equal(result.data_quality.completed_result, false);
  assert.deepEqual(result.data_quality.unresolved_intraday_positions, ['INFY']);
  assert.equal(result.data_quality.gaps[0].observed_at, null);
});

test('chronological session splits use shared capital and attribute closes by exit session', () => {
  const rows = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'].flatMap(d => session(d));
  const result = runBacktest(dataset(rows));
  assert.deepEqual(result.period_metrics.map(p => p.name), ['train', 'validation', 'test']);
  assert.deepEqual(result.period_metrics.map(p => p.session_count), [3, 1, 1]);
  assert.ok(result.period_metrics[0].to < result.period_metrics[1].from);
  assert.ok(result.period_metrics[1].to < result.period_metrics[2].from);
  assert.ok(Math.abs(result.period_metrics.reduce((n, p) => n + p.metrics.net_pnl, 0) - result.metrics.net_pnl) < 1e-5);
  assert.equal(result.period_metrics.reduce((n, p) => n + p.metrics.trade_count, 0), result.metrics.trade_count);
});

test('input is unmodified and repeat runs are exactly deterministic', () => {
  const input = dataset(), before = structuredClone(input), options = { ...zeroCosts, strategy_options: { enhanced_signals: false } };
  const first = runBacktest(input, options), second = runBacktest(input, options);
  assert.deepEqual(input, before); assert.deepEqual(first, second); assert.doesNotThrow(() => JSON.stringify(first));
});

test('comparison fixes identical dataset and cost assumptions with no automatic selection', () => {
  const input = dataset(), report = compareStrategies(input, { ...zeroCosts, enhanced_options: { min_signal_score: 70 } });
  assert.deepEqual(report.baseline.dataset, report.enhanced.dataset);
  assert.equal(report.baseline.options.initial_capital, report.enhanced.options.initial_capital);
  assert.equal(report.baseline.options.fee_rate, report.enhanced.options.fee_rate);
  assert.equal(report.baseline.options.strategy_options.enhanced_signals, false);
  assert.equal(report.enhanced.options.strategy_options.enhanced_signals, true);
  assert.equal(report.comparison.net_pnl, report.enhanced.metrics.net_pnl - report.baseline.metrics.net_pnl);
  assert.equal(Object.hasOwn(report, 'promote'), false);
});

for (const [name, mutate] of [
  ['nonfinite price', d => d.symbols.INFY[5].close = Infinity],
  ['negative volume', d => d.symbols.INFY[5].volume = -1],
  ['inverted range', d => d.symbols.INFY[5].low = 200],
  ['duplicate time', d => d.symbols.INFY[5].time = d.symbols.INFY[4].time],
  ['invalid time', d => d.symbols.INFY[5].time = 'not a timestamp'],
  ['invalid calendar date', d => d.symbols.INFY[5].time = '2026-02-30T09:40:00+05:30'],
  ['invalid interval', d => d.interval = 'tick'],
  ['string price', d => d.symbols.INFY[5].open = '100'],
]) test(`malformed dataset rejects ${name} before research`, () => {
  const input = dataset(); mutate(input); assert.throws(() => runBacktest(input));
});

test('resource, cost and split configuration are bounded', () => {
  assert.throws(() => runBacktest(dataset(), { max_bars: 10 }), /bar limit/);
  assert.throws(() => runBacktest(dataset(), { max_bars: 1000001 }));
  assert.throws(() => runBacktest(dataset(), { fee_rate: -1 }));
  assert.throws(() => runBacktest(dataset(), { initial_capital: NaN }));
  assert.throws(() => runBacktest(dataset(), { split_fractions: [.6, .3, .2] }));
  assert.throws(() => runBacktest(dataset(), { exit_time: '15:61' }));
  assert.throws(() => runBacktest(dataset(), {}, { cancelled: () => true }), /cancelled/);
});

test('CPU research worker produces an isolated report and progress', async t => {
  const service = new ResearchService(); t.after(() => service.close());
  const input = dataset(); const job = service.start(input, zeroCosts);
  input.symbols.INFY[20].volume = 0;
  assert.equal(job.status, 'running'); assert.throws(() => service.start(dataset()), /already running/);
  const done = await service.wait();
  assert.equal(done.status, 'complete'); assert.equal(done.progress, 1);
  assert.equal(done.result.baseline.trades.length, 1);
  done.result.baseline.trades.length = 0;
  assert.equal(service.status().result.baseline.trades.length, 1);
});

test('worker cancellation stops research without creating a report or any live account action', async () => {
  const service = new ResearchService(); service.start(dataset());
  const waiting = service.wait(); const cancelled = await service.cancel();
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.result, null);
  assert.equal((await waiting).status, 'cancelled'); assert.equal(service.worker, null);
  await service.close();
});

test('research timing is unaffected by a forward operating-system clock correction',()=>{
  const original=Date.now;let jumps=0;
  try {
    Date.now=()=>original()+600000*++jumps;
    const report=runBacktest(dataset(),zeroCosts);
    assert.equal(report.dataset.bar_count,75);assert.equal(report.data_quality.completed_result,true);
  } finally {Date.now=original;}
});

test('worker budget scales for a large sample, remains bounded and still supports cancellation',async t=>{
  const service=new ResearchService();t.after(()=>service.close());
  assert.throws(()=>service.start(dataset(),{max_runtime_ms:1800001}),/Maximum runtime/);
  assert.throws(()=>service.start(dataset(),{max_runtime_ms:0}),/Maximum runtime/);
  const input=dataset(session(),Array.from({length:610},(_,i)=>'STOCK'+i));
  const started=service.start(input);
  assert.ok(started.runtime_budget_ms>60000);assert.ok(started.runtime_budget_ms<=MAX_COMPARISON_RUNTIME_MS);
  const stopped=await service.cancel();assert.equal(stopped.status,'cancelled');assert.equal(stopped.result,null);
});

test('comparison announces each real phase before its first candles without pretending normalization has completed',()=>{
  const progress=[];compareStrategies(dataset(),zeroCosts,{onProgress:value=>progress.push(value)});
  assert.deepEqual(progress[0],{phase:'baseline',progress:0,processed_bars:0});
  const enhancedStart=progress.findIndex(value=>value.phase==='enhanced');
  assert.ok(enhancedStart>0);assert.equal(progress[enhancedStart-1].processed_bars,75);
  assert.deepEqual(progress[enhancedStart],{phase:'enhanced',progress:.5,processed_bars:0});
  assert.equal(progress.at(-1).progress,1);assert.equal(progress.at(-1).processed_bars,75);
});

test('runtime exhaustion carries exact variant, elapsed time and processed candles without returning a partial comparison',t=>{
  let clock=0,phase='';const progress=[];
  t.mock.method(performance,'now',()=>clock);
  assert.throws(()=>compareStrategies(dataset(),{...zeroCosts,max_runtime_ms:100},{
    onProgress:value=>{phase=value.phase;progress.push(value);},
    cancelled:()=>{if(phase==='enhanced')clock=101;return false;},
  }),error=>{
    assert.equal(error.code,'worker_timeout');assert.equal(error.phase,'enhanced');assert.equal(error.runtime_budget_ms,100);
    assert.equal(error.elapsed_ms,101);assert.equal(error.processed_bars,1);assert.equal(error.total_bars,75);
    assert.equal(error.message,'Backtest runtime limit exceeded; use a smaller dataset');return true;
  });
  assert.equal(progress.at(-1).phase,'enhanced');assert.equal(progress.at(-1).processed_bars,0);
});

test('explicit comparison limits allow up to thirty minutes while the optimizer candidate constant remains ten minutes',()=>{
  assert.equal(MAX_COMPARISON_RUNTIME_MS,1800000);assert.equal(MAX_RESEARCH_RUNTIME_MS,600000);
  assert.equal(runBacktest(dataset(),{max_runtime_ms:1800000}).options.max_runtime_ms,1800000);
  assert.throws(()=>runBacktest(dataset(),{max_runtime_ms:1800001}),/Maximum runtime/);
});

test('worker reports validation failure without crashing its caller', async t => {
  const service = new ResearchService(); t.after(() => service.close());
  const input = dataset(); input.symbols.INFY[0].high = 1;
  service.start(input);
  const done = await service.wait(); assert.equal(done.status, 'failed'); assert.match(done.error, /OHLCV/); assert.equal(done.result, null);
});

function dailyDataset(count = 57) {
  const dates = []; let date = new Date('2026-06-01T00:00:00Z');
  while (dates.length < count) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
    date = new Date(+date + 86400000);
  }
  return { interval: 'day', symbols: { INFY: dates.map((time, i) => {
    const close = i < 54 ? 100 + i * .1 : 106 + (i - 54) * .1;
    return { time, open: close - .1, high: close + .05, low: close - .2, close, volume: i === 54 ? 3000 : 1000 };
  }) } };
}

test('swing signal uses completed daily history and enters on the following session', () => {
  const data = dailyDataset(), report = runBacktest(data, zeroCosts);
  assert.equal(report.strategy, 'swing'); assert.equal(report.trades.length, 0); assert.equal(report.open_positions.length, 1);
  const p = report.open_positions[0];
  assert.equal(p.signal_time, new Date(data.symbols.INFY[54].time + 'T15:30:00+05:30').toISOString());
  assert.equal(p.entry_time, new Date(data.symbols.INFY[55].time + 'T09:15:00+05:30').toISOString());
  assert.equal(p.entry, data.symbols.INFY[55].open);
  assert.equal(report.metrics.open_positions, 1);
  assert.ok(report.caveats.some(c => c.includes('not given an invented liquidation fill')));
});

test('swing opening gap below an already-known daily trail cannot create immediately exit-bound exposure',()=>{
  const data=dailyDataset(56),bars=data.symbols.INFY,prefix=bars.slice(0,55).map(bar=>new Candle(bar.time,bar.open,bar.high,bar.low,bar.close,bar.volume));
  const [signal]=swing_signal(prefix),daily=daily_holding_exit(prefix,signal);
  assert(signal);assert.equal(daily.trend_exit,false);assert(daily.trailing_stop>signal.stop);
  const entry=(signal.stop+daily.trailing_stop)/2;
  Object.assign(bars[55],{open:entry,high:entry+.05,low:entry-.05,close:entry});
  const report=runBacktest(data,zeroCosts);
  assert.equal(report.decisions.daily_trailing_exit_active,1);
  assert.equal(report.trades.length,0);assert.equal(report.open_positions.length,0);
  assert.equal(report.metrics.net_pnl,0);
});

test('swing reversion with a pre-entry daily trend exit cannot earn a fictitious extra overnight return',()=>{
  const start=Date.parse('2026-01-01T09:15:00+05:30');
  const bars=Array.from({length:55},(_,i)=>{
    const close=100+Math.sin(i*2)*.6,open=i?100+Math.sin((i-1)*2)*.6:99.9;
    return new Candle(new Date(start+i*86400000),open,Math.max(open,close)+.05,Math.min(open,close)-.05,close,1000);
  });
  Object.assign(bars.at(-3),{open:100,high:100.1,low:97.9,close:98});
  Object.assign(bars.at(-2),{open:97.4,high:97.5,low:96.9,close:97});
  Object.assign(bars.at(-1),{open:96.95,high:97.85,low:96.9,close:97.8,volume:3000});
  assert.equal(daily_holding_exit(bars).trend_exit,true);
  bars.push(new Candle(new Date(start+55*86400000),98.5,98.6,98.4,98.5,1000));
  bars.push(new Candle(new Date(start+56*86400000),99,99.1,98.9,99,1000));
  const report=runBacktest({interval:'day',symbols:{TEST:bars}},{...zeroCosts,strategy_options:{...breakoutOnly,enable_breakout:false,enable_reversion:true}});
  assert.equal(report.trades.length,0);assert.equal(report.open_positions.length,0);assert.equal(report.metrics.net_pnl,0);
});

test('swing overnight gap losses are counted at the next actual opening price', () => {
  const data = dailyDataset();
  Object.assign(data.symbols.INFY[56], { open: 95, high: 96, low: 94, close: 95 });
  const report = runBacktest(data, zeroCosts);
  assert.equal(report.trades.length, 1); assert.equal(report.trades[0].reason, 'stop_gap'); assert.equal(report.trades[0].exit, 95);
  assert.ok(report.metrics.max_drawdown_pct > 0); assert.ok(report.metrics.net_pnl < 0); assert.equal(report.metrics.open_positions, 0);
});

test('a final closed-bar signal never invents a next session entry', () => {
  const report = runBacktest(dailyDataset(55), zeroCosts);
  assert.equal(report.trades.length, 0); assert.equal(report.open_positions.length, 0);
  assert.equal(report.metrics.ending_equity, report.metrics.initial_capital);
});

test('nonaligned exit minute uses the next candle close and discloses its granularity', () => {
  const result = runBacktest(dataset(), { ...zeroCosts, exit_time: '15:12' });
  assert.equal(result.trades[0].exit_time, new Date('2026-09-14T15:15:00+05:30').toISOString());
  assert.ok(result.caveats.some(c => c.includes('less than five minutes')));
  const missingClose = session(); missingClose.splice(71, 1);
  const interrupted = runBacktest(dataset(missingClose), { ...zeroCosts, exit_time: '15:12' });
  assert.equal(interrupted.trades[0].exit_time, session()[72].time);
  assert.equal(interrupted.trades[0].reason, 'intraday_data_gap_exit');
});

test('shared enhanced technical exit executes at the next opening without a fictitious same-bar fill', () => {
  const bars=enhancedBreakoutSession({technical:true}), strategy_options=breakoutOnly,
    [signal] = intraday_signal(bars.slice(0,34),strategy_options);
  assert.ok(signal, 'Fixture must trigger the shared enhanced breakout rule');
  const report = runBacktest(dataset(bars), { ...zeroCosts, strategy_options });
  assert.equal(report.trades.length, 1);
  const trade = report.trades[0];
  assert.equal(trade.reason, 'technical_trend_failure');
  assert.equal(trade.exit_time, bars[62].time.toISOString());
  assert.ok(Math.abs(trade.exit - bars[62].open) < 1e-8);
  assert.ok(bars.slice(34, 63).every(b => b.low > signal.stop && b.high < signal.target));
});

test('offline JSON and quoted CSV imports validate the same chronological OHLCV data', () => {
  const original = dataset(), fromJson = parseDataset(JSON.stringify(original));
  assert.deepEqual(runBacktest(fromJson,zeroCosts).trades,runBacktest(original,zeroCosts).trades);
  const csv = '\uFEFFsymbol,time,open,high,low,close,volume\r\n' + original.symbols.INFY.map(row =>
    ['"INFY"', '"' + row.time + '"', row.open,row.high,row.low,row.close,row.volume].join(',')).join('\r\n');
  const fromCsv = parseDataset(csv,{format:'csv'});
  assert.deepEqual(runBacktest(fromCsv,zeroCosts).trades,runBacktest(original,zeroCosts).trades);
  assert.throws(()=>parseDataset('symbol,time,open,high,low,close,volume\nINFY,2026-09-14T09:15:00+05:30,,101,99,100,1000',{format:'csv'}),/numeric/);
  assert.throws(()=>parseDataset('symbol,time,open,high,low,close,volume\n"INFY',{format:'csv'}),/quote/);
  assert.throws(()=>parseDataset('symbol,time,open,high,low,close,volume,secret\n',{format:'csv'}),/exactly/);
  assert.throws(()=>parseDataset('{}',{format:'yaml'}),/json or csv/);
});

test('benchmark and sector context are validated and count toward the shared memory bound', async t => {
  const input = dataset(); input.benchmark_bars = session(); input.sector_bars = { IT:session() }; input.symbol_sectors = {INFY:'IT'};
  const result = runBacktest(input,zeroCosts);
  assert.equal(result.dataset.context_bar_count,150); assert.equal(result.dataset.benchmark_bar_count,75);
  assert.equal(result.dataset.sector_series_count,1);
  assert.throws(()=>runBacktest(input,{max_bars:200}),/bar limit/);
  input.benchmark_bars[1].time=input.benchmark_bars[0].time;
  assert.throws(()=>runBacktest(input),/strictly increasing/);
  input.benchmark_bars=session(); input.symbol_sectors.INFY='MISSING';
  assert.throws(()=>runBacktest(input),/known symbol and sector/);
  const service = new ResearchService(); t.after(()=>service.close());
  assert.throws(()=>service.start({...dataset(),benchmark_bars:Array(250000).fill({})}),/250000 total/);
  assert.equal(service.worker,null);
});

test('short entries sell at the next open and buy back with adverse slippage and both fill costs',()=>{
  const bars=enhancedBreakoutSession({short:true}),strategy_options={...breakoutOnly,technical_exit_enabled:false};
  const clean=runBacktest(dataset(bars),{...zeroCosts,strategy_options}),costly=runBacktest(dataset(bars),{fee_rate:.001,slippage_rate:.0005,strategy_options});
  assert.equal(clean.trades.length,1); const trade=clean.trades[0],charged=costly.trades[0];
  assert.equal(trade.side,'SELL');assert.equal(trade.entry_time,bars[34].time.toISOString());
  assert.ok(Math.abs(trade.entry-bars[34].open)<1e-8);assert.equal(trade.reason,'intraday_scheduled_close');
  assert.ok(charged.entry<trade.entry);assert.ok(charged.exit>trade.exit);
  assert.ok(charged.entry_fee>0&&charged.exit_fee>0);
  assert.ok(Math.abs(charged.pnl-((charged.entry-charged.exit)*charged.quantity-charged.entry_fee-charged.exit_fee))<1e-5);
  assert.ok(costly.metrics.net_pnl<clean.metrics.net_pnl);
});

test('short stop gaps cover at the worse opening price',()=>{
  const bars=enhancedBreakoutSession({short:true});
  Object.assign(bars[35],{open:103,high:103.1,low:102.9,close:103});
  const report=runBacktest(dataset(bars),{...zeroCosts,strategy_options:breakoutOnly});
  assert.equal(report.trades[0].side,'SELL');assert.equal(report.trades[0].reason,'stop_gap');
  assert.equal(report.trades[0].exit,103);assert.ok(report.trades[0].pnl<0);
});

test('short stop wins ambiguous OHLC collisions and favorable target gaps receive the conservative target',()=>{
  const bars=enhancedBreakoutSession({short:true}),[signal]=intraday_signal(bars.slice(0,34),breakoutOnly);
  assert.equal(signal.side,'SELL');
  Object.assign(bars[35],{open:signal.reference,high:signal.stop+.1,low:signal.target-.1,close:signal.reference});
  const collision=runBacktest(dataset(bars),{...zeroCosts,strategy_options:breakoutOnly}).trades[0];
  assert.equal(collision.reason,'stop_before_target_ambiguous_bar');assert.ok(Math.abs(collision.exit-signal.stop)<1e-8);
  Object.assign(bars[35],{open:signal.target-1,high:signal.target-.9,low:signal.target-1.1,close:signal.target-1});
  const gap=runBacktest(dataset(bars),{...zeroCosts,strategy_options:breakoutOnly}).trades[0];
  assert.equal(gap.reason,'target_gap_conservative');assert.ok(Math.abs(gap.exit-signal.target)<1e-8);
});

test('short proceeds cannot fund another simultaneous position beyond the shared cash bankroll',()=>{
  const result=runBacktest(dataset(enhancedBreakoutSession({short:true}),['INFY','TCS']),{
    ...zeroCosts,initial_capital:1000,risk_per_trade_pct:1,max_position_pct:1,max_positions:10,
    strategy_options:{...breakoutOnly,technical_exit_enabled:false}});
  assert.equal(result.trades.length,1);assert.equal(result.trades[0].symbol,'INFY');assert.equal(result.trades[0].side,'SELL');
  assert.ok(result.equity.every(row=>row.cash>=0));
});

test('short technical exits use the shared adverse-trend rule and the following open',()=>{
  const bars=enhancedBreakoutSession({short:true,technical:true});
  const result=runBacktest(dataset(bars),{...zeroCosts,strategy_options:breakoutOnly});
  assert.equal(result.trades.length,1);const trade=result.trades[0];
  assert.equal(trade.side,'SELL');assert.equal(trade.reason,'technical_trend_failure');
  assert.equal(trade.exit_time,bars[62].time.toISOString());assert.ok(Math.abs(trade.exit-bars[62].open)<1e-8);
});

test('daily ATR protection ratchets from completed history and never stops retrospectively inside its source candle',()=>{
  const data=dailyDataset(57),bars=data.symbols.INFY;
  Object.assign(bars[55],{open:106,high:108.6,low:105.9,close:108.5});
  const prefix=bars.slice(0,56).map(b=>new Candle(b.time,b.open,b.high,b.low,b.close,b.volume)),daily=daily_holding_exit(prefix,{stop:103.88});
  assert.ok(daily.trailing_stop>bars[55].low);
  Object.assign(bars[56],{open:108.5,high:108.6,low:daily.trailing_stop-.1,close:108});
  const result=runBacktest(data,zeroCosts),trade=result.trades[0];
  assert.equal(result.trades.length,1);assert.equal(trade.reason,'daily_atr_trailing_exit');
  assert.equal(trade.exit,daily.trailing_stop);assert.equal(trade.exit_time,new Date(bars[56].time+'T15:30:00+05:30').toISOString());
  assert.notEqual(trade.exit_time,new Date(bars[55].time+'T15:30:00+05:30').toISOString());
});

test('shared daily SMA trend failure schedules swing liquidation at the following observed open',()=>{
  const data=dailyDataset(78),bars=data.symbols.INFY;
  for(let i=55;i<78;i++) Object.assign(bars[i],{open:i===55?106:i===76?105.7:bars[i-1].close,
    high:110,low:105.2,close:i===75?105.8:i===76?105.7:106.5,volume:1000});
  const before=bars.slice(0,75).map(b=>new Candle(b.time,b.open,b.high,b.low,b.close,b.volume));
  const after=bars.slice(0,76).map(b=>new Candle(b.time,b.open,b.high,b.low,b.close,b.volume));
  assert.equal(daily_holding_exit(before).trend_exit,false);assert.equal(daily_holding_exit(after).trend_exit,true);
  const result=runBacktest(data,zeroCosts),trade=result.trades[0];
  assert.equal(result.trades.length,1);assert.equal(trade.reason,'daily_trend_loss');
  assert.equal(trade.exit_time,new Date(bars[76].time+'T09:15:00+05:30').toISOString());assert.equal(trade.exit,bars[76].open);
});

test('completed previous-session context enables early opening-drive analysis without future bar access',()=>{
  const previousStart=+new Date('2026-09-16T09:15:00+05:30'),start=+new Date('2026-09-17T09:15:00+05:30');
  const closes=Array.from({length:75},(_,i)=>100+(i-74)*.005+Math.sin(i*.8)*.2),adjustment=closes.at(-1)-100;
  const previous=closes.map((value,i)=>{const close=value-adjustment,open=i?closes[i-1]-adjustment:close-.02;
    return new Candle(new Date(previousStart+i*300000),open,Math.max(open,close)+.05,Math.min(open,close)-.05,close,1000);});
  const today=[];
  for(let i=0;i<75;i++){const close=[100.22,100.34,100.46][i]??100.46,open=i?today.at(-1).close:100.1;
    today.push(new Candle(new Date(start+i*300000),open,Math.max(open,close)+.02,Math.min(open,close)-.02,close,i<3?2500:1000));}
  const strategy_options={...breakoutOnly,enable_breakout:false,enable_opening_drive:true,intraday_short_enabled:false,higher_timeframe_filter:true,technical_exit_enabled:false};
  const full=dataset([...previous,...today]),result=runBacktest(full,{...zeroCosts,strategy_options});
  const entry=result.trades.find(t=>t.entry_time===today[3].time.toISOString());
  assert.ok(entry,'The shared strategy must receive yesterday’s completed indicator and15-minute context');
  assert.equal(entry.setup,'opening_drive');
  assert.equal(runBacktest(dataset(today),{...zeroCosts,strategy_options}).trades.some(t=>t.entry_time===entry.entry_time),false);
  const changed=structuredClone(full);Object.assign(changed.symbols.INFY[85],{open:101,high:102,low:100.9,close:101.5});
  const altered=runBacktest(changed,{...zeroCosts,strategy_options}).trades.find(t=>t.entry_time===entry.entry_time);
  for(const field of ['entry_time','entry','quantity','side','score'])assert.equal(altered[field],entry[field]);
});
