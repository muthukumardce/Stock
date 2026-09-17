/** CPU-only workers. Broker credentials, clients and database handles never enter jobs. */
import os from 'node:os';
import {Worker} from 'node:worker_threads';
import {atr, intraday_signal, swing_signal} from './strategy.js';

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value, digits) => Number(value.toFixed(digits));

export function technical_metrics(bars) {
  if (bars.length < 2) return {};
  const closes = bars.map(bar => bar.close);
  const returns = closes.slice(1).flatMap((value, i) => closes[i] > 0 ? [value / closes[i] - 1] : []);
  const changes = closes.slice(1).map((value, i) => value - closes[i]).slice(-14);
  const gain = mean(changes.map(value => Math.max(0, value)));
  const loss = mean(changes.map(value => Math.max(0, -value)));
  const rsi = loss ? 100 - 100 / (1 + gain / loss) : gain ? 100 : 50;
  const last = bars.at(-1), ranges = Math.max(last.high - last.low, 1e-9);
  const path = closes.slice(1).reduce((sum, value, i) => sum + Math.abs(value - closes[i]), 0);
  const n = closes.length, xbar = (n - 1) / 2, ybar = mean(closes);
  const cov = closes.reduce((sum, value, i) => sum + (i - xbar) * (value - ybar), 0);
  const xvar = closes.reduce((sum, _, i) => sum + (i - xbar) ** 2, 0);
  const yvar = closes.reduce((sum, value) => sum + (value - ybar) ** 2, 0);
  const slope = xvar ? cov / xvar : 0;
  const avg_return = returns.length ? mean(returns) : 0;
  return {
    rsi14: round(rsi, 2), atr14: round(atr(bars), 4),
    return_volatility: returns.length ? round(Math.sqrt(mean(returns.map(value => (value - avg_return) ** 2))), 6) : 0,
    trend_slope_pct: round(slope / last.close * 100, 5),
    trend_r_squared: xvar && yvar ? round(cov * cov / (xvar * yvar), 5) : 0,
    efficiency_ratio: path ? round(Math.abs(closes.at(-1) - closes[0]) / path, 5) : 0,
    candle_body_ratio: round(Math.abs(last.close - last.open) / ranges, 4),
    upper_wick_ratio: round((last.high - Math.max(last.open, last.close)) / ranges, 4),
  };
}

export function analyze_batch(records) {
  return records.map(record => {
    const {bars, strategy, token, bar_time, generation, queued_at} = record;
    if (!['intraday', 'swing'].includes(strategy)) throw new Error('Unknown analysis strategy');
    const [signal, reason] = strategy === 'intraday' ? intraday_signal(bars) : swing_signal(bars);
    let holding = null;
    if (strategy === 'swing' && bars.length >= 21 && reason !== 'daily_discontinuity') {
      const sma20 = mean(bars.slice(-20).map(bar => bar.close));
      holding = {trailing: Math.max(...bars.slice(-20).map(bar => bar.close)) - 3 * atr(bars),
        trend_exit: bars.at(-1).close < sma20 && mean(bars.slice(-5).map(bar => bar.close)) < sma20};
    }
    return {token, strategy, bar_time, generation, queued_at, signal: signal ? {...signal} : null,
      reason, metrics: technical_metrics(bars), holding};
  });
}

export class AnalyticsPool {
  constructor(workers = 0, reserve_cpus = 4, batch_size = 32, options = {}) {
    // cpus() counts logical CPUs across Windows processor groups; availableParallelism()
    // can report only one group on this machine. Workers are created only for queued work.
    this.logical_cpus = options.logical_cpus ?? (os.cpus().length || 1);
    const available = Math.max(1, this.logical_cpus - Math.max(0, reserve_cpus));
    this.worker_limit = Math.max(1, workers > 0 ? Math.min(this.logical_cpus, Math.floor(workers)) : available);
    this.batch_size = Math.min(256, Math.max(1, Math.floor(batch_size)));
    this.workers = new Set();
    this.queue = [];
    this.active_jobs = 0;
    this.completed_jobs = 0;
    this.completed_symbols = 0;
    this.analysis_ms = 0;
    this.closed = false;
    this.next_id = 0;
    this.idle_ms = options.idle_ms ?? 60_000;
  }

  analyze(records) {
    if (this.closed) return Promise.reject(new Error('Analytics pool is closed'));
    if (!Array.isArray(records) || records.length > 256) return Promise.reject(new Error('Analysis batch must contain at most 256 records'));
    if (this.active_jobs >= this.worker_limit * 3) return Promise.reject(new Error('Analytics queue is full'));
    if (!records.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this.queue.push({id: ++this.next_id, records, resolve, reject, began: performance.now()});
      this.active_jobs++;
      this._dispatch();
    });
  }

  _spawn() {
    const worker = new Worker(new URL('./analytics-worker.js', import.meta.url), {
      resourceLimits: {maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4},
      // Do not inherit test runner / eval arguments into an isolated computation worker.
      execArgv: [],
    });
    const slot = {worker, job: null, timer: null, failed: false};
    this.workers.add(slot);
    worker.on('message', message => {
      const job = slot.job;
      if (!job || message.id !== job.id) return this._fail(slot, new Error('Unexpected analytics worker response'));
      slot.job = null;
      this.active_jobs--;
      if (message.error) job.reject(new Error(message.error));
      else {
        this.completed_jobs++;
        this.completed_symbols += job.records.length;
        this.analysis_ms = round(performance.now() - job.began, 2);
        job.resolve(message.results);
      }
      worker.unref();
      slot.timer = setTimeout(() => {
        if (!slot.job) {
          this.workers.delete(slot);
          worker.terminate().catch(() => {});
        }
      }, this.idle_ms);
      slot.timer.unref();
      this._dispatch();
    });
    worker.on('error', error => this._fail(slot, error));
    worker.on('exit', code => {
      if (slot.job || code !== 0) this._fail(slot, new Error(`Analytics worker exited (${code})`));
      this.workers.delete(slot);
    });
    return slot;
  }

  _fail(slot, error) {
    if (slot.failed) return;
    slot.failed = true;
    clearTimeout(slot.timer);
    this.workers.delete(slot);
    if (slot.job) {
      this.active_jobs--;
      slot.job.reject(error);
      slot.job = null;
    }
    slot.worker.terminate().catch(() => {});
    this._dispatch();
  }

  _dispatch() {
    if (this.closed) return;
    while (this.queue.length) {
      let slot = [...this.workers].find(candidate => !candidate.job);
      if (!slot && this.workers.size < this.worker_limit) {
        try { slot = this._spawn(); }
        catch (error) {
          this.active_jobs--;
          this.queue.shift().reject(error);
          continue;
        }
      }
      if (!slot) return;
      clearTimeout(slot.timer);
      slot.timer = null;
      slot.job = this.queue.shift();
      slot.worker.ref();
      try { slot.worker.postMessage({id: slot.job.id, records: slot.job.records}); }
      catch (error) { this._fail(slot, error); }
    }
  }

  snapshot(queue_depth = 0, cache_symbols = 0) {
    return {logical_cpus: this.logical_cpus, worker_limit: this.worker_limit,
      pool_shards: 1, live_workers: this.workers.size, active_jobs: this.active_jobs,
      completed_jobs: this.completed_jobs, completed_symbols: this.completed_symbols,
      queue_depth, analysis_ms: this.analysis_ms, cache_symbols,
      batch_size: this.batch_size, execution_workers: 1};
  }

  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      this.active_jobs--;
      job.reject(new Error('Analytics pool is closed'));
    }
    await Promise.all([...this.workers].map(async slot => {
      clearTimeout(slot.timer);
      if (slot.job) {
        this.active_jobs--;
        slot.job.reject(new Error('Analytics pool is closed'));
        slot.job = null;
      }
      slot.failed = true;
      await slot.worker.terminate();
    }));
    this.workers.clear();
  }
}
