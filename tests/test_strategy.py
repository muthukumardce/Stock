from datetime import datetime, timedelta

from app.strategy import Candle, CandleBook, IST, intraday_signal, position_size, swing_signal


def intraday_bars():
    start = datetime(2026, 9, 17, 9, 15, tzinfo=IST)
    bars = [Candle(start + timedelta(minutes=5 * i), 100 + i * .05,
                   100.3 + i * .05, 99.9 + i * .05, 100.2 + i * .05, 1000)
            for i in range(20)]
    bars.append(Candle(start + timedelta(minutes=100), 101, 101.8, 100.95, 101.75, 2500))
    return bars


def test_intraday_breakout_needs_volume_and_contiguous_closed_bars():
    bars = intraday_bars()
    signal, reason = intraday_signal(bars)
    assert reason == "candidate" and signal.stop < signal.reference < signal.target
    bars[-1].volume = 500
    assert intraday_signal(bars)[1] == "insufficient_relative_volume"
    bars[-1].time += timedelta(minutes=5)
    assert intraday_signal(bars)[1] == "candle_gap"


def test_first_partial_candle_never_counts_and_gap_invalidates_history():
    book = CandleBook()
    start = datetime(2026, 9, 17, 9, 17, tzinfo=IST)
    book.update(start, 100, 10000)
    book.update(start.replace(minute=19, second=45), 101, 11000)
    assert book.update(start.replace(minute=20), 102, 11500) is None
    book.update(start.replace(minute=24, second=45), 103, 12500)
    closed = book.update(start.replace(minute=25), 104, 13000)
    assert closed and closed.volume == 1500
    assert len(book.bars) == 1
    book.update(start.replace(minute=35), 105, 14000)
    assert not book.bars


def test_sizing_respects_cash_risk_and_fee_allowance():
    qty = position_size(100000, 1000, 100, 98, .0025, .1)
    assert qty == 9
    assert position_size(100000, 100000, 100, 100, .0025, .1) == 0
    assert position_size(100000, 100000, float("nan"), 95, .0025, .1) == 0


def test_swing_uses_longer_history_and_rejects_split_like_discontinuities():
    start = datetime(2026, 1, 1, tzinfo=IST)
    bars = [Candle(start + timedelta(days=i), 100 + i * .1,
                   100.4 + i * .1, 99.8 + i * .1, 100.3 + i * .1, 1000) for i in range(54)]
    bars.append(Candle(start + timedelta(days=54), 105.2, 106.6, 105, 106.5, 2500))
    assert swing_signal(bars)[0].strategy == "swing"
    assert swing_signal(bars[:20])[1] == "warming_up_daily"
    bars[25].open = 50
    assert swing_signal(bars)[1] == "daily_discontinuity"
