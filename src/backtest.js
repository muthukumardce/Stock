/** Offline chronological research. This module never opens a broker connection. */
import * as rules from './strategy.js';
import { parseTime, dateIST, timeIST } from './util.js';
import {evaluateComparisonTask} from './backtest-analytics.js';

const MINUTE = 60000, DAY = 86400000;
export const MAX_RESEARCH_BARS = 1000000;
const LIMIT_BARS = MAX_RESEARCH_BARS, LIMIT_SYMBOLS = 5000;
export const MAX_RESEARCH_RUNTIME_MS = 600000;
// Comparison variants can cover the full supported research sample. Optimizer
// candidates retain their separate, shorter MAX_RESEARCH_RUNTIME_MS cap.
export const MAX_COMPARISON_RUNTIME_MS = 1800000;
const DEFAULTS = Object.freeze({ initial_capital: 100000, risk_per_trade_pct: 0.0025,
  max_position_pct: 0.1, max_positions: 5, fee_rate: 0.001, slippage_rate: 0.0005,
  entry_cutoff: '14:45', exit_time: '15:10', split_fractions: [0.6, 0.2, 0.2],
  max_bars: 250000, max_runtime_ms: 45000, max_equity_points: 2000,
  strategy_options: {}, score_from:null, score_to:null });
const CAVEATS = [
  'Historical research is not evidence of future profitability. No parameters are optimized using these results.',
  'Signals use completed candles; entries and technical exits use the next available candle open. Intrabar execution is a conservative approximation.',
  'Fees and slippage are editable estimates, not contract-note charges. Liquidity, queue priority, spread, circuits, taxes and execution failures are not fully modelled.',
  'The supplied symbol universe may have survivorship bias; delisted stocks and historical index membership are not reconstructed.',
  'Corporate actions, inaccurate candles and missing history can distort results. Dataset coverage and exclusions must be reviewed.',
  'Chronological train/validation/test labels are reporting partitions, not independent optimization or proof of an unseen live result. Positions and prior indicator history carry across boundaries.',
  'Positions still open at the dataset end are marked at the last observed close, not given an invented liquidation fill. Intraday positions without an observed exit remain explicitly unresolved.',
  'Swing research applies the shared daily SMA trend and ratcheted ATR trailing rules using completed daily candles. GTT lifecycle, broker protection failures and holdings authorization are not reconstructed.',
  'Missing intraday candles are detected causally: later entries pause for that symbol-session and existing exposure exits at the first observed opening. The missing interval cannot establish whether a stop or target traded; these exits are explicitly marked as data-gap approximations.',
  'Intraday short simulations reserve the full entry notional and never recycle short sale proceeds. Actual margin, short availability, auctions, borrowing restrictions and broker square-off are not reconstructed.',
  'Scheduled intraday exits use the first candle close at or after the configured minute; five-minute data may delay the simulated exit by less than five minutes.',
];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => new Date(value).toISOString();
const round = (value, precision = 8) => Number(value.toFixed(precision));
const sum = values => values.reduce((a, b) => a + b, 0);

function configuration(options = {}) {
  if (!ownObject(options)) throw new TypeError('Backtest options must be an object');
  const cfg = { ...DEFAULTS, ...options, strategy_options: { ...(options.strategy_options ?? {}) } };
  if (!finite(cfg.initial_capital) || cfg.initial_capital <= 0 || cfg.initial_capital > 1e12) throw new RangeError('Initial capital must be positive and at most 1e12');
  for (const key of ['risk_per_trade_pct', 'max_position_pct']) if (!finite(cfg[key]) || cfg[key] <= 0 || cfg[key] > 1) throw new RangeError(`${key} must be a fraction in (0, 1]`);
  for (const key of ['fee_rate', 'slippage_rate']) if (!finite(cfg[key]) || cfg[key] < 0 || cfg[key] > 0.05) throw new RangeError(`${key} must be a fraction between 0 and 0.05`);
  if (!Number.isInteger(cfg.max_positions) || cfg.max_positions < 1 || cfg.max_positions > 100) throw new RangeError('Maximum positions must be between 1 and 100');
  if (!Number.isInteger(cfg.max_bars) || cfg.max_bars < 1 || cfg.max_bars > LIMIT_BARS) throw new RangeError(`Maximum bars must be between 1 and ${LIMIT_BARS}`);
  if (!Number.isInteger(cfg.max_runtime_ms) || cfg.max_runtime_ms < 100 || cfg.max_runtime_ms > MAX_COMPARISON_RUNTIME_MS) throw new RangeError(`Maximum runtime must be between 100 and ${MAX_COMPARISON_RUNTIME_MS} ms`);
  if (!Number.isInteger(cfg.max_equity_points) || cfg.max_equity_points < 2 || cfg.max_equity_points > 10000) throw new RangeError('Equity points must be between 2 and 10000');
  if (![cfg.entry_cutoff, cfg.exit_time].every(v => typeof v === 'string' && /^\d\d:\d\d$/.test(v) && Number(v.slice(3)) < 60) || !('09:15' < cfg.entry_cutoff && cfg.entry_cutoff < cfg.exit_time && cfg.exit_time <= '15:30')) throw new RangeError('Require 09:15 < entry cutoff < exit time <= 15:30');
  if (!Array.isArray(cfg.split_fractions) || cfg.split_fractions.length !== 3 || cfg.split_fractions.some(v => !finite(v) || v <= 0 || v >= 1) || Math.abs(sum(cfg.split_fractions) - 1) > 1e-9) throw new RangeError('Three positive chronological split fractions must sum to one');
  if (!ownObject(cfg.strategy_options) || JSON.stringify(cfg.strategy_options).length > 10000) throw new TypeError('Strategy options must be a small object');
  for(const key of ['score_from','score_to'])if(cfg[key]!==null&&(typeof cfg[key]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(cfg[key])||!parseTime(cfg[key])||dateIST(parseTime(cfg[key]))!==cfg[key]))throw new TypeError('Scoring boundaries must be valid IST dates');
  if(cfg.score_from&&cfg.score_to&&cfg.score_from>cfg.score_to)throw new RangeError('Scoring start must not follow scoring end');
  return cfg;
}

/** Copy and validate every price before research starts. Timestamps are opens. */
function normalize(dataset, cfg) {
  if (!ownObject(dataset) || !['5minute', 'day'].includes(dataset.interval) || !ownObject(dataset.symbols)) throw new TypeError('Dataset requires interval 5minute/day and a symbols-to-candles mapping');
  const symbols = Object.keys(dataset.symbols).sort();
  if (!symbols.length || symbols.length > LIMIT_SYMBOLS) throw new RangeError(`Dataset requires 1 to ${LIMIT_SYMBOLS} symbols`);
  const intraday = dataset.interval === '5minute', events = [], histories = new Map(), sessions = new Set();
  let totalBars = 0;
  function candles(rows, label) {
    if (!Array.isArray(rows)) throw new TypeError(`${label}: invalid candle series`);
    if (rows.length > cfg.max_bars) throw new RangeError(`Dataset exceeds the ${cfg.max_bars}-bar limit including context`);
    let previous = -Infinity;
    return rows.map(row => {
      if (++totalBars > cfg.max_bars) throw new RangeError(`Dataset exceeds the ${cfg.max_bars}-bar limit including context`);
      if (!ownObject(row)) throw new TypeError(`${label}: malformed candle`);
      const rawTime = row.time ?? row.date;
      if (typeof rawTime === 'string') {
        const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(rawTime);
        if (!parts || new Date(Date.UTC(+parts[1],+parts[2]-1,+parts[3])).toISOString().slice(0,10) !== rawTime.slice(0,10)
          || parts[4] !== undefined && (+parts[4] > 23 || +parts[5] > 59 || +(parts[6] ?? 0) > 59)) throw new TypeError(`${label}: invalid candle timestamp`);
      }
      let at = parseTime(rawTime);
      if (!at) throw new TypeError(`${label}: invalid candle timestamp`);
      if (!intraday) at = parseTime(dateIST(at) + 'T09:15:00');
      const ms = at.getTime(), clock = timeIST(at);
      if (ms <= previous) throw new RangeError(`${label}: timestamps must be strictly increasing without duplicates`);
      previous = ms;
      if (intraday && (ms % (5 * MINUTE) !== 0 || clock < '09:15' || clock > '15:25')) throw new RangeError(`${label}: five-minute candles must start on a regular-session five-minute boundary`);
      if (!['open', 'high', 'low', 'close', 'volume'].every(k => finite(row[k])) || Math.min(row.open, row.high, row.low, row.close) <= 0 || row.volume < 0 || row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close, row.high)) throw new RangeError(`${label}: invalid OHLCV values or price range`);
      return new rules.Candle(at, row.open, row.high, row.low, row.close, row.volume);
    });
  }
  for (const symbol of symbols) {
    if (!/^[A-Z0-9&.-]{1,40}$/.test(symbol) || !Array.isArray(dataset.symbols[symbol]) || !dataset.symbols[symbol].length) throw new TypeError(`Invalid symbol or candles: ${symbol}`);
    for (const bar of candles(dataset.symbols[symbol], symbol)) {
      const ms = +bar.time, date = dateIST(bar.time);
      events.push({ symbol, bar, ms, date }); sessions.add(date);
    }
    histories.set(symbol, []);
  }
  const benchmark = candles(dataset.benchmark_bars ?? [], 'benchmark'), sectors = new Map();
  if (dataset.sector_bars !== undefined && !ownObject(dataset.sector_bars)) throw new TypeError('Sector bars must map sector identifiers to candles');
  if (dataset.symbol_sectors !== undefined && !ownObject(dataset.symbol_sectors)) throw new TypeError('Symbol sectors must be a mapping');
  for (const [sector, rows] of Object.entries(dataset.sector_bars ?? {})) {
    if (!/^[A-Za-z0-9&._ -]{1,60}$/.test(sector) || sectors.size >= 100) throw new TypeError('Invalid sector context identifier or count');
    sectors.set(sector, candles(rows, 'sector ' + sector));
  }
  const symbolSectors = new Map();
  for (const [symbol, sector] of Object.entries(dataset.symbol_sectors ?? {})) {
    if (!symbols.includes(symbol) || typeof sector !== 'string' || !sectors.has(sector)) throw new TypeError('Symbol sector mapping requires a known symbol and sector series');
    symbolSectors.set(symbol, sector);
  }
  events.sort((a, b) => a.ms - b.ms || a.symbol.localeCompare(b.symbol, 'en'));
  return { symbols, events, histories, sessions: [...sessions].sort(), intraday, benchmark, sectors, symbolSectors, totalBars };
}

function accumulator(start) { return { start, end: start, peak: start, drawdown: 0, trades: [], fees: 0 }; }
function observe(acc, equity) { acc.end = equity; acc.peak = Math.max(acc.peak, equity); if (acc.peak > 0) acc.drawdown = Math.max(acc.drawdown, (acc.peak - equity) / acc.peak); }
function metrics(acc, open_positions = 0) {
  const profits = acc.trades.map(t => t.pnl), gains = sum(profits.filter(v => v > 0)), losses = -sum(profits.filter(v => v < 0));
  return { initial_capital: round(acc.start), ending_equity: round(acc.end), net_pnl: round(acc.end - acc.start),
    net_return_pct: acc.start > 0 ? round((acc.end / acc.start - 1) * 100) : 0,
    trade_count: profits.length, win_rate_pct: profits.length ? round(profits.filter(v => v > 0).length / profits.length * 100) : 0,
    expectancy: profits.length ? round(sum(profits) / profits.length) : 0, profit_factor: losses > 0 ? round(gains / losses) : null,
    profit_factor_state: losses > 0 ? 'finite' : profits.length ? 'no_losses' : 'no_trades',
    max_drawdown_pct: round(acc.drawdown * 100), costs_paid: round(acc.fees), open_positions };
}
function splits(dates, cfg) {
  if (dates.length < 3) return [];
  const first = Math.min(dates.length - 2, Math.max(1, Math.floor(dates.length * cfg.split_fractions[0])));
  const second = Math.min(dates.length - 1, Math.max(first + 1, Math.floor(dates.length * (cfg.split_fractions[0] + cfg.split_fractions[1]))));
  return [['train', 0, first], ['validation', first, second], ['test', second, dates.length]].map(([name, start, end]) => ({ name, from: dates[start], to: dates[end - 1], session_count: end - start, acc: null }));
}

/** One shared cash account across every symbol; no future OHLCV reaches rules. */
export function runBacktest(dataset, options = {}, hooks = {}) {
  const steps=backtestSteps(dataset,options,hooks);let step=steps.next();
  while(!step.done)step=steps.next(step.value.tasks.map(task=>evaluateComparisonTask(task,step.value.strategy_options)));
  return step.value;
}

/** The portfolio has exactly one owner. Only pure, closed-candle analytics are
 * yielded, and every timestamp is settled before the following opening. */
export function* backtestSteps(dataset, options = {}, hooks = {}) {
  const started = performance.now(), cfg = configuration(options), data = normalize(dataset, cfg);
  const scoreFrom=cfg.score_from??data.sessions[0],scoreTo=cfg.score_to??data.sessions.at(-1),scoredSessions=data.sessions.filter(date=>date>=scoreFrom&&date<=scoreTo);
  if(!scoredSessions.length)throw new RangeError('Scoring window contains no observed sessions');
  data.events=data.events.filter(event=>event.date<=scoreTo);
  const scoredEvents=data.events.filter(event=>event.date>=scoreFrom);
  const strategy = data.intraday ? 'intraday' : 'swing';
  const positions = new Map(), pending = new Map(), marks = new Map(), traded = new Set(), trades = [], equity = [];
  const sessions = new Map(), previousBars = new Map(), contextCursors = new Map(), gapSessions = new Set(), gaps = [];
  const overall = accumulator(cfg.initial_capital), periods = splits(scoredSessions, cfg), counts = {};
  let cash = cfg.initial_capital, activePeriod = null, processed = 0, gapCount = 0;
  const direction = p => p.side === 'SELL' ? -1 : 1;
  const equityValue = () => cash + sum([...positions].map(([symbol, p]) => p.quantity * (p.entry + direction(p) * ((marks.get(symbol) ?? p.entry) - p.entry))));
  const count = reason => counts[reason] = (counts[reason] ?? 0) + 1;
  const charge = amount => { overall.fees += amount; if (activePeriod) activePeriod.acc.fees += amount; };
  function closePosition(symbol, rawPrice, time, reason) {
    const p = positions.get(symbol), side = direction(p), price = rawPrice * (1 - side * cfg.slippage_rate), fee = p.quantity * price * cfg.fee_rate;
    const grossPnl = side * p.quantity * (price - p.entry);
    cash += p.quantity * p.entry + grossPnl - fee; charge(fee);
    const pnl = grossPnl - p.entry_fee - fee;
    const trade = { symbol, strategy, side: p.side, setup: p.setup, signal_time: p.signal_time, entry_time: p.entry_time, exit_time: timestamp(time),
      entry: round(p.entry), exit: round(price), quantity: p.quantity, entry_fee: round(p.entry_fee), exit_fee: round(fee),
      pnl: round(pnl), return_pct: round(pnl / (p.entry * p.quantity + p.entry_fee) * 100), reason, score: p.score,
      data_gap: Boolean(p.data_gap) };
    trades.push(trade); overall.trades.push(trade); activePeriod?.acc.trades.push(trade); positions.delete(symbol);
  }
  function recordGap(symbol, expected, observed, reason) {
    if(dateIST(new Date(expected))<scoreFrom||dateIST(new Date(expected))>scoreTo)return;
    gapCount++; count(reason); gapSessions.add(symbol + ':' + dateIST(new Date(expected)));
    if (gaps.length < 1000) gaps.push({symbol, expected_at:timestamp(expected), observed_at:observed === null ? null : timestamp(observed), reason});
  }
  function closedContext(key, rows, at) {
    let cursor = contextCursors.get(key);
    if (!cursor) { cursor = { index:0, bars:[] }; contextCursors.set(key,cursor); }
    while (cursor.index < rows.length && +rows[cursor.index].time <= at) {
      cursor.bars.push(rows[cursor.index++]); if (cursor.bars.length > 200) cursor.bars.shift();
    }
    return cursor.bars;
  }
  function contextFor(symbol, at) {
    const sector = data.symbolSectors.get(symbol);
    return { as_of:new Date(data.intraday ? at + 5 * MINUTE : +parseTime(dateIST(new Date(at)) + 'T15:30:00')),
      previous_bars:previousBars.get(symbol) ?? [], benchmark_bars:closedContext('benchmark',data.benchmark,at),
      sector_bars:sector ? closedContext('sector:' + sector,data.sectors.get(sector),at) : [] };
  }
  function applyDailyProtection(p, daily) {
    if (!daily) return;
    if (finite(daily.trailing_stop) && daily.trailing_stop > 0) p.stop = p.trailing_stop = Math.max(p.stop,daily.trailing_stop);
    if (daily.trend_exit) p.pending_exit = 'daily_trend_loss';
  }
  function updateDailyProtection(p, history) {
    if (data.intraday || typeof rules.daily_holding_exit !== 'function') return;
    applyDailyProtection(p,rules.daily_holding_exit(history,p,cfg.strategy_options));
  }
  const guard=()=>{
    const elapsed=performance.now()-started;
    if(elapsed>cfg.max_runtime_ms)throw Object.assign(new RangeError('Backtest runtime limit exceeded; use a smaller dataset'),{
      code:'worker_timeout',runtime_budget_ms:cfg.max_runtime_ms,elapsed_ms:Math.round(elapsed),processed_bars:processed,total_bars:data.events.length,
    });
    if(hooks.cancelled?.())throw new Error('Research cancelled');
  };
  const stride = Math.max(1, Math.ceil(data.events.length / cfg.max_equity_points));
  for (let index = 0; index < data.events.length;) {
    guard();
    const batch = [], at = data.events[index].ms, date = data.events[index].date;
    const scoring=date>=scoreFrom&&date<=scoreTo;
    while (index < data.events.length && data.events[index].ms === at) batch.push(data.events[index++]);
    const period = periods.find(p => p.from <= date && date <= p.to) ?? null;
    if (period !== activePeriod) { activePeriod = period; if (period && !period.acc) period.acc = accumulator(equityValue()); }
    for (const { symbol, bar } of batch) marks.set(symbol, bar.open);
    if (data.intraday) for (const event of batch) {
      const {symbol,bar} = event, prior = sessions.get(symbol), history = data.histories.get(symbol);
      if (!prior || prior.date !== date) {
        previousBars.set(symbol, prior && !prior.gapped && history.length === 75 && timeIST(history.at(-1).time) === '15:25' ? [...history] : []);
        history.length = 0;
        const gapped = timeIST(bar.time) !== '09:15';
        sessions.set(symbol,{date,last:at,gapped});
        if (gapped) { recordGap(symbol,+parseTime(date + 'T09:15:00'),at,'session_open_missing'); event.gap = true; }
      } else {
        if (at - prior.last !== 5 * MINUTE) {
          prior.gapped = true; event.gap = true;
          recordGap(symbol,prior.last + 5 * MINUTE,at,'intraday_candle_gap');
        }
        prior.last = at;
      }
      const held = positions.get(symbol);
      if (held && dateIST(parseTime(held.entry_time)) !== date) {
        event.overdue = true; held.data_gap = true;
        recordGap(symbol,+parseTime(dateIST(parseTime(held.entry_time)) + 'T' + cfg.exit_time),at,'intraday_exit_unobserved');
      }
      if (held && event.gap) held.data_gap = true;
    }
    // Existing exposure resolves at this opening before candidate allocations.
    for (const { symbol, bar, gap, overdue } of batch) {
      const p = positions.get(symbol);
      if (!p) continue;
      if (direction(p) * (bar.open - p.stop) <= 0) closePosition(symbol, bar.open, at, 'stop_gap');
      else if (overdue) closePosition(symbol,bar.open,at,'intraday_overdue_data_gap');
      else if (gap) closePosition(symbol,bar.open,at,'intraday_data_gap_exit');
      else if (p.pending_exit) closePosition(symbol, bar.open, at, p.pending_exit);
      else if (direction(p) * (bar.open - p.target) >= 0) closePosition(symbol, p.target, at, 'target_gap_conservative');
    }
    const candidates = [];
    for (const event of batch) {
      const decision = pending.get(event.symbol); pending.delete(event.symbol);
      if (!decision || positions.has(event.symbol)) continue;
      if (data.intraday && (decision.date !== date || event.ms - decision.bar_time !== 5 * MINUTE || timeIST(event.bar.time) >= cfg.entry_cutoff || sessions.get(event.symbol)?.gapped)) { count('entry_time_or_data_gap'); continue; }
      if (!data.intraday && event.ms - decision.bar_time > 7 * DAY) { count('daily_entry_data_gap'); continue; }
      candidates.push({ ...event, decision });
    }
    candidates.sort((a, b) => b.decision.signal.score - a.decision.signal.score || a.symbol.localeCompare(b.symbol, 'en'));
    for (const { symbol, bar, decision } of candidates) {
      const signal = decision.signal, side = signal.side ?? 'BUY', sign = side === 'SELL' ? -1 : 1,
        entry = bar.open * (1 + sign * cfg.slippage_rate), key = symbol + ':' + date;
      if (!['BUY','SELL'].includes(side) || !data.intraday && side !== 'BUY') { count('unsupported_trade_side'); continue; }
      if (positions.size >= cfg.max_positions) { count('maximum_positions'); continue; }
      if (traded.has(key)) { count('already_traded_this_session'); continue; }
      if (!finite(signal.stop) || !finite(signal.target) || signal.stop <= 0 || signal.target <= 0 || sign * (entry - signal.stop) <= 0 || sign * (signal.target - entry) <= 0) { count('opening_gap_invalidates_signal'); continue; }
      if(!data.intraday){const dailyGate=rules.swing_entry_gate(data.histories.get(symbol),signal,entry);if(dailyGate){count(dailyGate);continue;}}
      const capital = Math.max(0, equityValue()), perShareRisk = Math.abs(entry - signal.stop) + entry * cfg.fee_rate * 2;
      const quantity = Math.max(0, Math.floor(Math.min(capital * cfg.risk_per_trade_pct / perShareRisk,
        capital * cfg.max_position_pct / (entry * (1 + cfg.fee_rate)), cash / (entry * (1 + cfg.fee_rate)))));
      if (!Number.isSafeInteger(quantity) || !quantity) { count('insufficient_cash_or_risk_budget'); continue; }
      const fee = entry * quantity * cfg.fee_rate;
      cash -= entry * quantity + fee; charge(fee); traded.add(key);
      const position = { strategy, symbol, side, entry, quantity, stop: signal.stop, target: signal.target,
        setup: signal.setup ?? 'breakout', score: signal.score, entry_fee: fee, entry_time: timestamp(at), signal_time: timestamp(decision.signal_time) };
      positions.set(symbol,position); updateDailyProtection(position,data.histories.get(symbol));
      marks.set(symbol, bar.open);
    }
    const analytics=[],actions=[];
    // Stop first when OHLC alone cannot tell which boundary was touched first.
    for (const { symbol, bar } of batch) {
      const p = positions.get(symbol), closeTime = data.intraday ? at + 5 * MINUTE : +parseTime(date + 'T15:30:00');
      if (p) {
        const stopHit = p.side === 'SELL' ? bar.high >= p.stop : bar.low <= p.stop;
        const targetHit = p.side === 'SELL' ? bar.low <= p.target : bar.high >= p.target;
        if (stopHit) closePosition(symbol, p.stop, closeTime, targetHit ? 'stop_before_target_ambiguous_bar' : p.trailing_stop && p.stop === p.trailing_stop ? 'daily_atr_trailing_exit' : 'stop');
        else if (targetHit) closePosition(symbol, p.target, closeTime, 'target');
        else if (data.intraday && timeIST(new Date(closeTime)) >= cfg.exit_time) closePosition(symbol, bar.close, closeTime, 'intraday_scheduled_close');
      }
      marks.set(symbol, bar.close);
      let history = data.histories.get(symbol);
      history.push(bar); if (history.length > 200) history.shift();
      const held = positions.get(symbol);
      const context = contextFor(symbol,at);
      const signal=scoring&&!held&&!traded.has(symbol+':'+date),blocked=signal&&data.intraday&&sessions.get(symbol)?.gapped;
      const taskIndex=held||signal&&!blocked?analytics.length:null;
      if(taskIndex!==null)analytics.push({symbol,strategy,history,context,position:held?{...held}:null,signal:signal&&!blocked});
      actions.push({symbol,held,closeTime,blocked,signal,taskIndex});
    }
    const calculated=analytics.length?yield {tasks:analytics,strategy_options:cfg.strategy_options,guard,processed_bars:processed,total_bars:data.events.length,batch_timestamp:timestamp(at),batch_bars:batch.length}:[];
    if(!Array.isArray(calculated)||calculated.length!==analytics.length)throw new Error('Comparison analytics returned an incomplete timestamp batch');
    // Worker completion order cannot choose which signal wins portfolio cash.
    // Apply in the original symbol order; pending entries still execute at the
    // next observed opening using the unchanged score and symbol ordering.
    for(const {symbol,held,closeTime,blocked,signal:requested,taskIndex} of actions){
      if(blocked){count('entries_blocked_after_data_gap');continue;}
      if(taskIndex===null)continue;
      const result=calculated[taskIndex];
      if(held){applyDailyProtection(held,result.daily);if(result.technical?.exit&&!held.pending_exit)held.pending_exit=result.technical.reason||'technical_exit';}
      if(requested){
        const {signal,reason}=result;count(reason);
        if(signal&&(!data.intraday||timeIST(new Date(closeTime))<cfg.entry_cutoff))pending.set(symbol,{signal,bar_time:at,signal_time:closeTime,date});
      }
    }
    const value = equityValue(); if(scoring)observe(overall, value); if (activePeriod) observe(activePeriod.acc, value);
    processed += batch.length;
    if (scoring&&(!equity.length || processed % stride < batch.length || index === data.events.length)) equity.push({ timestamp: timestamp(data.intraday ? at + 5 * MINUTE : +parseTime(date + 'T15:30:00')), equity: round(value), cash: round(cash), positions: positions.size });
    if (processed % 250 < batch.length || index === data.events.length) hooks.onProgress?.({ processed_bars: processed, total_bars: data.events.length, progress: processed / data.events.length });
  }
  const caveats = [...CAVEATS];
  const unresolved = [];
  if (data.intraday) for (const p of positions.values()) {
    p.status = 'unresolved_missing_exit'; p.data_gap = true;
    const expected = +parseTime(dateIST(parseTime(p.entry_time)) + 'T' + cfg.exit_time);
    recordGap(p.symbol,expected,null,'intraday_exit_unobserved'); unresolved.push(p.symbol);
  }
  if (gapCount) caveats.push(`${gapCount} missing-data events affected ${gapSessions.size} symbol-sessions. Earlier decisions were retained; no session was excluded using future candle availability.`);
  if (unresolved.length) caveats.push(`${unresolved.length} intraday positions have no observed exit. Marked P&L includes these unresolved positions and cannot be treated as a completed trading result.`);
  if (!data.benchmark.length) caveats.push('No historical benchmark candles were supplied; setups requiring benchmark context cannot be evaluated.');
  if (!periods.length) caveats.push('At least three distinct sessions are needed for chronological reporting partitions; no holdout partitions were produced.');
  return { strategy_version: rules.STRATEGY_VERSION ?? '1.0.0', strategy, options: cfg,
    dataset: { interval: dataset.interval, symbol_count: data.symbols.length, bar_count: scoredEvents.length,
      from: timestamp(scoredEvents[0].ms), to: timestamp(scoredEvents.at(-1).ms), session_count: scoredSessions.length,
      warmup_bar_count:data.events.length-scoredEvents.length,score_from:scoreFrom,score_to:scoreTo,
      context_bar_count:data.benchmark.length+[...data.sectors.values()].reduce((total,rows)=>total+rows.length,0), benchmark_bar_count:data.benchmark.length, sector_series_count:data.sectors.size,
      excluded_intraday_symbol_sessions:0, source: String(dataset.metadata?.source ?? 'user_supplied') },
    metrics: metrics(overall, positions.size), period_metrics: periods.map(({ acc, ...period }) => ({ ...period, metrics: metrics(acc ?? accumulator(cfg.initial_capital)), trade_assignment: 'exit_session; equity is marked across boundaries' })),
    trades, equity: equity.length > cfg.max_equity_points ? equity.filter((_, i) => i === 0 || i === equity.length - 1 || i % Math.ceil(equity.length / cfg.max_equity_points) === 0) : equity,
    open_positions: [...positions.values()].map(p => ({ ...p, last: marks.get(p.symbol), unrealised_pnl: round(direction(p) * p.quantity * (marks.get(p.symbol) - p.entry) - p.entry_fee) })),
    data_quality:{policy:'causal_gap_detection',gap_count:gapCount,affected_symbol_sessions:gapSessions.size,gaps,gaps_truncated:gapCount>gaps.length,
      unresolved_intraday_positions:unresolved,completed_result:unresolved.length===0},
    decisions: counts, caveats, cost_model: { fees: 'estimated proportional fee on every fill', fee_rate: cfg.fee_rate, slippage: 'adverse proportional adjustment on every fill', slippage_rate: cfg.slippage_rate,
      short_capital:'full entry notional reserved; short sale proceeds are unavailable for other entries' },
  };
}

export function compareStrategies(dataset, options = {}, hooks = {}) {
  const { baseline_options = {}, enhanced_options = { enhanced_signals: true }, ...common } = options;
  function variant(phase,strategyOptions,offset) {
    // Announce the new variant before normalization and its first candle batch.
    // The caller retains its known total until actual normalized counts arrive.
    hooks.onProgress?.({phase,progress:offset,processed_bars:0});
    try {
      return runBacktest(dataset,{...common,strategy_options:strategyOptions},{
        ...hooks,onProgress:p=>hooks.onProgress?.({...p,phase,progress:offset+p.progress/2}),
      });
    } catch(error) {if(error&&typeof error==='object')error.phase=phase;throw error;}
  }
  const baseline = variant('baseline',{...baseline_options,enhanced_signals:false},0);
  const enhanced = variant('enhanced',{...enhanced_options,enhanced_signals:true},0.5);
  return comparisonReport(baseline,enhanced);
}

export function comparisonReport(baseline,enhanced){
  const comparison = Object.fromEntries(['net_return_pct', 'net_pnl', 'max_drawdown_pct', 'trade_count', 'expectancy'].map(key => [key, round(enhanced.metrics[key] - baseline.metrics[key])]));
  return { strategy_version: enhanced.strategy_version, dataset: enhanced.dataset, baseline, enhanced,
    comparison, comparison_complete:baseline.data_quality.completed_result && enhanced.data_quality.completed_result,
    comparison_description: 'Enhanced minus baseline, on identical candles, initial capital and cost assumptions; lower drawdown is better. Unresolved exposure is marked, not a completed trade.', caveats: [...new Set([...baseline.caveats, ...enhanced.caveats])] };
}

/** Bounded offline CLI/import parser. Filesystem and broker access belong to the caller. */
export function parseDataset(text, {format='json', interval='5minute'} = {}) {
  if (typeof text !== 'string' || text.length > 64 * 1024 * 1024) throw new RangeError('Dataset text must be at most 64 MiB of characters');
  text = text.replace(/^\uFEFF/,'');
  let dataset;
  if (format === 'json') dataset = JSON.parse(text);
  else if (format === 'csv') {
    const rows = []; let row = [], field = '', quoted = false, closed = false;
    function cell() { row.push(field); field = ''; closed = false; if (row.length > 20) throw new RangeError('CSV has too many columns'); }
    function line() { cell(); if (row.some(v => v.trim() !== '')) rows.push(row); row = []; if (rows.length > LIMIT_BARS + 1) throw new RangeError('CSV exceeds the candle limit'); }
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i+1] === '"') { field += '"'; i++; }
        else if (char === '"') { quoted = false; closed = true; }
        else field += char;
      } else if (char === ',') cell();
      else if (char === '\n' || char === '\r') { if (char === '\r' && text[i+1] === '\n') i++; line(); }
      else if (char === '"' && field === '' && !closed) quoted = true;
      else { if (closed || char === '"') throw new TypeError('Malformed CSV quoting'); field += char; }
      if (field.length > 1000) throw new RangeError('CSV field is too long');
    }
    if (quoted) throw new TypeError('Unterminated CSV quote');
    if (field || row.length || closed) line();
    const headers = (rows.shift() ?? []).map(v => v.trim().toLowerCase());
    const timeKey = headers.includes('time') ? 'time' : 'date', required = ['symbol',timeKey,'open','high','low','close','volume'];
    if (headers.length !== required.length || new Set(headers).size !== headers.length || required.some(h => !headers.includes(h))) throw new TypeError('CSV requires exactly symbol,time (or date),open,high,low,close,volume columns');
    const symbols = Object.create(null);
    for (const values of rows) {
      if (values.length !== headers.length) throw new TypeError('CSV row does not match its headers');
      const raw = Object.fromEntries(headers.map((h,i) => [h,values[i].trim()])), symbol = raw.symbol;
      const candle = {time:raw[timeKey]};
      for (const key of ['open','high','low','close','volume']) {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw[key])) throw new TypeError('CSV requires finite numeric OHLCV values');
        candle[key] = Number(raw[key]);
      }
      (symbols[symbol] ??= []).push(candle);
    }
    dataset = {interval,symbols,metadata:{source:'user_csv'}};
  } else throw new TypeError('Dataset format must be json or csv');
  normalize(dataset,configuration());
  return dataset;
}
