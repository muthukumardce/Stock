import asyncio
from datetime import datetime, timedelta
from unittest.mock import patch

from app.analytics import AnalyticsPool, analyze_batch
from app.strategy import Candle, IST


def records():
    at = datetime(2026, 9, 17, 9, 15, tzinfo=IST)
    bars = [Candle(at + timedelta(minutes=5 * i), 100, 101, 99, 100 + i / 100, 1000) for i in range(21)]
    return [{"token": 123, "strategy": "intraday", "bars": bars,
             "bar_time": bars[-1].time.isoformat(), "queued_at": 1, "generation": 0}]


def test_cpu_capacity_shards_respect_windows_limit_and_are_lazy():
    with patch("app.analytics.os.cpu_count", return_value=192):
        pool = AnalyticsPool(workers=0, reserve_cpus=4)
    assert pool.worker_limit == 188
    assert pool.capacities == [61, 61, 61, 5]
    assert all(p is None for p in pool.pools)


def test_spawn_process_roundtrip_matches_deterministic_direct_calculation():
    async def run():
        pool = AnalyticsPool(workers=2)
        batch = records()
        try:
            results = await asyncio.gather(pool.analyze(batch), pool.analyze(batch))
            assert results == [analyze_batch(batch), analyze_batch(batch)]
            metrics = pool.snapshot()
            assert metrics["completed_jobs"] == 2 and metrics["active_jobs"] == 0
            assert metrics["execution_workers"] == 1
        finally:
            await pool.close()
    asyncio.run(run())
