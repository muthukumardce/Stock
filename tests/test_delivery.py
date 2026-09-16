from copy import deepcopy
from datetime import datetime, timedelta
from types import SimpleNamespace
from time import monotonic

import pytest

from app.delivery import DeliveryManager, IST
from app.storage import Store
from app.strategy import Candle


class FakeBroker:
    """Deterministic OMS/GTT simulation; never opens a network connection."""

    def __init__(self, now):
        self.now = now
        self.rows, self.holdings, self.gtts, self.calls = [], [], {}, []
        self.consent = "physical"
        self.buy_fill = None
        self.sell_fill = None
        self.entry_open = False
        self.timeout_order_before = False
        self.timeout_order_after = False
        self.timeout_gtt_after = False
        self.timeout_gtt_before = False
        self.timeout_delete = False
        self.delete_race = None
        self.stale_quote = False
        self.no_bid = False
        self.quote_price = 100.0

    def add_order(self, payload, fill, status):
        row = {**deepcopy(payload), "order_id": str(len(self.rows) + 1), "status": status,
               "filled_quantity": fill, "pending_quantity": payload["quantity"] - fill,
               "average_price": payload.get("price", 100.0) if fill else 0}
        self.rows.append(row)
        if payload["transaction_type"] == "SELL":
            for h in self.holdings:
                if h["tradingsymbol"] == payload["tradingsymbol"]:
                    h["used_quantity"] = h.get("used_quantity", 0) + fill
        return row

    async def call(self, method, *args, **kwargs):
        self.calls.append((method, deepcopy(kwargs)))
        if method == "profile":
            return {"meta": {"demat_consent": self.consent}}
        if method == "orders":
            return deepcopy(self.rows)
        if method == "holdings":
            return deepcopy(self.holdings)
        if method == "positions":
            return {"net": [{"tradingsymbol": symbol, "exchange": "NSE", "product": "CNC",
                              "quantity": sum((1 if r["transaction_type"] == "BUY" else -1) * r["filled_quantity"]
                                              for r in self.rows if r["tradingsymbol"] == symbol)}
                             for symbol in {r["tradingsymbol"] for r in self.rows}]}
        if method == "get_gtts":
            return deepcopy(list(self.gtts.values()))
        if method == "get_gtt":
            return deepcopy(self.gtts[str(args[0])])
        if method == "quote":
            return {symbol: {"timestamp": self.now - timedelta(minutes=5) if self.stale_quote else self.now,
                             "last_price": self.quote_price,
                             "depth": {"buy": [] if self.no_bid else [{"price": self.quote_price - 0.05, "quantity": 1000}]}}
                    for symbol in args[0]}
        if method == "place_order":
            if self.timeout_order_before:
                raise TimeoutError("not known to have reached OMS")
            partial = self.buy_fill if kwargs["transaction_type"] == "BUY" else self.sell_fill
            fill = kwargs["quantity"] if partial is None else min(partial, kwargs["quantity"])
            status = "COMPLETE" if fill == kwargs["quantity"] else "CANCELLED"
            if self.entry_open and kwargs["transaction_type"] == "BUY":
                status = "OPEN"
            row = self.add_order(kwargs, fill, status)
            if self.timeout_order_after:
                raise TimeoutError("accepted but response lost")
            return row["order_id"]
        if method == "order_history":
            return deepcopy([r for r in self.rows if r["order_id"] == str(args[0])])
        if method == "place_gtt":
            if self.timeout_gtt_before:
                raise TimeoutError("uncertain GTT")
            gid = str(len(self.gtts) + 1)
            self.gtts[gid] = {"id": int(gid), "type": kwargs["trigger_type"], "status": "active",
                              "condition": {k: deepcopy(kwargs[k]) for k in ("exchange", "tradingsymbol", "trigger_values", "last_price")},
                              "orders": [dict(o, result=None) for o in deepcopy(kwargs["orders"])]}
            if self.timeout_gtt_after:
                raise TimeoutError("accepted GTT response lost")
            return {"trigger_id": int(gid)}
        if method == "delete_gtt":
            if self.timeout_delete:
                raise TimeoutError("cancellation uncertain")
            gtt = self.gtts[str(args[0])]
            if self.delete_race:
                status, fill = self.delete_race
                gtt["status"] = "triggered"
                order = self.add_order(gtt["orders"][0], fill, status)
                gtt["orders"][0]["result"] = {"order_result": {"status": "success", "order_id": order["order_id"]}}
            else:
                gtt["status"] = "deleted"
            return {"trigger_id": int(args[0])}
        if method == "cancel_order":
            row = next(r for r in self.rows if r["order_id"] == kwargs["order_id"])
            row["status"] = "CANCELLED"
            return row["order_id"]
        raise AssertionError(f"Unexpected broker method: {method}")


@pytest.fixture
def context(tmp_path):
    now = datetime.now(IST).replace(hour=10, minute=0, second=0, microsecond=0)
    while now.weekday() > 4:
        now -= timedelta(days=1)
    broker = FakeBroker(now)
    store = Store(tmp_path / "state.sqlite")
    store.set("strategy_settings", {"swing_enabled": True, "swing_capital": 100000,
                                    "manage_existing_holdings": "selected", "managed_symbols": []})
    settings = SimpleNamespace(trading_mode="live", live_trading_enabled=True, data_dir=tmp_path)
    manager = DeliveryManager(store, broker, settings, now=lambda: now)
    yield manager, broker, store, settings
    store.close()


def mutations(broker, name):
    return [kw for method, kw in broker.calls if method == name]


async def enter(manager):
    return await manager.submit_entry("INFY", 10, 100, 95, 110, token=123)


@pytest.mark.asyncio
async def test_confirmed_partial_ioc_fill_is_only_quantity_protected(context):
    manager, broker, _, _ = context
    broker.buy_fill = 4
    result = await enter(manager)
    assert result["status"] == "protected"
    assert mutations(broker, "place_order")[0]["validity"] == "IOC"
    assert [o["quantity"] for o in mutations(broker, "place_gtt")[0]["orders"]] == [4, 4]
    p = manager.snapshot()["positions"]["INFY"]
    assert p["quantity"] == p["remaining_quantity"] == 4
    assert p["token"] == 123 and p["is_bot_owned"]


@pytest.mark.asyncio
async def test_timeout_accepted_entry_is_found_by_tag_without_duplicate(context):
    manager, broker, store, settings = context
    broker.timeout_order_after = True
    result = await enter(manager)
    assert result["status"] == "protected"
    restarted = DeliveryManager(store, broker, settings, now=lambda: broker.now)
    await restarted.reconcile()
    await enter(restarted)
    assert len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_unknown_entry_stays_blocked_across_restart_and_pause(context):
    manager, broker, store, settings = context
    broker.timeout_order_before = True
    assert (await enter(manager))["blocked"]
    restarted = DeliveryManager(store, broker, settings, now=lambda: broker.now)
    assert (await restarted.reconcile())["blocked"]
    assert (await restarted.cancel_pending_entries())["blocked"]
    await enter(restarted)
    assert len(mutations(broker, "place_order")) == 1
    assert mutations(broker, "place_gtt") == []


@pytest.mark.asyncio
async def test_timeout_gtt_adopts_only_new_matching_trigger_after_restart(context):
    manager, broker, store, settings = context
    broker.timeout_gtt_after = True
    assert (await enter(manager))["blocked"]
    restarted = DeliveryManager(store, broker, settings, now=lambda: broker.now)
    assert not (await restarted.reconcile())["blocked"]
    assert len(mutations(broker, "place_gtt")) == 1
    assert restarted.snapshot()["positions"]["INFY"]["gtt_id"] == "1"


@pytest.mark.asyncio
async def test_ambiguous_gtt_never_retries_or_places_unprotected_exit(context):
    manager, broker, _, _ = context
    broker.timeout_gtt_before = True
    await enter(manager)
    await manager.reconcile()
    result = await manager.request_exit("INFY", 10, 99)
    assert result["blocked"]
    assert len(mutations(broker, "place_gtt")) == 1
    assert len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_cancel_trigger_race_open_exchange_order_blocks_second_sell(context):
    manager, broker, _, _ = context
    await enter(manager)
    broker.delete_race = ("OPEN", 3)
    result = await manager.request_exit("INFY", 10, 99)
    assert result["status"] == "exit_pending" and result["blocked"]
    assert len(mutations(broker, "place_order")) == 1
    assert manager.snapshot()["positions"]["INFY"]["gtt_filled_quantity"] == 3
    await manager.request_exit("INFY", 10, 99)
    assert len(mutations(broker, "delete_gtt")) == 1
    assert len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_cancel_trigger_race_complete_order_causes_no_second_sell(context):
    manager, broker, _, _ = context
    await enter(manager)
    broker.delete_race = ("COMPLETE", 10)
    result = await manager.request_exit("INFY", 10, 99)
    assert result["status"] == "closed"
    assert len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_cancel_trigger_race_terminal_partial_sells_only_residual(context):
    manager, broker, _, _ = context
    await enter(manager)
    broker.delete_race = ("CANCELLED", 3)
    result = await manager.request_exit("INFY", 10, 99)
    assert result["status"] == "closed"
    assert mutations(broker, "place_order")[-1]["quantity"] == 7
    assert manager.snapshot()["positions"]["INFY"]["sold_quantity"] == 10


@pytest.mark.asyncio
async def test_unknown_delete_never_resubmits_delete_or_places_sell(context):
    manager, broker, _, _ = context
    await enter(manager)
    broker.timeout_delete = True
    assert (await manager.request_exit("INFY", 10, 99))["blocked"]
    assert (await manager.request_exit("INFY", 10, 99))["blocked"]
    assert len(mutations(broker, "delete_gtt")) == 1
    assert len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_explicit_partial_exit_retries_only_confirmed_residual(context):
    manager, broker, _, _ = context
    await enter(manager)
    broker.sell_fill = 4
    result = await manager.request_exit("INFY", 10, 99)
    assert result["status"] == "exit_pending"
    assert manager.snapshot()["positions"]["INFY"]["remaining_quantity"] == 6
    broker.sell_fill = None
    result = await manager.request_exit("INFY", 10, 99)
    assert result["status"] == "closed"
    assert mutations(broker, "place_order")[-1]["quantity"] == 6
    assert len(mutations(broker, "place_gtt")) == 1


@pytest.mark.asyncio
async def test_pending_entry_cancel_reconciles_fills_then_protects(context):
    manager, broker, _, _ = context
    broker.entry_open, broker.buy_fill = True, 3
    assert (await enter(manager))["status"] == "entry_pending"
    assert mutations(broker, "place_gtt") == []
    result = await manager.cancel_pending_entries()
    assert not result["blocked"]
    assert mutations(broker, "place_gtt")[0]["orders"][0]["quantity"] == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("consent", ["", "consent", "ddpi", None])
async def test_unverified_dematerialisation_authority_blocks_entry(context, consent):
    manager, broker, _, _ = context
    broker.consent = consent
    assert (await enter(manager))["blocked"]
    assert mutations(broker, "place_order") == []


@pytest.mark.asyncio
async def test_live_maintenance_allocation_and_stale_quote_gates(context):
    manager, broker, store, settings = context
    settings.live_trading_enabled = False
    assert (await enter(manager))["blocked"]
    settings.live_trading_enabled = True
    (settings.data_dir / "maintenance.lock").touch()
    assert (await enter(manager))["blocked"]
    (settings.data_dir / "maintenance.lock").unlink()
    store.set("strategy_settings", {"swing_enabled": True, "swing_capital": 100})
    assert (await enter(manager))["blocked"]
    store.set("strategy_settings", {"swing_enabled": True, "swing_capital": 100000})
    broker.stale_quote = True
    assert (await enter(manager))["blocked"]
    assert mutations(broker, "place_order") == []


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["stale", "no_bid", "closed_session", "consent"])
async def test_invalid_exit_preflight_leaves_gtt_intact(context, reason):
    manager, broker, _, _ = context
    await enter(manager)
    if reason == "stale":
        broker.stale_quote = True
    elif reason == "no_bid":
        broker.no_bid = True
    elif reason == "closed_session":
        manager.now = lambda: broker.now.replace(hour=18)
    else:
        broker.consent = "consent"
    assert (await manager.request_exit("INFY", 10, 99))["blocked"]
    assert mutations(broker, "delete_gtt") == []
    assert len(mutations(broker, "place_order")) == 1


def daily_bars(falling=False):
    dates = []
    at = datetime.now(IST).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
    while len(dates) < 30:
        if at.weekday() < 5:
            dates.append(at)
        at -= timedelta(days=1)
    dates.reverse()
    values = [100 + n * 0.5 for n in range(30)]
    if falling:
        values[-5:] = [105, 104, 103, 102, 101]
    return [Candle(at, close - 0.5, close + 1, close - 1, close, 1000) for at, close in zip(dates, values)]


@pytest.mark.asyncio
async def test_existing_selected_holding_management_excludes_unselected_and_pledged(context):
    manager, broker, _, _ = context
    broker.quote_price = 115
    broker.holdings = [{"tradingsymbol": s, "exchange": "NSE", "quantity": 10,
                        "used_quantity": 1, "collateral_quantity": 2, "product": "CNC",
                        "average_price": 100, "instrument_token": 123} for s in ("INFY", "TCS")]
    result = await manager.evaluate_holdings({"INFY": daily_bars(), "TCS": daily_bars()},
                                            {"manage_existing_holdings": "selected", "managed_symbols": ["INFY"]})
    assert not result["blocked"]
    snap = manager.snapshot()
    assert set(snap["positions"]) == {"INFY"}
    assert snap["positions"]["INFY"]["quantity"] == 7
    assert not snap["positions"]["INFY"]["is_bot_owned"]
    assert mutations(broker, "place_order") == []
    assert mutations(broker, "place_gtt")[0]["orders"][0]["quantity"] == 7


@pytest.mark.asyncio
async def test_existing_daily_trend_exit_sells_without_new_swing_allocation(context):
    manager, broker, store, _ = context
    broker.holdings = [{"tradingsymbol": "INFY", "exchange": "NSE", "quantity": 5,
                        "product": "CNC", "average_price": 110}]
    store.set("strategy_settings", {"swing_enabled": False, "swing_capital": 0})
    result = await manager.evaluate_holdings({"INFY": daily_bars(falling=True)}, {"manage_existing_holdings": "all"})
    assert not result["blocked"]
    assert mutations(broker, "place_order")[0]["transaction_type"] == "SELL"
    assert mutations(broker, "place_order")[0]["quantity"] == 5
    assert manager.snapshot()["positions"]["INFY"]["status"] == "closed"


@pytest.mark.asyncio
async def test_external_active_gtt_prevents_automatic_existing_holding_adoption(context):
    manager, broker, _, _ = context
    broker.holdings = [{"tradingsymbol": "INFY", "exchange": "NSE", "quantity": 5, "product": "CNC"}]
    broker.gtts["999"] = {"id": 999, "status": "active", "condition": {"tradingsymbol": "INFY", "exchange": "NSE"}}
    result = await manager.evaluate_holdings({"INFY": daily_bars(falling=True)}, {"manage_existing_holdings": "all"})
    assert result["blocked"]
    assert manager.snapshot()["positions"] == {}
    assert mutations(broker, "place_order") == []


@pytest.mark.asyncio
async def test_changed_gtt_or_external_quantity_reduction_blocks_new_entries(context):
    manager, broker, _, _ = context
    await enter(manager)
    broker.gtts["1"]["orders"][0]["quantity"] = 20
    assert (await manager.reconcile())["blocked"]
    assert (await manager.submit_entry("TCS", 10, 100, 95, 110))["blocked"]
    assert len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_zero_fill_creates_no_protection(context):
    manager, broker, _, _ = context
    broker.buy_fill = 0
    assert (await enter(manager))["status"] == "closed"
    assert mutations(broker, "place_gtt") == []


@pytest.mark.asyncio
async def test_open_partial_entry_exposure_is_visible_before_protection(context):
    manager, broker, _, _ = context
    broker.entry_open, broker.buy_fill = True, 4
    assert (await enter(manager))["blocked"]
    assert manager.snapshot()["positions"]["INFY"]["remaining_quantity"] == 4
    assert mutations(broker, "place_gtt") == []


@pytest.mark.asyncio
async def test_multiple_matching_gtts_after_lost_response_are_ambiguous(context):
    manager, broker, _, _ = context
    broker.timeout_gtt_after = True
    await enter(manager)
    broker.gtts["2"] = dict(deepcopy(broker.gtts["1"]), id=2)
    assert (await manager.reconcile())["blocked"]
    assert (await manager.request_exit("INFY", 10, 99))["blocked"]
    assert len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_another_active_gtt_blocks_exit_even_after_own_gtt_deleted(context):
    manager, broker, _, _ = context
    await enter(manager)
    broker.gtts["2"] = dict(deepcopy(broker.gtts["1"]), id=2)
    assert (await manager.reconcile())["blocked"]
    assert (await manager.request_exit("INFY", 10, 99))["blocked"]
    assert len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_pending_partial_exit_shows_remaining_exposure_without_resubmit(context):
    manager, broker, _, _ = context
    await enter(manager)
    broker.timeout_order_before = True
    await manager.request_exit("INFY", 10, 99)
    pending = mutations(broker, "place_order")[-1]
    broker.add_order(pending, 3, "OPEN")
    assert (await manager.reconcile())["blocked"]
    assert manager.snapshot()["positions"]["INFY"]["remaining_quantity"] == 7
    await manager.request_exit("INFY", 10, 99)
    assert len(mutations(broker, "place_order")) == 2


@pytest.mark.asyncio
async def test_existing_holdings_pnl_is_separate_from_allocated_bot_capital(context):
    manager, broker, _, _ = context
    broker.holdings = [{"tradingsymbol": "INFY", "exchange": "NSE", "quantity": 5,
                        "product": "CNC", "average_price": 110}]
    await manager.evaluate_holdings({"INFY": daily_bars(falling=True)}, {"manage_existing_holdings": "all"})
    snap = manager.snapshot()
    assert snap["bot_realised_pnl"] == 0
    assert snap["existing_holdings_realised_pnl"] < 0
    assert snap["realised_pnl"] == snap["existing_holdings_realised_pnl"]


@pytest.mark.asyncio
async def test_settled_old_gtt_does_not_block_reentry_and_pnl_is_archived(context):
    manager, broker, _, _ = context
    await enter(manager)
    broker.delete_race = ("COMPLETE", 10)
    await manager.request_exit("INFY", 10, 99)
    old_pnl = manager.snapshot()["bot_realised_pnl"]
    assert old_pnl < 0
    result = await enter(manager)
    assert result["status"] == "protected"
    assert manager.snapshot()["bot_realised_pnl"] == old_pnl
    assert len(mutations(broker, "place_order")) == 2


@pytest.mark.asyncio
async def test_paused_management_exits_prior_holding_without_adopting_new_holding(context):
    manager, broker, _, _ = context
    broker.quote_price = 115
    broker.holdings = [{"tradingsymbol": "INFY", "exchange": "NSE", "quantity": 5,
                        "product": "CNC", "average_price": 100}]
    permissions = {"manage_existing_holdings": "all"}
    await manager.evaluate_holdings({"INFY": daily_bars()}, permissions)
    assert manager.snapshot()["positions"]["INFY"]["status"] == "protected"
    broker.holdings.append({"tradingsymbol": "TCS", "exchange": "NSE", "quantity": 5,
                            "product": "CNC", "average_price": 100})
    result = await manager.evaluate_holdings({"INFY": daily_bars(falling=True), "TCS": daily_bars(falling=True)},
                                            permissions, adopt_new=False)
    assert not result["blocked"]
    assert set(manager.snapshot()["positions"]) == {"INFY"}
    assert manager.snapshot()["positions"]["INFY"]["status"] == "closed"
    assert mutations(broker, "place_order")[0]["tradingsymbol"] == "INFY"
    assert len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_snapshot_estimates_fees_only_for_remaining_bot_quantity(context):
    manager, broker, _, _ = context
    await enter(manager)
    assert manager.snapshot()["positions"]["INFY"]["entry_fee"] == pytest.approx(1.0)
    broker.sell_fill = 4
    await manager.request_exit("INFY", 10, 99)
    assert manager.snapshot()["positions"]["INFY"]["entry_fee"] == pytest.approx(0.6)
    broker.quote_price = 115
    broker.holdings = [{"tradingsymbol": "TCS", "exchange": "NSE", "quantity": 5,
                        "product": "CNC", "average_price": 100}]
    await manager.evaluate_holdings({"TCS": daily_bars()}, {"manage_existing_holdings": "all"})
    assert manager.snapshot()["positions"]["TCS"]["entry_fee"] == 0


@pytest.mark.asyncio
async def test_fresh_stream_quote_hint_avoids_rest_evaluation_quote(context):
    manager, broker, _, _ = context
    await enter(manager)
    before = len(mutations(broker, "quote"))
    hint = {"exchange_timestamp": broker.now, "received_at": monotonic(), "last_price": 115}
    await manager.evaluate_holdings({"INFY": daily_bars()}, {}, {"INFY": hint}, adopt_new=False)
    assert len(mutations(broker, "quote")) == before
    hint["received_at"] -= 60
    await manager.evaluate_holdings({"INFY": daily_bars()}, {}, {"INFY": hint}, adopt_new=False)
    assert len(mutations(broker, "quote")) > before


@pytest.mark.asyncio
async def test_restart_after_manual_offline_sale_never_creates_stale_quantity_gtt(context):
    manager, broker, store, settings = context
    await enter(manager)
    p = manager.state["positions"]["INFY"]
    # Simulate persisted entry fill followed by shutdown before protection intent.
    manager.state["intents"].pop(p.pop("gtt_intent"))
    p.pop("gtt_id")
    manager._save()
    broker.gtts.clear()
    broker.add_order({"exchange": "NSE", "tradingsymbol": "INFY", "product": "CNC",
                      "transaction_type": "SELL", "quantity": 10, "price": 99}, 10, "COMPLETE")
    before = len(mutations(broker, "place_gtt"))
    restarted = DeliveryManager(store, broker, settings, now=lambda: broker.now)
    result = await restarted.reconcile()
    assert result["blocked"] and "quantity changed while offline" in result["reason"]
    assert len(mutations(broker, "place_gtt")) == before
    assert len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_restart_adopts_lost_gtt_acknowledgement_and_confirms_its_offline_fill(context):
    manager, broker, store, settings = context
    broker.timeout_gtt_after = True
    await enter(manager)
    assert not manager.state["positions"]["INFY"].get("gtt_id")
    gtt = broker.gtts["1"]
    gtt["status"] = "triggered"
    order = broker.add_order(gtt["orders"][0], 10, "COMPLETE")
    gtt["orders"][0]["result"] = {"order_result": {"status": "success", "order_id": order["order_id"]}}
    restarted = DeliveryManager(store, broker, settings, now=lambda: broker.now)
    result = await restarted.reconcile()
    assert not result["blocked"] and restarted.snapshot()["positions"]["INFY"]["status"] == "closed"
    assert len(mutations(broker, "place_gtt")) == 1 and len(mutations(broker, "place_order")) == 1


@pytest.mark.asyncio
async def test_holdings_recovery_reports_only_symbols_with_completed_current_evaluation(context):
    manager, broker, _, _ = context
    await enter(manager)
    result = await manager.evaluate_holdings({"INFY": []}, {}, adopt_new=False)
    assert result["evaluated_symbols"] == []
    broker.stale_quote = True
    result = await manager.evaluate_holdings({"INFY": daily_bars()}, {}, adopt_new=False)
    assert result["blocked"] and result["evaluated_symbols"] == []
    broker.stale_quote = False
    broker.quote_price = 115
    result = await manager.evaluate_holdings({"INFY": daily_bars()}, {}, adopt_new=False)
    assert result["evaluated_symbols"] == ["INFY"]
