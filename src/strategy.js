/** Deterministic research strategies. These rules make no performance claims. */
import {parseTime} from './util.js';

const FIVE_MINUTES = 300_000;
const IST_OFFSET = 19_800_000;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const instant = value => parseTime(value) ?? new Date(NaN);
const day = value => new Date(+value + IST_OFFSET).toISOString().slice(0, 10);

export class Candle {
  constructor(time, open, high, low, close, volume) {
    if (time && typeof time === 'object' && !(time instanceof Date)) ({time, open, high, low, close, volume} = time);
    Object.assign(this, {time: instant(time), open, high, low, close, volume});
  }
}

export class Signal {
  constructor(strategy, reference, stop, target, reason, score) {
    if (strategy && typeof strategy === 'object') ({strategy, reference, stop, target, reason, score} = strategy);
    Object.assign(this, {strategy, reference, stop, target, reason, score});
  }
}

export class CandleBook {
  constructor() {
    this.bars = [];
    this.current = null;
    this.last_time = null;
    this.last_volume = null;
    this.complete = false;
  }

  update(at, price, cumulative_volume) {
    at = instant(at);
    if (!Number.isFinite(+at) || !Number.isFinite(price) || !Number.isFinite(cumulative_volume) || price <= 0 || cumulative_volume < 0) return null;
    if (this.last_time && at < this.last_time) return null;
    const bucket = new Date(Math.floor(+at / FIVE_MINUTES) * FIVE_MINUTES);
    if (this.last_time && day(at) !== day(this.last_time)) {
      this.bars.length = 0;
      this.current = null;
      this.last_volume = null;
    }
    const delta = this.last_volume === null ? 0 : Math.max(0, cumulative_volume - this.last_volume);
    let closed = null;
    if (!this.current || +bucket !== +this.current.time) {
      if (this.current) {
        const contiguous = bucket - this.current.time === FIVE_MINUTES;
        const late_enough = +this.last_time >= +bucket - 30_000;
        if (this.complete && contiguous && late_enough) {
          closed = this.current;
          this.bars.push(closed);
          if (this.bars.length > 80) this.bars.shift();
        } else this.bars.length = 0;
        this.complete = contiguous && at - bucket <= 30_000;
      } else this.complete = false;
      this.current = new Candle(bucket, price, price, price, price, delta);
    } else if (delta > 0) {
      this.current.high = Math.max(this.current.high, price);
      this.current.low = Math.min(this.current.low, price);
      this.current.close = price;
      this.current.volume += delta;
    }
    this.last_time = at;
    this.last_volume = cumulative_volume;
    return closed;
  }
}

export function atr(bars, period = 14) {
  if (bars.length < period + 1) return 0;
  return mean(bars.slice(-period).map((bar, index) => {
    const previous = bars[bars.length - period - 1 + index];
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));
  }));
}

export function intraday_signal(bars) {
  if (bars.length < 21) return [null, 'warming_up'];
  const recent = bars.slice(-21);
  if (recent.slice(1).some((bar, index) => instant(bar.time) - instant(recent[index].time) !== FIVE_MINUTES)) return [null, 'candle_gap'];
  const last = recent.at(-1), previous = recent.slice(0, -1);
  if (last.close <= Math.max(...previous.map(bar => bar.high))) return [null, 'no_breakout'];
  const avg_volume = mean(previous.map(bar => bar.volume));
  if (avg_volume <= 0 || last.volume < avg_volume * 1.5) return [null, 'insufficient_relative_volume'];
  const closes = recent.map(bar => bar.close);
  if (mean(closes.slice(-5)) <= mean(closes.slice(-20))) return [null, 'trend_not_confirmed'];
  const spread = last.high - last.low;
  if (spread <= 0 || (last.close - last.open) / spread < 0.6 || (last.high - last.close) / spread > 0.2) return [null, 'weak_candle'];
  const risk = Math.max(atr(recent) * 1.5, last.close * 0.004);
  if (risk / last.close > 0.025) return [null, 'excessive_volatility'];
  return [new Signal('intraday', last.close, last.close - risk, last.close + 2 * risk,
    '20-bar breakout, rising trend, strong candle, volume >= 1.5x', Math.min(10, last.volume / avg_volume)), 'candidate'];
}

export function swing_signal(bars) {
  if (bars.length < 55) return [null, 'warming_up_daily'];
  bars = bars.slice(-55);
  if (bars.slice(1).some((bar, index) => Math.abs(bar.open / bars[index].close - 1) > 0.2)) return [null, 'daily_discontinuity'];
  const last = bars.at(-1), previous = bars.slice(-21, -1);
  if (last.close <= Math.max(...previous.map(bar => bar.high))) return [null, 'no_daily_breakout'];
  if (mean(bars.slice(-20).map(bar => bar.close)) <= mean(bars.slice(-50).map(bar => bar.close))) return [null, 'daily_trend_not_confirmed'];
  const avg_volume = mean(previous.map(bar => bar.volume));
  if (avg_volume <= 0 || last.volume < 1.5 * avg_volume) return [null, 'insufficient_daily_volume'];
  const spread = last.high - last.low;
  if (spread <= 0 || last.close <= last.open || (last.high - last.close) / spread > 0.25) return [null, 'weak_daily_candle'];
  const risk = Math.max(2 * atr(bars), last.close * 0.02);
  if (risk / last.close > 0.08) return [null, 'excessive_daily_volatility'];
  return [new Signal('swing', last.close, last.close - risk, last.close + 2.5 * risk,
    'Completed daily 20-day breakout, SMA20 > SMA50, volume >= 1.5x', Math.min(10, last.volume / avg_volume)), 'candidate'];
}

export function position_size(capital, free_cash, entry, stop, risk_pct, max_position_pct) {
  if (![capital, free_cash, entry, stop, risk_pct, max_position_pct].every(Number.isFinite)) return 0;
  if (capital <= 0 || free_cash <= 0 || entry <= stop || stop <= 0) return 0;
  const per_share_risk = entry - stop + entry * 0.002;
  return Math.max(0, Math.floor(Math.min(capital * risk_pct / per_share_risk,
    capital * max_position_pct / (entry * 1.001), free_cash / (entry * 1.001))));
}
