import asyncio
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import time
import pytest

from app.strategy import CandleBook, IST, Signal
from app.trading import TradingEngine
from app.storage import Store


NOW = datetime(2026, 9, 17, 12, 0, tzinfo=IST)


class MemoryStore:
    def __init__(self):
        self.values, self.log = {}, []

    def get(self, key, default=None):
        return deepcopy(self.values.get(key, default))

    def set(self, key, value):
        self.values[key] = deepcopy(value)

    def event(self, kind, message, data=None, level="info"):
        self.log.append({"kind": kind, "message": message, "data": deepcopy(data), "level": level})
        return len(self.log)


def settings(tmp_path, mode="paper"):
    return SimpleNamespace(trading_mode=mode, paper_capital=100000., live_capital=100000. if mode == "live" else 0.,
                           live_trading_enabled=mode == "live", data_dir=tmp_path,
                           kite_api_key="", kite_user_id="", max_position_pct=.1, risk_per_trade_pct=.0025,
                           daily_loss_pct=.01, max_positions=5, entry_cutoff="14:45", exit_time="15:10",
                           max_spread_pct=.003, min_daily_turnover=10000.)


def ready_engine(tmp_path, mode="paper"):
    store = MemoryStore()
    engine = TradingEngine(settings(tmp_path, mode), store)
    engine.connected = engine.running = True
    engine.status = "running"
    engine.universe = {1: {"tradingsymbol": "TEST", "tick_size": .05}}
    engine.quotes = {1: {"last_price": 100, "volume_traded": 100000,
                         "received_at": time.monotonic(),
                         "depth": {"buy": [{"price": 99.95, "quantity": 10000}],
                                   "sell": [{"price": 100.05, "quantity": 10000}]}}}
    engine.account = {"positions": {"net": []}, "orders": [], "holdings": [], "trades": [],
                      "margins": {"equity": {"available": {"cash": 100000, "live_balance": 100000}}}}
    engine._account_at = time.monotonic()
    engine._profile_verified = engine._recovery_account_verified = True
    engine.recovery.update(phase="ready", blocked=False)
    engine.day = NOW.date().isoformat()
    return engine, store


def signal(strategy="intraday"):
    return Signal(strategy, 100, 98, 104, "test", 2)


def test_paper_persists_fill_and_pause_preserves_position(tmp_path):
    engine, store = ready_engine(tmp_path)
    with patch("app.trading.now_ist", return_value=NOW):
        assert asyncio.run(engine._enter_locked(1, signal())) == "paper_buy_filled"
        asyncio.run(engine.pause())
    restored = TradingEngine(engine.settings, store)
    assert restored.positions["TEST"]["quantity"] > 0
    assert engine.status == "paused" and "TEST" in engine.positions
    assert engine.snapshot()["safe_to_stop"]


def test_ambiguous_live_submit_never_resends_after_restart(tmp_path):
    engine, store = ready_engine(tmp_path, "live")
    class TimeoutBroker:
        calls = 0
        async def buy_cover(self, *args):
            self.calls += 1
            assert store.get("bot_state_live")["intents"]  # persisted before I/O
            raise TimeoutError()
    engine.broker = TimeoutBroker()
    with patch("app.trading.now_ist", return_value=NOW):
        assert asyncio.run(engine._enter_locked(1, signal())) == "cover_order_unknown"
        engine.running = True
        assert asyncio.run(engine._enter_locked(1, signal())) == "unresolved_order"
    assert engine.broker.calls == 1
    restored = TradingEngine(engine.settings, store)
    assert restored._unresolved_intents()
    assert not restored.snapshot()["safe_to_stop"]


def test_maintenance_blocks_entry_immediately(tmp_path):
    engine, store = ready_engine(tmp_path)
    (tmp_path / "maintenance.lock").write_text("deploy")
    with patch("app.trading.now_ist", return_value=NOW):
        assert asyncio.run(engine._enter_locked(1, signal())) == "maintenance_active"
    assert not engine.positions


def test_daily_rollover_keeps_swing_and_resets_baseline(tmp_path):
    engine, store = ready_engine(tmp_path)
    store.set("strategy_settings", {"intraday_enabled": False, "swing_enabled": True,
                                    "intraday_capital": 0, "swing_capital": 100000})
    with patch("app.trading.now_ist", return_value=NOW):
        assert asyncio.run(engine._enter_locked(1, signal("swing"))) == "paper_buy_filled"
    engine.realised = 500
    engine.positions["TEST"]["last"] = 103
    with patch("app.trading.now_ist", return_value=NOW + timedelta(days=1)):
        engine._roll_day()
    assert engine._daily_pnl() == 0
    assert engine.positions["TEST"]["strategy"] == "swing"
    assert not engine.running


def test_flatten_paper_only_owned_and_uses_gap_price(tmp_path):
    engine, store = ready_engine(tmp_path)
    engine.account["holdings"] = [{"tradingsymbol": "MANUAL", "quantity": 10}]
    with patch("app.trading.now_ist", return_value=NOW):
        asyncio.run(engine._enter_locked(1, signal()))
        engine.quotes[1]["depth"]["buy"][0]["price"] = 90
        asyncio.run(engine.flatten())
    assert not engine.positions and engine.realised < -900
    assert engine.account["holdings"][0]["quantity"] == 10
    assert store.log[-2]["data"]["exit"] < 90


def test_cover_partial_fill_exit_only_cancels_owned_child_once(tmp_path):
    engine, store = ready_engine(tmp_path, "live")
    intent = {"tag": "EB1", "symbol": "TEST", "token": 1, "strategy": "intraday", "quantity": 10,
              "entry": 100, "stop": 98, "target": 104, "created_at": NOW.isoformat(),
              "state": "unknown", "filled": 0, "exit_requested": [], "pnl_accounted": 0.}
    engine.intents = {"EB1": intent}
    engine.account["orders"] = [
        {"order_id": "parent", "tag": "EB1", "variety": "co", "transaction_type": "BUY", "exchange": "NSE", "tradingsymbol": "TEST", "product": "MIS", "quantity": 10,
         "status": "CANCELLED", "filled_quantity": 4, "average_price": 100},
        {"order_id": "child", "parent_order_id": "parent", "variety": "co", "transaction_type": "SELL", "exchange": "NSE", "tradingsymbol": "TEST", "product": "MIS", "trigger_price": 98,
         "status": "TRIGGER PENDING", "quantity": 4, "pending_quantity": 4, "filled_quantity": 0}]
    engine.account["positions"] = {"net": [{"tradingsymbol": "TEST", "exchange": "NSE", "product": "CO", "quantity": 4}]}
    class FakeBroker:
        calls = []
        async def cancel_cover(self, order_id, parent_order_id=None):
            self.calls.append((order_id, parent_order_id))
    engine.broker = FakeBroker()
    with patch("app.trading.now_ist", return_value=NOW):
        asyncio.run(engine._reconcile_live_locked())
        assert engine.positions["TEST"]["quantity"] == 4
        asyncio.run(engine._exit_locked("TEST", "test"))
        asyncio.run(engine._exit_locked("TEST", "test"))
    assert engine.broker.calls == [("child", "parent")]
    assert not engine.snapshot()["safe_to_stop"]


def test_zero_fill_rejection_resolves_without_position(tmp_path):
    engine, store = ready_engine(tmp_path, "live")
    engine.intents = {"EB1": {"symbol": "TEST", "tag": "EB1", "token": 1, "quantity": 10,
                              "entry": 100, "stop": 98, "target": 104, "strategy": "intraday",
                              "created_at": NOW.isoformat(), "state": "unknown", "pnl_accounted": 0}}
    engine.account["orders"] = [{"order_id": "1", "tag": "EB1", "variety": "co", "transaction_type": "BUY", "exchange": "NSE", "tradingsymbol": "TEST", "product": "MIS", "quantity": 10,
                                 "filled_quantity": 0, "status": "REJECTED"}]
    with patch("app.trading.now_ist", return_value=NOW):
        asyncio.run(engine._reconcile_live_locked())
    assert engine.intents["EB1"]["state"] == "rejected" and not engine.positions


def test_historical_seed_discards_forming_future_and_invalid_candles(tmp_path):
    engine, store = ready_engine(tmp_path)
    engine.books[1] = CandleBook()
    rows = [{"date": NOW - timedelta(minutes=5), "open": 100, "high": 101, "low": 99, "close": 100, "volume": 1000},
            {"date": NOW, "open": 100, "high": 110, "low": 90, "close": 109, "volume": 9999},
            {"date": NOW - timedelta(minutes=10), "open": 100, "high": 99, "low": 98, "close": 100, "volume": 1}]
    engine._seed_intraday(1, rows, NOW)
    assert len(engine.books[1].bars) == 1
    assert engine.books[1].bars[0].time == NOW - timedelta(minutes=5)


def test_switching_to_paper_cannot_hide_unresolved_live_exposure(tmp_path):
    engine, store = ready_engine(tmp_path)
    store.set("bot_state_live", {"positions": {}, "intents": {"unknown": {"state": "unknown"}}})
    assert not engine.snapshot()["safe_to_stop"]
    assert engine.snapshot()["unmanaged_live_exposure"]


def test_maintenance_race_after_reconciliation_cannot_arm(tmp_path):
    engine, store = ready_engine(tmp_path)
    engine.running = False
    engine.broker = object()
    async def refresh():
        (tmp_path / "maintenance.lock").write_text("deploy")
    engine._refresh_account_locked = refresh
    with patch("app.trading.now_ist", return_value=NOW):
        try:
            asyncio.run(engine.start())
            assert False, "Start must fail if maintenance begins during reconciliation"
        except ValueError as exc:
            assert "maintenance" in str(exc)
    assert not engine.running


def test_saved_allocations_cannot_exceed_new_mode_capital(tmp_path):
    engine, store = ready_engine(tmp_path)
    engine.capital = 5000
    engine.broker = object()
    store.set("strategy_settings", {"intraday_enabled": True, "intraday_capital": 100000,
                                    "swing_enabled": False, "swing_capital": 0})
    try:
        asyncio.run(engine.start())
        assert False
    except ValueError as exc:
        assert "allocations" in str(exc)


def test_live_budget_excludes_collateral_and_existing_full_notional(tmp_path):
    engine, store = ready_engine(tmp_path, "live")
    engine.positions["OTHER"] = {"quantity": 100, "entry": 100, "last": 100, "stop": 98, "strategy": "intraday"}
    engine.account["margins"] = {"equity": {"net": 30000, "available": {"cash": 20000, "live_balance": 30000, "collateral": 20000}}}
    with patch("app.trading.now_ist", return_value=NOW):
        assert asyncio.run(engine._enter_locked(1, signal())) == "insufficient_risk_or_cash_budget"


def test_delivery_sync_uses_remaining_quantity_and_does_not_double_count_pnl(tmp_path):
    engine, store = ready_engine(tmp_path, "live")
    class DeliverySnapshot:
        def snapshot(self):
            return {"positions": {"TEST": {"source": "swing", "status": "protected", "symbol": "TEST",
                     "token": 1, "entry": 100, "last": 101, "quantity": 10, "remaining_quantity": 4,
                     "strategy": "swing", "stop": 95, "target": 110}},
                    "bot_realised_pnl": 100, "existing_holdings_realised_pnl": 5000, "blocked": False}
    engine.delivery = DeliverySnapshot()
    engine._sync_delivery()
    engine._sync_delivery()
    assert engine.realised == 100
    assert engine.positions["TEST"]["quantity"] == 4
    engine._persist()
    restored = TradingEngine(engine.settings, store)
    restored.delivery = DeliverySnapshot()
    restored._sync_delivery()
    assert restored.realised == 100


def test_analytics_queue_keeps_latest_and_discards_previous_generation(tmp_path):
    from app.strategy import Candle
    engine, store = ready_engine(tmp_path)
    bars = [Candle(NOW, 100, 101, 99, 100, 1000)]
    engine._queue_analysis(1, "swing", bars)
    engine._queue_analysis(1, "swing", bars)
    assert len(engine._analysis_pending) == 1
    class Finished:
        def cancelled(self): return False
        def result(self):
            return [{"token": 1, "strategy": "swing", "generation": -1}]
    engine._analysis_finished(Finished())
    assert not engine.signals and not engine._analysis_cache


def test_paper_existing_holdings_sell_requires_selection_and_never_changes_account(tmp_path):
    from app.strategy import Candle
    engine, store = ready_engine(tmp_path)
    engine.account["holdings"] = [{"exchange": "NSE", "tradingsymbol": "TEST", "quantity": 10, "instrument_token": 1}]
    engine.daily[1] = [Candle(NOW - timedelta(days=21 - i), 100, 101, 99, 100, 1000) for i in range(21)]
    engine._analysis_cache[("swing", 1)] = {"holding": {"trailing": 95, "trend_exit": True}}
    with patch("app.trading.now_ist", return_value=NOW):
        engine._analyze_holdings()
        assert not engine._paper_holding_actions
        store.set("strategy_settings", {"manage_existing_holdings": "selected", "managed_symbols": ["TEST"]})
        engine._analyze_holdings()
        engine._analyze_holdings()
    assert len(engine._paper_holding_actions) == 1
    assert engine.account["holdings"][0]["quantity"] == 10
    assert engine.realised == 0


def test_holdings_audit_records_quantity_changes_but_not_each_price_change(tmp_path):
    engine, store = ready_engine(tmp_path)
    class Broker:
        async def account(self): return deepcopy(engine.account)
    engine.broker = Broker()
    engine.account["holdings"] = [{"tradingsymbol": "TEST", "exchange": "NSE", "quantity": 10, "average_price": 100, "last_price": 101}]
    asyncio.run(engine._refresh_account_locked())
    engine.account["holdings"][0]["last_price"] = 102
    asyncio.run(engine._refresh_account_locked())
    assert sum(e["kind"] == "account_holdings" for e in store.log) == 1
    engine.account["holdings"][0]["quantity"] = 5
    asyncio.run(engine._refresh_account_locked())
    assert sum(e["kind"] == "account_holdings" for e in store.log) == 2


def test_definite_input_rejection_does_not_become_permanent_unknown_intent(tmp_path):
    from app.broker import BrokerError
    engine, store = ready_engine(tmp_path, "live")
    class Rejected:
        async def buy_cover(self, *args):
            raise BrokerError("InputException", "Trigger price outside permitted range")
    engine.broker = Rejected()
    with patch("app.trading.now_ist", return_value=NOW):
        assert asyncio.run(engine._enter_locked(1, signal())) == "cover_order_rejected"
    assert not engine._unresolved_intents()
    assert any(e["kind"] == "order_rejected" for e in store.log)


def test_flatten_closes_already_adopted_holdings_but_never_unselected_account_shares(tmp_path):
    engine, store = ready_engine(tmp_path, "live")
    engine.account["holdings"] = [{"tradingsymbol": "TEST", "quantity": 4}, {"tradingsymbol": "UNSELECTED", "quantity": 20}]
    class ManagedDelivery:
        calls = []
        def snapshot(self):
            return {"positions": {"TEST": {"source": "existing", "status": "protected", "symbol": "TEST", "token": 1,
                                             "remaining_quantity": 4}}, "blocked": False, "bot_realised_pnl": 0}
        async def cancel_pending_entries(self): pass
        async def request_exit(self, symbol, quantity, price, reason):
            self.calls.append((symbol, quantity))
            return {"status": "requested"}
    engine.delivery = ManagedDelivery()
    async def refresh(): pass
    engine._refresh_account_locked = refresh
    with patch("app.trading.now_ist", return_value=NOW):
        asyncio.run(engine.flatten())
    assert engine.delivery.calls == [("TEST", 4)]
    assert engine.account["holdings"][1]["quantity"] == 20


class RecoveryBroker:
    def __init__(self):
        self.calls = []
        self.history = {}
        self.current = {"orders": [], "trades": [], "holdings": [], "positions": {"net": []},
                        "margins": {"equity": {"available": {"cash": 90000, "live_balance": 90000}}}}
        self.profile_id = "AB1234"

    async def account(self):
        self.calls.append("account")
        return deepcopy(self.current)

    async def call(self, method, *args, **kwargs):
        self.calls.append(method)
        if method == "profile":
            return {"user_id": self.profile_id, "meta": {"demat_consent": "physical"}}
        if method == "instruments":
            return [{"instrument_token": 22, "exchange": "NSE", "segment": "NSE", "instrument_type": "EQ", "tradingsymbol": "TEST", "tick_size": .05}]
        if method == "order_history":
            return deepcopy(self.history.get(str(args[0]), []))
        if method in self.current:
            return deepcopy(self.current[method])
        if method == "historical_data":
            return []
        raise AssertionError(method)

    async def stream(self, tokens, ticks, orders, status):
        self.calls.append("stream")
        status(0, True, tokens)

    async def cancel_cover(self, order_id, parent_order_id=None):
        self.calls.append("cancel:" + order_id)

    def close(self):
        self.calls.append("close")


def save_cover_journal(store, at=NOW):
    intent = {"tag": "EB1", "symbol": "TEST", "token": 1, "strategy": "intraday", "quantity": 4,
              "entry": 100, "stop": 98, "target": 104, "created_at": at.isoformat(), "state": "unknown",
              "order_id": "parent", "filled": 0, "exit_requested": [], "pnl_accounted": 0.}
    store.set("bot_state_live", {"day": at.date().isoformat(), "intents": {"EB1": intent}})
    parent = {"order_id": "parent", "tag": "EB1", "variety": "co", "transaction_type": "BUY", "exchange": "NSE",
              "tradingsymbol": "TEST", "product": "MIS", "quantity": 4, "filled_quantity": 4,
              "average_price": 100, "status": "COMPLETE"}
    child = {"order_id": "child", "parent_order_id": "parent", "variety": "co", "transaction_type": "SELL",
             "exchange": "NSE", "tradingsymbol": "TEST", "product": "MIS", "quantity": 4,
             "filled_quantity": 0, "pending_quantity": 4, "trigger_price": 98, "status": "TRIGGER PENDING"}
    return parent, child


@pytest.mark.asyncio
async def test_real_sqlite_restart_finds_offline_cover_exit_in_history_and_refreshes_manual_account(tmp_path, monkeypatch):
    path = tmp_path / "recovery.sqlite"
    store = Store(path)
    broker = RecoveryBroker()
    parent, child = save_cover_journal(store)
    broker.current["orders"] = [parent, child]
    broker.current["positions"] = {"net": [{"exchange": "NSE", "tradingsymbol": "TEST", "product": "MIS", "quantity": 4}]}
    monkeypatch.setattr("app.trading.KiteBroker", lambda *a: broker)
    monkeypatch.setattr("app.trading.now_ist", lambda: NOW)
    original = TradingEngine(settings(tmp_path, "live"), store)
    await original.connect("first-session", "AB1234")
    await original._stop_tasks()
    assert original.positions["TEST"]["token"] == 22
    assert original.recovery["phase"] == "warming_up"
    await original.shutdown()
    store.close()
    # While offline, the stop filled and a manual holding/cash balance changed.
    broker.current["orders"] = []
    broker.current["positions"] = {"net": []}
    broker.current["holdings"] = [{"exchange": "NSE", "tradingsymbol": "MANUAL", "quantity": 12}]
    broker.current["margins"]["equity"]["available"]["cash"] = 87000
    broker.history["child"] = [{**child, "status": "COMPLETE", "filled_quantity": 4, "pending_quantity": 0, "average_price": 97}]
    store = Store(path)
    restarted = TradingEngine(settings(tmp_path, "live"), store)
    await restarted.connect("second-session", "AB1234")
    await restarted._stop_tasks()
    assert restarted.intents["EB1"]["state"] == "closed" and not restarted.positions
    assert restarted.realised < -12
    assert restarted.account["holdings"][0]["quantity"] == 12
    assert restarted.account["margins"]["equity"]["available"]["cash"] == 87000
    assert restarted.recovery["phase"] == "ready"
    assert broker.calls.index("profile") < broker.calls.index("account") < broker.calls.index("stream")
    assert not any(call.startswith("cancel:") for call in broker.calls)
    realised = restarted.realised
    await restarted.start()
    assert restarted.realised == realised
    await restarted.shutdown()
    store.close()


@pytest.mark.asyncio
async def test_restart_never_infers_fill_from_missing_order_or_overwrites_reconciliation_error(tmp_path, monkeypatch):
    store = Store(tmp_path / "unknown.sqlite")
    save_cover_journal(store, NOW - timedelta(days=1))
    broker = RecoveryBroker()
    monkeypatch.setattr("app.trading.KiteBroker", lambda *a: broker)
    monkeypatch.setattr("app.trading.now_ist", lambda: NOW)
    engine = TradingEngine(settings(tmp_path, "live"), store)
    await engine.connect("session", "AB1234")
    await engine._stop_tasks()
    assert engine.status == "error" and engine.error
    assert engine.recovery["phase"] == "blocked"
    with pytest.raises(ValueError, match="unresolved"):
        await engine.start()
    assert not engine.running and engine.intents["EB1"]["state"] == "unknown"
    assert not any(call.startswith("cancel:") for call in broker.calls)
    await engine.shutdown()
    store.close()


@pytest.mark.asyncio
async def test_restart_rejects_wrong_profile_before_any_account_or_order_work(tmp_path, monkeypatch):
    store = Store(tmp_path / "wrong-profile.sqlite")
    broker = RecoveryBroker()
    broker.profile_id = "ZZ9999"
    monkeypatch.setattr("app.trading.KiteBroker", lambda *a: broker)
    engine = TradingEngine(settings(tmp_path), store)
    with pytest.raises(ValueError, match="Connection setup failed"):
        await engine.connect("session", "AB1234")
    assert "account" not in broker.calls and not engine.connected
    assert engine.recovery["phase"] == "blocked"
    await engine.shutdown()
    store.close()


@pytest.mark.asyncio
async def test_overdue_paper_position_exits_after_restart_only_at_fresh_current_session_price(tmp_path, monkeypatch):
    store = Store(tmp_path / "paper-recovery.sqlite")
    store.set("bot_state_paper", {"day": (NOW - timedelta(days=1)).date().isoformat(), "positions": {"TEST": {
        "symbol": "TEST", "token": 1, "strategy": "intraday", "quantity": 4, "entry": 100, "last": 100,
        "stop": 98, "target": 104, "opened_at": (NOW - timedelta(days=1)).isoformat()}}})
    broker = RecoveryBroker()
    monkeypatch.setattr("app.trading.KiteBroker", lambda *a: broker)
    monkeypatch.setattr("app.trading.now_ist", lambda: NOW)
    engine = TradingEngine(settings(tmp_path), store)
    await engine.connect("session", "AB1234")
    await engine._stop_tasks()
    await engine.start()
    assert engine.recovery["blocked"] and "TEST" in engine.positions
    assert await engine._enter_locked(22, signal()) == "recovery_incomplete"
    engine._on_ticks([{"instrument_token": 22, "exchange_timestamp": NOW, "last_price": 90, "volume_traded": 1000,
                       "depth": {"buy": [{"price": 89.95, "quantity": 100}], "sell": [{"price": 90.05, "quantity": 100}]}}])
    task = asyncio.create_task(engine._run())
    await asyncio.sleep(.02)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert not engine.positions and engine.realised < -40
    exits = [e for e in store.events() if e["kind"] == "paper_fill"]
    assert exits[-1]["data"]["reason"] == "overdue_intraday_exit"
    await engine.shutdown()
    store.close()


def test_recovery_ready_recomputes_current_bars_and_stream_loss_gates_managed_risk(tmp_path):
    from app.strategy import Candle
    engine, store = ready_engine(tmp_path)
    engine.books[1] = CandleBook()
    engine.books[1].bars.append(Candle(NOW - timedelta(minutes=5), 100, 101, 99, 100, 1000))
    engine._candidate(1, signal())
    previous_generation = engine._analysis_generation
    engine.recovery.update(phase="warming_up", blocked=True)
    with patch("app.trading.now_ist", return_value=NOW):
        engine._advance_recovery()
    assert not engine._candidates and engine._analysis_generation > previous_generation
    assert ("intraday", 1) in engine._analysis_pending
    engine.positions["TEST"] = {"symbol": "TEST", "token": 1, "strategy": "intraday", "entry": 100, "quantity": 1, "stop": 98}
    engine._on_stream(0, False, [1])
    engine._advance_recovery()
    assert engine.recovery["blocked"] and not engine._analysis_pending


@pytest.mark.asyncio
async def test_new_day_rollover_does_not_swallow_newly_reconciled_loss(tmp_path, monkeypatch):
    engine, store = ready_engine(tmp_path, "live")
    engine.day = (NOW - timedelta(days=1)).date().isoformat()
    engine.broker = object()
    engine.realised = 100
    async def refresh():
        engine.realised -= 2000
        engine._recovery_account_verified = True
    engine._refresh_account_locked = refresh
    monkeypatch.setattr("app.trading.now_ist", lambda: NOW)
    with pytest.raises(ValueError, match="daily loss"):
        await engine.start()
    assert engine.day_baseline == 100 and engine._daily_pnl() == -2000 and not engine.running
