/** CPU-only workers. Broker credentials, clients and database handles never enter jobs. */
import {Worker} from 'node:worker_threads';
import {detectCapacity} from './capacity.js';
import {atr, intraday_signal, swing_signal, technical_exit, STRATEGY_VERSION,strategy_snapshot,daily_holding_exit} from './strategy.js';
import {indicator_snapshot,validate_bars} from './indicators.js';

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value, digits) => Number(value.toFixed(digits));

export function technical_metrics(bars,options={}) {
  const indicators=options.strategy?strategy_snapshot(bars,options.strategy,options.context??{},options.strategy_options??{}):indicator_snapshot(bars,options);
  if (!indicators.data_valid||bars.length < 2) return indicators;
  const closes = bars.map(bar => bar.close);
  const returns = closes.slice(1).flatMap((value, i) => closes[i] > 0 ? [value / closes[i] - 1] : []);
  const last = bars.at(-1), ranges = Math.max(last.high - last.low, 1e-9);
  const path = closes.slice(1).reduce((sum, value, i) => sum + Math.abs(value - closes[i]), 0);
  const n = closes.length, xbar = (n - 1) / 2, ybar = mean(closes);
  const cov = closes.reduce((sum, value, i) => sum + (i - xbar) * (value - ybar), 0);
  const xvar = closes.reduce((sum, _, i) => sum + (i - xbar) ** 2, 0);
  const yvar = closes.reduce((sum, value) => sum + (value - ybar) ** 2, 0);
  const slope = xvar ? cov / xvar : 0;
  const avg_return = returns.length ? mean(returns) : 0;
  return {
    ...indicators, atr14: round(atr(options.strategy==='intraday'?[...(options.context?.previous_bars??[]).slice(-150),...bars]:bars), 4),
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
    const {bars, strategy, token, bar_time, generation, queued_at,analysis_id,strategy_options={},context={}} = record;
    if (!['intraday', 'swing'].includes(strategy)) throw new Error('Unknown analysis strategy');
    const quality=validate_bars(bars);
    const [signal, reason,explanation] = !quality.valid?[null,quality.reason]:strategy === 'intraday' ? intraday_signal(bars,strategy_options,context) : swing_signal(bars,strategy_options,context);
    let holding = null;
    if (quality.valid&&strategy === 'swing') {const exit=daily_holding_exit(bars);if(exit)holding={trailing:exit.trailing_stop,trend_exit:exit.trend_exit};}
    const none={exit:false,reason:strategy_options.enhanced_signals&&strategy_options.technical_exit_enabled!==false?'no_technical_exit':'technical_exit_disabled',evidence:[],strategy_version:STRATEGY_VERSION};
    const decisions=Object.fromEntries((strategy==='intraday'?['BUY','SELL']:['BUY']).map(side=>[side,quality.valid?technical_exit(bars,{strategy,side},strategy_options,context)??{...none,side}:{...none,side}]));
    return {token, strategy, bar_time, generation, queued_at,analysis_id,strategy_version:STRATEGY_VERSION, signal: signal ? {...signal} : null,
      reason, metrics: technical_metrics(bars,{strategy,context,strategy_options}), holding,
      explanation:explanation??{strategy_version:STRATEGY_VERSION,mode:'baseline',setups:[{setup:'breakout',reason}]},
      decision:decisions.BUY,decisions_by_side:decisions};
  });
}

export class AnalyticsPool {
  constructor(workers = 0, reserve_cpus = 4, batch_size = 32, options = {}) {
    this.capacity=options.logical_cpus!==undefined?{logical_cpus:options.logical_cpus,available_cpus:options.available_cpus??options.logical_cpus,source:'test_override',scope:'Synthetic test capacity'}:detectCapacity();
    this.logical_cpus = this.capacity.logical_cpus;
    const available = Math.max(1, this.capacity.available_cpus - Math.max(0, reserve_cpus));
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
    this.job_timeout_ms=Math.min(120000,Math.max(1,Math.floor(options.job_timeout_ms??15000)));
    if(!Number.isFinite(this.job_timeout_ms))throw new RangeError('Invalid analytics job timeout');
    this.workerFactory=options.workerFactory??((url,workerOptions)=>new Worker(url,workerOptions));
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
    const worker = this.workerFactory(new URL('./analytics-worker.js', import.meta.url), {
      resourceLimits: {maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4},
      // Do not inherit test runner / eval arguments into an isolated computation worker.
      execArgv: [],
    });
    const slot = {worker, job: null, timer: null, job_timer:null, failed: false};
    this.workers.add(slot);
    worker.on('message', message => {
      const job = slot.job;
      if (!job || message.id !== job.id) return this._fail(slot, new Error('Unexpected analytics worker response'));
      clearTimeout(slot.job_timer);slot.job_timer=null;
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
    clearTimeout(slot.job_timer);slot.job_timer=null;
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
      slot.job_timer=setTimeout(()=>this._fail(slot,new Error('Analytics job timed out')),this.job_timeout_ms);slot.job_timer.unref();
      try { slot.worker.postMessage({id: slot.job.id, records: slot.job.records}); }
      catch (error) { this._fail(slot, error); }
    }
  }

  snapshot(queue_depth = 0, cache_symbols = 0) {
    return {strategy_version:STRATEGY_VERSION,logical_cpus: this.logical_cpus,capacity:this.capacity, worker_limit: this.worker_limit,
      pool_shards: 1, live_workers: this.workers.size, active_jobs: this.active_jobs,
      completed_jobs: this.completed_jobs, completed_symbols: this.completed_symbols,
      queue_depth, analysis_ms: this.analysis_ms, cache_symbols,
      batch_size: this.batch_size,job_timeout_ms:this.job_timeout_ms, execution_workers: 1};
  }

  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      this.active_jobs--;
      job.reject(new Error('Analytics pool is closed'));
    }
    await Promise.all([...this.workers].map(async slot => {
      clearTimeout(slot.timer);
      clearTimeout(slot.job_timer);slot.job_timer=null;
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
