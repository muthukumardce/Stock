export class Mutex {
  #tail = Promise.resolve();
  async run(fn) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}
export const monotonic = () => Number(process.hrtime.bigint()) / 1e9;
export const nowIST = () => new Date();
export function parseTime(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value) : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  let input = value.trim().replace(' ', 'T');
  if (/^\d{4}-\d\d-\d\d$/.test(input)) input += 'T00:00:00';
  if (!/(?:Z|[+-]\d\d:?\d\d)$/i.test(input)) input += '+05:30';
  const result = new Date(input);
  return Number.isFinite(result.getTime()) ? result : null;
}
function shifted(date = new Date()) { return new Date(date.getTime() + 19800000); }
export function dateIST(date = new Date()) { return shifted(date).toISOString().slice(0, 10); }
export function timeIST(date = new Date()) { return shifted(date).toISOString().slice(11, 16); }
export function isoIST(date = new Date()) { return shifted(date).toISOString().slice(0, -1) + '+05:30'; }
export function marketHours(date = new Date()) {
  const day = shifted(date).getUTCDay(), clock = timeIST(date);
  return day > 0 && day < 6 && clock >= '09:15' && clock < '15:30';
}
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason || new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}
