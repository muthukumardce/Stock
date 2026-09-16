"""Deterministic, unvalidated research strategies; no performance claims.

Intraday requires 21 contiguous, fully observed five-minute candles. Swing
uses completed daily candles only. Corporate actions can distort daily bars;
large discontinuities deliberately invalidate the swing signal.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import floor, isfinite
from statistics import mean

IST = timezone(timedelta(hours=5, minutes=30))


@dataclass
class Candle:
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class Signal:
    strategy: str
    reference: float
    stop: float
    target: float
    reason: str
    score: float


class CandleBook:
    """Never fill missing intervals or count the first partial candle."""

    def __init__(self):
        self.bars: deque[Candle] = deque(maxlen=80)
        self.current: Candle | None = None
        self.last_time: datetime | None = None
        self.last_volume: float | None = None
        self.complete = False

    def update(self, at: datetime, price: float, cumulative_volume: float):
        if at.tzinfo is None:
            at = at.replace(tzinfo=IST)
        at = at.astimezone(IST)
        if not isfinite(price) or not isfinite(cumulative_volume) or price <= 0 or cumulative_volume < 0:
            return None
        if self.last_time and at < self.last_time:
            return None
        bucket = at.replace(minute=at.minute // 5 * 5, second=0, microsecond=0)
        if self.last_time and at.date() != self.last_time.date():
            self.bars.clear()
            self.current = None
            self.last_volume = None
        delta = max(0, cumulative_volume - self.last_volume) if self.last_volume is not None else 0
        closed = None
        if self.current is None or bucket != self.current.time:
            if self.current:
                contiguous = bucket - self.current.time == timedelta(minutes=5)
                late_enough = self.last_time >= bucket - timedelta(seconds=30)
                if self.complete and contiguous and late_enough:
                    closed = self.current
                    self.bars.append(closed)
                else:
                    self.bars.clear()
                self.complete = contiguous and at - bucket <= timedelta(seconds=30)
            else:
                self.complete = False
            self.current = Candle(bucket, price, price, price, price, delta)
        elif delta > 0:
            self.current.high = max(self.current.high, price)
            self.current.low = min(self.current.low, price)
            self.current.close = price
            self.current.volume += delta
        self.last_time, self.last_volume = at, cumulative_volume
        return closed


def atr(bars: list[Candle], period=14) -> float:
    if len(bars) < period + 1:
        return 0.0
    pairs = list(zip(bars[:-1], bars[1:]))[-period:]
    return mean(max(b.high - b.low, abs(b.high - a.close), abs(b.low - a.close)) for a, b in pairs)


def intraday_signal(bars: list[Candle]) -> tuple[Signal | None, str]:
    if len(bars) < 21:
        return None, "warming_up"
    recent = bars[-21:]
    if any(b.time - a.time != timedelta(minutes=5) for a, b in zip(recent, recent[1:])):
        return None, "candle_gap"
    last, previous = recent[-1], recent[:-1]
    if last.close <= max(b.high for b in previous):
        return None, "no_breakout"
    avg_volume = mean(b.volume for b in previous)
    if avg_volume <= 0 or last.volume < avg_volume * 1.5:
        return None, "insufficient_relative_volume"
    closes = [b.close for b in recent]
    if mean(closes[-5:]) <= mean(closes[-20:]):
        return None, "trend_not_confirmed"
    spread = last.high - last.low
    if spread <= 0 or (last.close - last.open) / spread < 0.6 or (last.high - last.close) / spread > 0.2:
        return None, "weak_candle"
    risk = max(atr(recent) * 1.5, last.close * 0.004)
    if risk / last.close > 0.025:
        return None, "excessive_volatility"
    return Signal("intraday", last.close, last.close - risk, last.close + 2 * risk,
                  "20-bar breakout, rising trend, strong candle, volume >= 1.5x",
                  min(10.0, last.volume / avg_volume)), "candidate"


def swing_signal(bars: list[Candle]) -> tuple[Signal | None, str]:
    if len(bars) < 55:
        return None, "warming_up_daily"
    bars = bars[-55:]
    if any(abs(b.open / a.close - 1) > 0.2 for a, b in zip(bars, bars[1:])):
        return None, "daily_discontinuity"
    last, previous = bars[-1], bars[-21:-1]
    if last.close <= max(b.high for b in previous):
        return None, "no_daily_breakout"
    if mean(b.close for b in bars[-20:]) <= mean(b.close for b in bars[-50:]):
        return None, "daily_trend_not_confirmed"
    avg_volume = mean(b.volume for b in previous)
    if avg_volume <= 0 or last.volume < 1.5 * avg_volume:
        return None, "insufficient_daily_volume"
    spread = last.high - last.low
    if spread <= 0 or last.close <= last.open or (last.high - last.close) / spread > 0.25:
        return None, "weak_daily_candle"
    risk = max(2 * atr(bars), last.close * 0.02)
    if risk / last.close > 0.08:
        return None, "excessive_daily_volatility"
    return Signal("swing", last.close, last.close - risk, last.close + 2.5 * risk,
                  "Completed daily 20-day breakout, SMA20 > SMA50, volume >= 1.5x",
                  min(10.0, last.volume / avg_volume)), "candidate"


def position_size(capital: float, free_cash: float, entry: float, stop: float,
                  risk_pct: float, max_position_pct: float) -> int:
    if not all(isfinite(v) for v in (capital, free_cash, entry, stop, risk_pct, max_position_pct)):
        return 0
    if capital <= 0 or free_cash <= 0 or entry <= stop or stop <= 0:
        return 0
    # Budget 10 basis points per side in addition to the stop distance.
    per_share_risk = entry - stop + entry * 0.002
    return max(0, floor(min(capital * risk_pct / per_share_risk,
                            capital * max_position_pct / (entry * 1.001),
                            free_cash / (entry * 1.001))))
