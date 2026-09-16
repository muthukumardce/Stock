"""CPU-only batched analytics, separate from the single order execution loop.

Windows ProcessPoolExecutor permits at most 61 workers in one pool. Shards
respect that constraint, with processes created lazily as real work arrives.
No market credentials, broker clients or database handles enter worker jobs.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict
import multiprocessing
import os
from statistics import mean, pstdev
import time

from .strategy import atr, intraday_signal, swing_signal


def technical_metrics(bars):
    if len(bars) < 2:
        return {}
    closes = [b.close for b in bars]
    returns = [b / a - 1 for a, b in zip(closes, closes[1:]) if a > 0]
    changes = [b - a for a, b in zip(closes, closes[1:])][-14:]
    gain = mean(max(0, v) for v in changes)
    loss = mean(max(0, -v) for v in changes)
    rsi = 100 - 100 / (1 + gain / loss) if loss else (100.0 if gain else 50.0)
    last = bars[-1]
    ranges = max(last.high - last.low, 1e-9)
    path = sum(abs(b - a) for a, b in zip(closes, closes[1:]))
    n = len(closes)
    xbar, ybar = (n - 1) / 2, mean(closes)
    cov = sum((i - xbar) * (v - ybar) for i, v in enumerate(closes))
    xvar = sum((i - xbar) ** 2 for i in range(n))
    yvar = sum((v - ybar) ** 2 for v in closes)
    slope = cov / xvar if xvar else 0
    return {"rsi14": round(rsi, 2), "atr14": round(atr(bars), 4),
            "return_volatility": round(pstdev(returns), 6) if returns else 0,
            "trend_slope_pct": round(slope / last.close * 100, 5),
            "trend_r_squared": round(cov * cov / (xvar * yvar), 5) if xvar and yvar else 0,
            "efficiency_ratio": round(abs(closes[-1] - closes[0]) / path, 5) if path else 0,
            "candle_body_ratio": round(abs(last.close - last.open) / ranges, 4),
            "upper_wick_ratio": round((last.high - max(last.open, last.close)) / ranges, 4)}


def analyze_batch(records):
    """Picklable process entry point: deterministic input -> deterministic output."""
    results = []
    for record in records:
        bars = record["bars"]
        strategy = record["strategy"]
        signal, reason = intraday_signal(bars) if strategy == "intraday" else swing_signal(bars)
        holding = None
        if strategy == "swing" and len(bars) >= 21 and reason != "daily_discontinuity":
            holding = {"trailing": max(b.close for b in bars[-20:]) - 3 * atr(bars),
                       "trend_exit": bars[-1].close < mean(b.close for b in bars[-20:]) and mean(b.close for b in bars[-5:]) < mean(b.close for b in bars[-20:])}
        results.append({"token": record["token"], "strategy": strategy,
                        "bar_time": record["bar_time"], "generation": record["generation"],
                        "queued_at": record["queued_at"], "signal": asdict(signal) if signal else None,
                        "reason": reason, "metrics": technical_metrics(bars), "holding": holding})
    return results


class AnalyticsPool:
    def __init__(self, workers=0, reserve_cpus=4, batch_size=32):
        self.logical_cpus = os.cpu_count() or 1
        available = max(1, self.logical_cpus - max(0, reserve_cpus))
        self.worker_limit = min(self.logical_cpus, workers) if workers > 0 else available
        self.worker_limit = max(1, self.worker_limit)
        self.batch_size = min(256, max(1, batch_size))
        self.capacities = [min(61, self.worker_limit - offset) for offset in range(0, self.worker_limit, 61)]
        self.pools = [None] * len(self.capacities)
        self.active_by_pool = [0] * len(self.capacities)
        self.active_jobs = 0
        self.completed_jobs = 0
        self.completed_symbols = 0
        self.analysis_ms = 0.0
        self.closed = False

    async def analyze(self, records):
        if self.closed:
            raise RuntimeError("Analytics pool is closed")
        index = min(range(len(self.capacities)), key=lambda i: self.active_by_pool[i] / self.capacities[i])
        if self.pools[index] is None:
            self.pools[index] = ProcessPoolExecutor(max_workers=self.capacities[index], mp_context=multiprocessing.get_context("spawn"))
        self.active_by_pool[index] += 1
        self.active_jobs += 1
        began = time.perf_counter()
        try:
            result = await asyncio.get_running_loop().run_in_executor(self.pools[index], analyze_batch, records)
            self.completed_jobs += 1
            self.completed_symbols += len(records)
            self.analysis_ms = round((time.perf_counter() - began) * 1000, 2)
            return result
        finally:
            self.active_jobs -= 1
            self.active_by_pool[index] -= 1

    def snapshot(self, queue_depth=0, cache_symbols=0):
        return {"logical_cpus": self.logical_cpus, "worker_limit": self.worker_limit,
                "pool_shards": len(self.capacities), "active_jobs": self.active_jobs,
                "completed_jobs": self.completed_jobs, "completed_symbols": self.completed_symbols,
                "queue_depth": queue_depth, "analysis_ms": self.analysis_ms,
                "cache_symbols": cache_symbols, "batch_size": self.batch_size,
                "execution_workers": 1}

    async def close(self):
        self.closed = True
        # Keep process joins off the asyncio thread so status and controls remain
        # responsive while an in-flight calculation completes.
        await asyncio.gather(*(asyncio.to_thread(pool.shutdown, wait=True, cancel_futures=True)
                               for pool in self.pools if pool is not None))
