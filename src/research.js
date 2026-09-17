/** One cancellable CPU worker, separate from the live execution event loop. */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

export class ResearchService {
  constructor() { this.worker = null; this.timer = null; this.completion = null; this.resolveCompletion = null; this.job = { id: null, status: 'idle', progress: 0, result: null, error: null }; }
  start(dataset, options = {}) {
    if (this.worker) throw new Error('Research is already running; cancel it before starting another run');
    const rows = Object.values(dataset?.symbols ?? {}), contextRows = [dataset?.benchmark_bars ?? [], ...Object.values(dataset?.sector_bars ?? {})];
    const allRows = [...rows,...contextRows];
    if (!rows.length || rows.length > 5000 || contextRows.length > 101 || allRows.some(v => !Array.isArray(v)) || allRows.reduce((n, v) => n + v.length, 0) > 250000) throw new Error('Research requires at most 250000 total symbol/context bars, 5000 symbols and 100 sector series');
    const id = randomUUID();
    this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
    this.job = { id, status: 'running', phase: 'validating', progress: 0, processed_bars: 0, total_bars: rows.reduce((n, v) => n + v.length, 0), started_at: new Date().toISOString(), finished_at: null, result: null, error: null };
    try {
      this.worker = new Worker(new URL('./backtest-worker.js', import.meta.url), { workerData: { dataset, options }, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } });
    } catch (error) { this._finish('failed', { error: String(error.message).slice(0, 1000) }); throw error; }
    const worker = this.worker;
    worker.on('message', message => {
      if (this.job.id !== id || this.job.status !== 'running') return;
      if (message.type === 'progress') {
        const { type, ...progress } = message; Object.assign(this.job, progress);
      } else if (message.type === 'complete') this._finish('complete', { progress: 1, result: message.result });
      else if (message.type === 'failed') this._finish('failed', { error: message.error });
    });
    worker.on('error', error => { if (this.job.id === id && this.job.status === 'running') this._finish('failed', { error: String(error.message).slice(0, 1000) }); });
    worker.on('exit', code => {
      if (this.worker === worker) this.worker = null;
      if (this.job.id === id && this.job.status === 'running') this._finish('failed', { error: `Research worker exited before producing a report (${code})` });
    });
    const budget = Math.min(120000, Math.max(100, Number(options.max_runtime_ms) || 45000));
    this.timer = setTimeout(() => {
      if (this.worker === worker && this.job.status === 'running') { this._finish('failed', { error: 'Research exceeded its time limit; reduce dataset size' }); worker.terminate().catch(() => {}); }
    }, budget * 2 + 10000);
    this.timer.unref();
    return this.status();
  }
  _finish(status, details = {}) { clearTimeout(this.timer); this.timer = null; Object.assign(this.job, { status, finished_at: new Date().toISOString(), ...details }); this.resolveCompletion?.(this.status()); this.resolveCompletion = null; }
  status() { return structuredClone(this.job); }
  async wait() { return this.job.status === 'running' ? this.completion : this.status(); }
  async cancel() {
    const worker = this.worker;
    if (worker) {
      if (this.job.status === 'running') this._finish('cancelled', { error: null });
      await worker.terminate();
      if (this.worker === worker) this.worker = null;
    }
    return this.status();
  }
  async close() { await this.cancel(); }
}
