"""Persistent scanner, paper execution, and broker-protected live intraday trading.

Live orders use Cover Orders only. A timed-out submission is an UNKNOWN intent
and is never resent. Reconciliation discovers its tag or leaves entries blocked.
Live swing uses a separate delivery lifecycle with verified demat authorisation
and broker GTT protection for confirmed fills.
"""
from __future__ import annotations

import asyncio
from collections import Counter, deque
from dataclasses import asdict
from datetime import datetime, timedelta
import math
import time
import uuid

from .broker import BrokerError, KiteBroker, jsonable
from .analytics import AnalyticsPool
from .delivery import DeliveryManager
from .strategy import Candle, CandleBook, IST, Signal, position_size

TERMINAL = {"COMPLETE", "CANCELLED", "REJECTED"}
FEE_RATE = 0.001  # Conservative simulation allowance, not a tax/fee quotation.


def now_ist():
    return datetime.now(IST)


def market_hours(now=None):
    now = now or now_ist()
    return now.weekday() < 5 and "09:15" <= now.strftime("%H:%M") < "15:30"


def parse_time(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=IST) if value.tzinfo is None else value.astimezone(IST)
    if isinstance(value, str):
        try:
            return parse_time(datetime.fromisoformat(value))
        except ValueError:
            return None
    return None


class TradingEngine:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store
        self.mode = settings.trading_mode
        self.capital = settings.live_capital if self.mode == "live" else settings.paper_capital
        self.state_key = "bot_state_" + self.mode
        saved = store.get(self.state_key, {})
        self.positions = saved.get("positions", {})
        self.intents = saved.get("intents", {})
        self.realised = float(saved.get("realised", 0))
        self.day = saved.get("day", now_ist().date().isoformat())
        self.day_baseline = float(saved.get("day_baseline", self.realised))
        self.day_open_unrealised = float(saved.get("day_open_unrealised", 0))
        self.traded = set(saved.get("traded", []))
        self.user_id = saved.get("user_id", "")
        self.connected = False
        self.status = "disconnected"
        self.message = "Connect Zerodha to start the market feed and account monitoring."
        self.error = None
        self.running = False
        self.broker = None
        self.delivery = DeliveryManager(store, None, settings=settings) if self.mode == "live" else None
        self._delivery_accounted = float(saved.get("delivery_accounted", 0))
        self.universe = {}
        self.books = {}
        self.quotes = {}
        self.streams = {}
        self.account = store.get("account_snapshot", {"margins": {}, "holdings": [], "positions": {}, "orders": [], "trades": []})
        self._account_at = 0.0
        self._heartbeat = None
        self._tasks = []
        self._lock = asyncio.Lock()
        self._candidates = deque(maxlen=200)
        self.signals = deque(maxlen=60)
        self._stats = Counter()
        self._last_summary = 0.0
        self._last_persist = 0.0
        self._reconcile_requested = asyncio.Event()
        self._order_seen = {}
        self._trade_seen = set()
        self._position_seen = None
        self._holdings_seen = None
        self._balance_seen = None
        self._balance_logged_at = 0.0
        self.daily = {}
        self._daily_checked = set()
        self._history_date = ""
        self._history_failures = 0
        self._shutdown = False
        self._last_tick_received = 0.0
        self._risk_halted = False
        self.holdings_signals = []
        self._paper_holding_actions = store.get("paper_holding_actions", {})
        self._last_holdings_scan = 0.0
        self._intraday_history_loaded = set()
        self._intraday_history_failed = 0
        self.analytics = AnalyticsPool(getattr(settings, "analytics_workers", 0),
                                       getattr(settings, "analytics_reserve_cpus", 4),
                                       getattr(settings, "analytics_batch_size", 32))
        self._analysis_pending = {}
        self._analysis_tasks = set()
        self._analysis_cache = {}
        self._analysis_generation = 0
        self._profile_verified = False
        self._recovery_account_verified = False
        self._recovery_holdings_checked = False
        self.recovery = {"phase": "awaiting_session", "message": "Sign in to Zerodha to verify the current account before trading.",
                         "started_at": None, "completed_at": None, "blocked": True}

    def strategy_settings(self):
        return self.store.get("strategy_settings", {
            "intraday_enabled": True, "swing_enabled": False,
            "intraday_capital": self.capital, "swing_capital": 0.0})

    def _event(self, kind, message, data=None, level="info"):
        return self.store.event(kind, message, jsonable(data), level=level)

    def _persist(self):
        self.store.set(self.state_key, jsonable({"positions": self.positions,
                       "intents": self.intents, "realised": self.realised, "day": self.day,
                       "day_baseline": self.day_baseline, "day_open_unrealised": self.day_open_unrealised,
                       "traded": sorted(self.traded), "user_id": self.user_id,
                       "delivery_accounted": self._delivery_accounted}))

    def _halt(self, message, kind="risk_halt"):
        if self.error != message:
            self._event(kind, message, level="error")
        self.running = False
        self.status = "error"
        self.error = self.message = message
        if self._unresolved_intents():
            self.recovery.update(phase="blocked", message=message, blocked=True, completed_at=None)

    def _maintenance(self):
        return (self.settings.data_dir / "maintenance.lock").exists()

    def _other_mode_live_risk(self):
        if self.mode == "live":
            return False
        saved = self.store.get("bot_state_live", {})
        delivery = self.store.get("delivery_state", {})
        return (bool(saved.get("positions")) or
                any(i.get("state") not in {"closed", "rejected"} for i in saved.get("intents", {}).values()) or
                any(p.get("status") != "closed" for p in delivery.get("positions", {}).values()))

    def _invalidate_decisions(self):
        self._analysis_generation += 1
        self._analysis_pending.clear()
        self._analysis_cache.clear()
        self._daily_checked.clear()
        self._candidates.clear()

    def _begin_recovery(self):
        self._invalidate_decisions()
        self._recovery_account_verified = False
        self._recovery_holdings_checked = False
        self._last_holdings_scan = 0.0
        self.recovery = {"phase": "reconciling", "message": "Verifying current balances, holdings, positions, orders and protection with Zerodha.",
                         "started_at": now_ist().isoformat(), "completed_at": None, "blocked": True}

    def _managed_recovery_symbols(self):
        """Symbols whose current risk must be understood before another buy."""
        symbols = {symbol: p.get("strategy") == "swing" for symbol, p in self.positions.items()}
        if self.delivery:
            for symbol, p in self.delivery.snapshot().get("positions", {}).items():
                if p.get("status") != "closed":
                    symbols[symbol] = True
        config = self.strategy_settings()
        if self.running:
            selected = set(config.get("managed_symbols", []))
            for holding in self.account.get("holdings", []):
                symbol = holding.get("tradingsymbol")
                if (holding.get("exchange") == "NSE" and holding.get("product", "CNC") == "CNC" and not holding.get("discrepancy")
                        and int(holding.get("quantity", 0)) - int(holding.get("used_quantity", 0)) - int(holding.get("collateral_quantity", 0)) > 0
                        and (config.get("manage_existing_holdings") == "all" or symbol in selected)):
                    symbols[symbol] = True
        return symbols

    def _advance_recovery(self):
        if self.recovery["phase"] == "ready":
            return
        reason, phase = "", "warming_up"
        if not self.connected:
            reason, phase = "Sign in to Zerodha to restore verified account monitoring.", "awaiting_session"
        elif not self._profile_verified or not self._recovery_account_verified:
            reason, phase = "Waiting for complete broker account verification.", "reconciling"
        elif self._unresolved_intents():
            reason, phase = "An order, quantity or protection is unresolved. Inspect Zerodha; no duplicate orders will be sent.", "blocked"
        else:
            symbols = self._managed_recovery_symbols()
            tokens = {i["tradingsymbol"]: token for token, i in self.universe.items()}
            stale = [s for s in symbols if s not in tokens or time.monotonic() - self.quotes.get(tokens[s], {}).get("received_at", 0) > 10]
            daily = [s for s, needed in symbols.items() if needed and len(self.daily.get(tokens.get(s), [])) < 21]
            if stale:
                reason = "Waiting for fresh market prices for managed shares: " + ", ".join(stale[:5]) + "."
            elif daily:
                reason = "Loading current completed daily candles for managed shares: " + ", ".join(daily[:5]) + "."
            elif any(symbols.values()) and not self._recovery_holdings_checked:
                reason = "Re-evaluating managed holdings and their exit conditions before new buys."
        if reason:
            self.recovery.update(phase=phase, message=reason, blocked=True)
        else:
            self.recovery.update(phase="ready", message="Current account and managed exposure verified. New decisions require fresh quotes and eligible completed candles.",
                                 completed_at=now_ist().isoformat(), blocked=False)
            self._event("recovery_ready", self.recovery["message"])
            self._invalidate_decisions()
            for token in self.universe:
                if time.monotonic() - self.quotes.get(token, {}).get("received_at", 0) <= 10:
                    self._queue_current_analysis(token)

    async def connect(self, access_token, user_id):
        async with self._lock:
            if self.user_id and self.user_id != user_id:
                raise ValueError("This data directory belongs to a different Zerodha account.")
            if self.settings.kite_user_id and self.settings.kite_user_id != user_id:
                raise ValueError("The Zerodha account does not match KITE_USER_ID.")
            await self._stop_tasks()
            self.running = False
            self.connected = False
            self._profile_verified = False
            self._account_at = 0.0
            self._begin_recovery()
            self._roll_day()  # Do not absorb newly discovered fills into today's baseline.
            self.daily.clear()
            self._history_date = ""
            self.books.clear()
            self.quotes.clear()
            self.streams.clear()
            self._last_tick_received = 0.0
            self._heartbeat = None
            if self.broker:
                self.broker.close()
            self.broker = KiteBroker(self.settings.kite_api_key, access_token)
            if self.delivery:
                self.delivery.broker = self.broker
            self.user_id = user_id
            self.running = False
            self._shutdown = False
            try:
                profile = await self.broker.call("profile")
                if str(profile.get("user_id", "")).upper() != str(user_id).upper():
                    raise ValueError("Broker profile belongs to another account")
                self._profile_verified = True
                await self._refresh_account_locked()
                instruments = await self.broker.call("instruments", "NSE")
                self.universe = {int(i["instrument_token"]): i for i in instruments
                                 if i.get("exchange") == "NSE" and i.get("segment") == "NSE"
                                 and i.get("instrument_type") == "EQ"}
                if not self.universe or len(self.universe) > 9000:
                    raise ValueError("NSE universe is empty or exceeds streaming capacity; entries blocked.")
                tokens = {i["tradingsymbol"]: token for token, i in self.universe.items()}
                for symbol, position in self.positions.items():
                    position["token"] = tokens.get(symbol, 0)
                for intent in self.intents.values():
                    intent["token"] = tokens.get(intent["symbol"], 0)
                if self.delivery:
                    self.delivery.remap_tokens(tokens)
                self.books = {token: CandleBook() for token in self.universe}
                self.quotes.clear()
                self.streams.clear()
                self._intraday_history_loaded.clear()
                self._candidates.clear()
                self.connected = True
                if not self._unresolved_intents():
                    self.status = "monitoring"
                    self.error = None
                    self.message = "Monitoring Zerodha. Intraday warms from 21 complete five-minute candles."
                self._advance_recovery()
                await self.broker.stream(list(self.universe), self._on_ticks, self._on_order, self._on_stream)
                self._tasks = [asyncio.create_task(self._run()), asyncio.create_task(self._monitor()),
                               asyncio.create_task(self._history()), asyncio.create_task(self._intraday_history()),
                               asyncio.create_task(self._analysis_loop())]
                self._event("connected", "Zerodha account connected; entries remain paused.",
                            {"user_id": user_id, "universe_count": len(self.universe), "mode": self.mode})
                self._event("analytics_capacity", "Parallel analytics ready; order execution remains serial.", self.analytics.snapshot())
                self._persist()
            except Exception as exc:
                self.connected = False
                self._halt("Connection setup failed (" + type(exc).__name__ + "). Verify Kite API access and reconnect.", "connection_error")
                self.recovery.update(phase="blocked", message=self.message, blocked=True)
                if self.broker:
                    self.broker.close()
                raise ValueError(self.message) from None

    async def start(self):
        async with self._lock:
            if self._maintenance():
                raise ValueError("Deployment maintenance is active; trading cannot start.")
            if self._other_mode_live_risk():
                raise ValueError("Unresolved real-money exposure exists from live mode. Restore live configuration and reconcile before using paper mode.")
            if not self.connected or not self.broker:
                raise ValueError("Connect Zerodha before starting trading.")
            if self.capital <= 0:
                raise ValueError("A positive trading capital allocation is required.")
            config = self.strategy_settings()
            if not config.get("intraday_enabled") and not config.get("swing_enabled"):
                raise ValueError("Enable at least one strategy in Settings.")
            allocations = [float(config.get(s + "_capital", 0)) for s in ("intraday", "swing")]
            if any(not math.isfinite(c) or c < 0 for c in allocations) or sum(allocations) > self.capital + 0.01:
                raise ValueError("Saved strategy allocations exceed this mode's capital. Update Settings before starting.")
            if any(config.get(s + "_enabled") and float(config.get(s + "_capital", 0)) <= 0 for s in ("intraday", "swing")):
                raise ValueError("Every enabled strategy needs a positive allocation.")
            if self.mode == "live":
                if not self.settings.live_trading_enabled or self.settings.live_capital <= 0:
                    raise ValueError("Live trading requires LIVE_TRADING_ENABLED=true and explicit LIVE_CAPITAL.")
            self.running = False
            self._begin_recovery()
            self._roll_day()
            await self._refresh_account_locked()
            if self._unresolved_intents():
                self._advance_recovery()
                raise ValueError("An order or exit is unresolved. Reconcile it in Zerodha before restarting.")
            if self._daily_pnl() <= -self.capital * self.settings.daily_loss_pct:
                raise ValueError("The daily loss limit has been reached.")
            if self._maintenance():
                raise ValueError("Deployment maintenance began during account reconciliation; trading remains paused.")
            self.running = True
            self.status = "running"
            self.error = None
            self.message = "Strategies armed. Entries wait for market hours, fresh data and all risk checks."
            self._event("trading_started", "Trading enabled.", {"mode": self.mode, "strategies": config})
            self._advance_recovery()
            # Recompute from the latest usable candles; do not replay a signal
            # queued before pause/reconnect. Normal ticks queue subsequent work.
            for token in self.universe:
                if time.monotonic() - self.quotes.get(token, {}).get("received_at", 0) <= 10:
                    self._queue_current_analysis(token)

    async def pause(self):
        self.running = False  # Stop queued decisions before waiting for an in-flight mutation.
        self._invalidate_decisions()
        async with self._lock:
            self.running = False
            self.status = "paused" if self.connected else "disconnected"
            self.message = "New entries paused. Existing positions and account monitoring remain active."
            if self.mode == "live" and self.broker and self.connected:
                await self._cancel_pending_entries_locked()
                await self.delivery.cancel_pending_entries()
                self._sync_delivery()
            self._event("trading_paused", self.message)
            self._persist()

    async def flatten(self):
        self.running = False
        async with self._lock:
            self.running = False
            self.status = "paused"
            if not self.connected:
                raise ValueError("Reconnect Zerodha before requesting exits.")
            if self.mode == "live":
                await self._refresh_account_locked()
                await self._cancel_pending_entries_locked()
                await self.delivery.cancel_pending_entries()
                self._sync_delivery()
            managed_existing = [p for p in self.delivery.snapshot().get("positions", {}).values()
                                if p.get("source") == "existing" and p.get("status") != "closed"
                                and p.get("remaining_quantity", 0) > 0] if self.delivery else []
            if (self.positions or managed_existing) and not market_hours():
                self._event("flatten_blocked", "Managed exits require an open market session; broker protection remains in place.", level="warning")
                raise ValueError("The regular market session is closed. Managed exits need an open session; existing broker protection remains in place.")
            for symbol in list(self.positions):
                await self._exit_locked(symbol, "operator_flatten")
            missing_quotes = []
            for position in managed_existing:
                symbol = position["symbol"]
                quote = self.quotes.get(int(position.get("token", 0)), {})
                bid = (quote.get("depth", {}).get("buy") or [{}])[0].get("price", 0)
                if time.monotonic() - quote.get("received_at", 0) > 10 or bid <= 0:
                    raw = (await self.broker.call("quote", ["NSE:" + symbol])).get("NSE:" + symbol, {})
                    at = parse_time(raw.get("timestamp"))
                    bid = (raw.get("depth", {}).get("buy") or [{}])[0].get("price", 0)
                    if at is None or abs((now_ist() - at).total_seconds()) > 10 or bid <= 0:
                        missing_quotes.append(symbol)
                        continue
                result = await self.delivery.request_exit(symbol, position["remaining_quantity"], float(bid), "Operator close managed holdings")
                self._event("managed_holding_exit_requested", f"Exit requested for previously adopted {symbol} holding.",
                            {"symbol": symbol, "quantity": position["remaining_quantity"], "result": result})
                self._sync_delivery()
            self._event("flatten_requested", "Exit requested for bot positions and already-managed holdings. Confirm fills in the account view.")
            self._persist()
            if missing_quotes:
                raise ValueError("Fresh executable quotes are unavailable for: " + ", ".join(missing_quotes) + ". Other managed exit requests were processed; inspect the account view.")

    async def _stop_tasks(self):
        current = asyncio.current_task()
        tasks = [t for t in self._tasks if t != current]
        tasks += list(self._analysis_tasks)
        for task in tasks:
            task.cancel()
        # Callers hold the engine lock. Cancelled tasks must never wait for it.
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks = []
        self._analysis_tasks.clear()

    async def shutdown(self):
        self._shutdown = True
        try:
            await self.pause()
        finally:
            await self._stop_tasks()
            await self.analytics.close()
            if self.broker:
                self.broker.close()
            self.connected = False
            self._persist()

    def _on_stream(self, index, connected, tokens):
        if self._shutdown:
            return
        previous = self.streams.get(index)
        self.streams[index] = connected
        if previous != connected:
            self._event("feed_connected" if connected else "feed_disconnected",
                        f"Market feed {index + 1} " + ("connected." if connected else "disconnected; entries require fresh data."))
        if not connected:
            self._invalidate_decisions()
            self._recovery_holdings_checked = False
            self.recovery.update(phase="warming_up", message="Market stream interrupted; managed exposure needs fresh prices before new buys.",
                                 blocked=True, completed_at=None)
            self._intraday_history_loaded.difference_update(tokens)
            for token in tokens:
                self.books[token] = CandleBook()
                self.quotes.pop(token, None)

    def _on_order(self, order):
        if self._shutdown:
            return
        self._record_order(order)
        self._reconcile_requested.set()

    def request_reconciliation(self):
        """Wake the account monitor without accepting external order state."""
        if not self._shutdown:
            self._reconcile_requested.set()

    def _record_order(self, order):
        oid = str(order.get("order_id", ""))
        signature = tuple(str(order.get(k)) for k in ("status", "filled_quantity", "pending_quantity", "price", "trigger_price", "quantity", "average_price"))
        if oid and self._order_seen.get(oid) != signature:
            self._order_seen[oid] = signature
            self._event("account_order", f"{order.get('tradingsymbol', '')}: {order.get('transaction_type', '')} {order.get('status', '')}",
                        order, level="error" if order.get("status") == "REJECTED" else "info")

    def _on_ticks(self, ticks):
        if self._shutdown:
            return
        now = now_ist()
        if not market_hours(now):
            return
        for tick in ticks:
            token = int(tick.get("instrument_token", 0))
            if token not in self.universe:
                continue
            at = parse_time(tick.get("exchange_timestamp"))
            if at is None or abs((now - at).total_seconds()) > 10:
                continue
            price = float(tick.get("last_price", 0))
            if not math.isfinite(price) or price <= 0:
                continue
            tick = dict(tick, received_at=time.monotonic())
            self.quotes[token] = tick
            self._last_tick_received = time.monotonic()
            self._heartbeat = now.isoformat()
            symbol = self.universe[token]["tradingsymbol"]
            if symbol in self.positions:
                self.positions[symbol]["last"] = price
            previous_count = len(self.books[token].bars)
            closed = self.books[token].update(at, price, float(tick.get("volume_traded", 0)))
            if previous_count and not self.books[token].bars:
                self._intraday_history_loaded.discard(token)
            if closed:
                self._queue_analysis(token, "intraday", list(self.books[token].bars))
            if token in self.daily and token not in self._daily_checked:
                self._daily_checked.add(token)
                self._queue_analysis(token, "swing", self.daily[token])

    def _queue_analysis(self, token, strategy, bars):
        if not bars:
            return
        # Latest completed candle supersedes an older queued calculation for the
        # same instrument, bounding the queue to at most two universe passes.
        self._analysis_pending[(strategy, token)] = {"token": token, "strategy": strategy,
                                                    "bars": list(bars), "bar_time": bars[-1].time.isoformat(),
                                                    "generation": self._analysis_generation,
                                                    "queued_at": time.monotonic()}

    def _queue_current_analysis(self, token):
        now = now_ist()
        bars = list(self.books[token].bars) if token in self.books else []
        if (bars and bars[-1].time.date() == now.date()
                and timedelta(0) <= now - bars[-1].time - timedelta(minutes=5) < timedelta(minutes=5)):
            self._queue_analysis(token, "intraday", bars)
        if token in self.daily:
            self._daily_checked.add(token)
            self._queue_analysis(token, "swing", self.daily[token])

    async def _analysis_loop(self):
        while True:
            while self._analysis_pending and len(self._analysis_tasks) < self.analytics.worker_limit:
                keys = list(self._analysis_pending)[:self.analytics.batch_size]
                batch = [self._analysis_pending.pop(key) for key in keys]
                task = asyncio.create_task(self.analytics.analyze(batch))
                self._analysis_tasks.add(task)
                task.add_done_callback(self._analysis_finished)
            await asyncio.sleep(0.1)

    def _analysis_finished(self, task):
        self._analysis_tasks.discard(task)
        if task.cancelled() or self._shutdown:
            return
        try:
            for result in task.result():
                token, strategy = result["token"], result["strategy"]
                if result["generation"] != self._analysis_generation:
                    continue
                bars = list(self.books[token].bars) if strategy == "intraday" and token in self.books else self.daily.get(token, [])
                if not bars or bars[-1].time.isoformat() != result["bar_time"]:
                    continue
                if time.monotonic() - result["queued_at"] > 30:
                    self._stats["stale_analysis_dropped"] += 1
                    if strategy == "swing":
                        self._daily_checked.discard(token)
                    continue
                self._analysis_cache[(strategy, token)] = result
                self._stats[strategy + ":" + result["reason"]] += 1
                if result["signal"]:
                    self._candidate(token, Signal(**result["signal"]), result["metrics"])
        except Exception as exc:
            self._halt(f"Parallel analytics failed ({type(exc).__name__}); entries paused while monitoring and exits continue.", "analytics_error")

    def _candidate(self, token, signal, metrics=None):
        record = {"time": now_ist().isoformat(), "symbol": self.universe[token]["tradingsymbol"],
                  **asdict(signal), "status": "candidate", "analytics": metrics or {}}
        self.signals.appendleft(record)
        self._event("signal", f"{record['symbol']}: {signal.reason}", record)
        self._candidates.append((token, signal, time.monotonic(), record))

    async def _run(self):
        while True:
            try:
                async with self._lock:
                    self._roll_day()
                    now = now_ist()
                    if self.connected and market_hours(now):
                        for symbol, position in list(self.positions.items()):
                            quote = self.quotes.get(position["token"], {})
                            fresh = time.monotonic() - quote.get("received_at", 0) <= 10
                            opened = parse_time(position.get("opened_at"))
                            if position["strategy"] == "intraday" and (now.strftime("%H:%M") >= self.settings.exit_time or opened and opened.date() < now.date()):
                                await self._exit_locked(symbol, "overdue_intraday_exit" if opened and opened.date() < now.date() else "intraday_session_exit")
                            elif fresh:
                                last = float(quote["last_price"])
                                if last <= position["stop"]:
                                    await self._exit_locked(symbol, "stop_loss")
                                elif last >= position["target"]:
                                    await self._exit_locked(symbol, "profit_target")
                        if self._daily_pnl() <= -self.capital * self.settings.daily_loss_pct and self.capital > 0:
                            self._halt("Daily loss limit reached; new entries stopped and bot exits requested.")
                            for symbol in list(self.positions):
                                await self._exit_locked(symbol, "daily_loss_limit")
                        if time.monotonic() - self._last_holdings_scan >= (5 if self.recovery["phase"] != "ready" else 60):
                            self._analyze_holdings()
                            evaluated = True
                            if self.delivery:
                                bars_by_symbol = {self.universe[t]["tradingsymbol"]: bars for t, bars in self.daily.items() if t in self.universe}
                                quotes_by_symbol = {self.universe[t]["tradingsymbol"]: {**q, "tick_size": self.universe[t].get("tick_size", 0.05)} for t, q in self.quotes.items() if t in self.universe}
                                outcome = await self.delivery.evaluate_holdings(bars_by_symbol, self.strategy_settings(), quotes_by_symbol,
                                                                                adopt_new=self.running)
                                evaluated = not outcome.get("blocked")
                                self._sync_delivery()
                            required = self._managed_recovery_symbols()
                            tokens = {i["tradingsymbol"]: token for token, i in self.universe.items()}
                            self._recovery_holdings_checked = evaluated and all(
                                not daily or (symbol in outcome.get("evaluated_symbols", []) if self.delivery else
                                              bool(self._analysis_cache.get(("swing", tokens.get(symbol)), {}).get("holding")))
                                for symbol, daily in required.items())
                            self._last_holdings_scan = time.monotonic()
                    self._advance_recovery()
                    for _ in range(min(10, len(self._candidates))):
                        token, signal, received, record = self._candidates.popleft()
                        if time.monotonic() - received <= 30:
                            reason = await self._enter_locked(token, signal)
                            record["status"] = reason
                            self._event("decision", f"{record['symbol']}: {reason}",
                                        {"symbol": record["symbol"], "strategy": signal.strategy, "decision": reason})
                    if time.monotonic() - self._last_summary >= 300 and self._stats:
                        self._event("scan_summary", "Closed-candle scan summary.", dict(self._stats))
                        self._stats.clear()
                        self._last_summary = time.monotonic()
                    if time.monotonic() - self._last_persist >= 15:
                        self._persist()
                        self._last_persist = time.monotonic()
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._halt(f"Trading loop interrupted ({type(exc).__name__}); entries paused.", "engine_error")
                await asyncio.sleep(2)

    async def _monitor(self):
        while True:
            try:
                async with self._lock:
                    await self._refresh_account_locked()
                self._reconcile_requested.clear()
                try:
                    await asyncio.wait_for(self._reconcile_requested.wait(), timeout=15)
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                raise
            except BrokerError as exc:
                if exc.kind == "TokenException":
                    self.connected = False
                    self._halt("Zerodha authentication expired. Reconnect immediately; existing broker cover stops remain subject to broker execution.", "auth_expired")
                else:
                    self._halt("Account reconciliation failed; new entries paused. Existing broker protection remains in place.", "account_error")
                await asyncio.sleep(15)
            except Exception as exc:
                self._halt(f"Account monitoring interrupted ({type(exc).__name__}); entries paused until reconciliation recovers.", "account_error")
                await asyncio.sleep(15)

    async def _refresh_account_locked(self):
        account = await self.broker.account()
        for order in account.get("orders", []):
            self._record_order(order)
        for trade in account.get("trades", []):
            key = (str(trade.get("order_id")), str(trade.get("trade_id")))
            if key not in self._trade_seen:
                self._trade_seen.add(key)
                self._event("account_trade", f"Executed trade: {trade.get('tradingsymbol', '')}", trade)
        signature = sorted((str(p.get("exchange")), str(p.get("tradingsymbol")), str(p.get("product")), int(p.get("quantity", 0)))
                           for p in account.get("positions", {}).get("net", []))
        if signature != self._position_seen:
            self._event("account_positions", "Zerodha account positions changed (includes manual trades).", account.get("positions"))
            self._position_seen = signature
        holdings_signature = sorted((str(h.get("exchange")), str(h.get("tradingsymbol")),
                                      int(h.get("quantity", 0)), int(h.get("t1_quantity", 0)),
                                      int(h.get("used_quantity", 0)), int(h.get("collateral_quantity", 0)),
                                      round(float(h.get("average_price", 0)), 4)) for h in account.get("holdings", []))
        if holdings_signature != self._holdings_seen:
            self._event("account_holdings", "Zerodha holdings quantities or cost basis changed.", account.get("holdings", []))
            self._holdings_seen = holdings_signature
        margins = account.get("margins", {})
        balance_signature = tuple((segment, *(round(float(margins.get(segment, {}).get("available", {}).get(key, 0)))
                                              for key in ("cash", "live_balance", "collateral", "intraday_payin")))
                                  for segment in ("equity", "commodity"))
        if balance_signature != self._balance_seen and (self._balance_seen is None or time.monotonic() - self._balance_logged_at >= 60):
            self._event("account_balances", "Zerodha available balances changed (sampled at most once per minute).", margins)
            self._balance_seen = balance_signature
            self._balance_logged_at = time.monotonic()
        self.account = account
        self._account_at = time.monotonic()
        self.store.set("account_snapshot", account)
        if self.mode == "live":
            await self._reconcile_live_locked()
            await self.delivery.reconcile(account)
            self._sync_delivery()
        self._recovery_account_verified = True
        self._persist()

    def _unresolved_intents(self):
        return (any(i.get("state") in {"submitting", "unknown", "conflict", "unprotected", "exit_unknown", "exit_pending"}
                    for i in self.intents.values()) or bool(self.delivery and self.delivery.snapshot().get("blocked")))

    def _sync_delivery(self):
        if not self.delivery:
            return
        state = self.delivery.snapshot()
        for symbol in [s for s, p in self.positions.items() if p.get("strategy") == "swing"]:
            self.positions.pop(symbol, None)
        for symbol, p in state.get("positions", {}).items():
            if p.get("source") == "swing" and p.get("status") != "closed" and p.get("remaining_quantity", 0) > 0:
                token = int(p.get("token", 0))
                self.positions[symbol] = {**p, "quantity": p["remaining_quantity"],
                                          "last": self.quotes.get(token, {}).get("last_price", p.get("last", p["entry"]))}
        realised = float(state.get("bot_realised_pnl", 0))
        self.realised += realised - self._delivery_accounted
        self._delivery_accounted = realised
        if state.get("blocked"):
            self._halt("Delivery order/protection needs attention: " + "; ".join(state.get("reasons", [])[:3]), "delivery_blocked")

    def _roll_day(self):
        today = now_ist().date().isoformat()
        if today == self.day:
            return
        self.day = today
        self.day_baseline = self.realised
        self.day_open_unrealised = self._unrealised()
        self.traded.clear()
        self._daily_checked.clear()
        self._intraday_history_loaded.clear()
        self._invalidate_decisions()
        self.books = {token: CandleBook() for token in self.universe}
        self.quotes.clear()
        self.daily.clear()
        self._history_date = ""
        self._recovery_holdings_checked = False
        self.recovery.update(phase="warming_up", message="New session: refresh market data and select Start Trading after Zerodha authentication.", blocked=True, completed_at=None)
        self._order_seen.clear()
        self._trade_seen.clear()
        self.running = False
        self._event("day_rollover", "New trading day. Daily risk baseline reset; Start Trading is required again.")
        self.status = "paused" if self.connected else "disconnected"
        self._persist()

    def _unrealised(self):
        return sum((p.get("last", p["entry"]) - p["entry"]) * p["quantity"] - p.get("entry_fee", 0)
                   for p in self.positions.values())

    def _daily_pnl(self):
        return self.realised - self.day_baseline + self._unrealised() - self.day_open_unrealised

    def _exposure(self, strategy=None):
        positions = sum(p["entry"] * p["quantity"] for p in self.positions.values()
                        if strategy is None or p["strategy"] == strategy)
        pending = sum(i["entry"] * max(0, i["quantity"] - i.get("filled", 0)) for i in self.intents.values()
                      if i.get("state") in {"submitting", "unknown", "pending"}
                      and (strategy is None or i["strategy"] == strategy))
        delivery_pending = 0
        if self.delivery and strategy in (None, "swing"):
            delivery_pending = sum(float(p.get("entry_price", 0)) * max(0, int(p.get("requested_quantity", 0)) - int(p.get("quantity", 0)))
                                   for p in self.delivery.snapshot().get("positions", {}).values()
                                   if p.get("source") == "swing" and p.get("status") != "closed")
        return positions + pending + delivery_pending

    async def _enter_locked(self, token, signal):
        if not self.running:
            return "entries_paused"
        if self._maintenance():
            self.running = False
            return "maintenance_active"
        now = now_ist()
        if not market_hours(now):
            return "market_closed"
        if signal.strategy == "intraday" and now.strftime("%H:%M") >= self.settings.entry_cutoff:
            return "entry_cutoff"
        if signal.strategy == "swing" and now.strftime("%H:%M") >= "15:15":
            return "swing_entry_cutoff"
        config = self.strategy_settings()
        if not config.get(signal.strategy + "_enabled"):
            return "strategy_disabled"
        allocation = float(config.get(signal.strategy + "_capital", 0))
        if allocation <= 0 or sum(float(config.get(s + "_capital", 0)) for s in ("intraday", "swing")) > self.capital + 0.01:
            return "invalid_capital_allocation"
        if self._unresolved_intents():
            return "unresolved_order"
        if self.recovery["phase"] != "ready":
            return "recovery_incomplete"
        if time.monotonic() - self._account_at > 45 or not self.connected:
            return "account_data_stale"
        if self._daily_pnl() <= -self.capital * self.settings.daily_loss_pct:
            return "daily_loss_limit"
        symbol = self.universe[token]["tradingsymbol"]
        if symbol in self.positions or symbol in self.traded or any(i["symbol"] == symbol and i.get("state") not in {"closed", "rejected"} for i in self.intents.values()):
            return "already_owned_or_traded_today"
        pending_count = sum(i.get("state") in {"submitting", "unknown", "pending"} and i["symbol"] not in self.positions for i in self.intents.values())
        if len(self.positions) + pending_count >= self.settings.max_positions:
            return "maximum_positions"
        quote = self.quotes.get(token, {})
        if time.monotonic() - quote.get("received_at", 0) > 10:
            return "quote_stale"
        depth = quote.get("depth", {})
        buys, sells = depth.get("buy", []), depth.get("sell", [])
        if not buys or not sells or buys[0].get("price", 0) <= 0 or sells[0].get("price", 0) <= 0:
            return "market_depth_missing"
        bid, ask = float(buys[0]["price"]), float(sells[0]["price"])
        if ask < bid or (ask - bid) / ask > self.settings.max_spread_pct:
            return "spread_too_wide"
        if float(quote.get("volume_traded", 0)) * float(quote.get("last_price", 0)) < self.settings.min_daily_turnover:
            return "turnover_too_low"
        if abs(ask / signal.reference - 1) > (0.005 if signal.strategy == "intraday" else 0.02):
            return "price_moved_from_signal"
        tick_size = float(self.universe[token].get("tick_size", 0.05)) or 0.05
        entry = round(math.ceil((ask * 1.0005) / tick_size) * tick_size, 4)
        stop = round(math.floor(signal.stop / tick_size) * tick_size, 4)
        remaining = min(allocation - self._exposure(signal.strategy), self.capital + min(0, self.realised) - self._exposure())
        if self.mode == "live":
            if not self.settings.live_trading_enabled or self.settings.live_capital <= 0:
                return "live_execution_disabled"
            if self._account_symbol_busy(symbol):
                return "existing_account_exposure"
            equity_margin = self.account.get("margins", {}).get("equity", {})
            available = equity_margin.get("available", {})
            raw_cash = float(available.get("cash", 0))
            balance = float(available.get("live_balance", equity_margin.get("net", 0)))
            non_cash = float(available.get("collateral", 0)) + float(available.get("adhoc_margin", 0))
            # Cover orders can receive leverage. Reserve full notional for all
            # bot positions even when the broker blocks only a margin fraction.
            # This deliberately underuses cash rather than spending collateral.
            cash = max(0, min(raw_cash, balance - non_cash) - self._exposure())
            remaining = min(remaining, cash)
        quantity = position_size(allocation, remaining, entry, stop,
                                 self.settings.risk_per_trade_pct, self.settings.max_position_pct)
        if quantity < 1:
            return "insufficient_risk_or_cash_budget"
        if int(sells[0].get("quantity", 0)) < quantity:
            return "insufficient_visible_liquidity"
        risk_used = sum(max(0, p["entry"] - p["stop"]) * p["quantity"] for p in self.positions.values())
        risk_used += sum((i["entry"] - i["stop"]) * max(0, i["quantity"] - i.get("filled", 0)) for i in self.intents.values()
                         if i.get("state") in {"submitting", "pending", "unknown"})
        if risk_used + (entry - stop) * quantity > self.capital * self.settings.daily_loss_pct:
            return "aggregate_risk_limit"
        # Recheck immediately before the irreversible broker request.
        if self._maintenance() or not self.running:
            return "entries_paused"
        if self.mode == "paper":
            self.positions[symbol] = {"symbol": symbol, "token": token, "strategy": signal.strategy,
                                      "quantity": quantity, "entry": entry, "last": float(quote["last_price"]),
                                      "stop": stop, "target": signal.target, "entry_fee": entry * quantity * FEE_RATE,
                                      "opened_at": now.isoformat(), "protection": "simulated", "mode": "paper"}
            self.traded.add(symbol)
            self._persist()
            self._event("paper_fill", f"Simulated BUY {quantity} {symbol} at {entry:.2f}.", self.positions[symbol])
            return "paper_buy_filled"
        if signal.strategy == "swing":
            result = await self.delivery.submit_entry(symbol, quantity, entry, stop, signal.target, tick_size=tick_size, token=token)
            if result.get("position"):
                self.traded.add(symbol)
            self._sync_delivery()
            self._persist()
            self._reconcile_requested.set()
            return "delivery_" + result.get("status", "unknown") + (": " + result["reason"] if result.get("reason") else "")
        tag = "EB" + uuid.uuid4().hex[:18]
        intent = {"tag": tag, "symbol": symbol, "token": token, "strategy": signal.strategy,
                  "quantity": quantity, "entry": entry, "stop": stop, "target": signal.target,
                  "created_at": now.isoformat(), "state": "submitting", "filled": 0,
                  "exit_requested": [], "pnl_accounted": 0.0}
        self.intents[tag] = intent
        self.traded.add(symbol)
        self._persist()  # Write-ahead journal before the external side effect.
        self._event("order_intent", f"Submitting protected cover BUY {quantity} {symbol}.", intent)
        try:
            intent["order_id"] = str(await self.broker.buy_cover(symbol, quantity, entry, stop, tag))
            intent["state"] = "pending"
        except BrokerError as exc:
            if exc.kind in {"InputException", "PermissionException", "TokenException"}:
                intent["state"] = "rejected"
                self._event("order_rejected", f"Cover entry rejected before acknowledgement: {symbol}.",
                            {"tag": tag, "kind": exc.kind, "detail": exc.detail}, level="error")
                if exc.kind in {"PermissionException", "TokenException"}:
                    if exc.kind == "TokenException":
                        self.connected = False
                    self._halt("Broker authentication or trading permission rejected the entry. Reconnect or correct account permissions.")
            else:
                intent["state"] = "unknown"
                self._halt(f"Order acknowledgement unknown for {symbol}; never retried automatically. Reconcile in Zerodha.", "order_unknown")
        except Exception as exc:
            intent["state"] = "unknown"
            self._halt(f"Order acknowledgement unknown for {symbol}; never retried automatically. Reconcile in Zerodha.", "order_unknown")
        self._persist()
        self._reconcile_requested.set()
        return "cover_order_" + intent["state"]

    def _account_symbol_busy(self, symbol):
        for p in self.account.get("positions", {}).get("net", []):
            if p.get("tradingsymbol") == symbol and int(p.get("quantity", 0)) != 0:
                return True
        for p in self.account.get("holdings", []):
            if p.get("tradingsymbol") == symbol and int(p.get("quantity", 0)) + int(p.get("t1_quantity", 0)) > 0:
                return True
        return any(o.get("tradingsymbol") == symbol and o.get("status") not in TERMINAL for o in self.account.get("orders", []))

    async def _exit_locked(self, symbol, reason):
        position = self.positions.get(symbol)
        if not position:
            return
        if self.mode == "paper":
            quote = self.quotes.get(position["token"], {})
            if not market_hours() or time.monotonic() - quote.get("received_at", 0) > 10:
                return  # No invented fills at stale prices, including across gaps.
            bid = (quote.get("depth", {}).get("buy") or [{}])[0].get("price", 0)
            if bid <= 0:
                return
            exit_price = float(bid) * 0.9995
            pnl = (exit_price - position["entry"]) * position["quantity"] - position.get("entry_fee", 0) - exit_price * position["quantity"] * FEE_RATE
            self.realised += pnl
            del self.positions[symbol]
            self._persist()
            self._event("paper_fill", f"Simulated SELL {position['quantity']} {symbol}: {reason}.",
                        {**position, "exit": exit_price, "pnl": pnl, "reason": reason, "fees_estimated": True})
            return
        if not self.connected or time.monotonic() - self._account_at > 45:
            self._halt("Cannot request exits with stale account data. Check existing cover stops in Zerodha.")
            return
        if position["strategy"] == "swing":
            quote = self.quotes.get(position["token"], {})
            bid = (quote.get("depth", {}).get("buy") or [{}])[0].get("price", 0)
            if not market_hours() or time.monotonic() - quote.get("received_at", 0) > 10 or bid <= 0:
                return
            await self.delivery.request_exit(symbol, position["quantity"], float(bid), reason)
            self._sync_delivery()
            self._persist()
            self._reconcile_requested.set()
            return
        intent = self.intents.get(position.get("tag"))
        if not intent:
            self._halt(f"Ownership journal missing for {symbol}; no independent SELL will be sent.")
            return
        if intent.get("state") in {"unknown", "conflict"}:
            self._halt(f"Cover ownership for {symbol} is unresolved; no cancellation or independent sell was sent.", "ownership_conflict")
            return
        orders = intent.get("broker_orders") or self.account.get("orders", [])
        parent = next((o for o in orders if str(o.get("order_id")) == intent.get("order_id")), None)
        if parent and parent.get("status") not in TERMINAL:
            await self._request_cancel_locked(intent, parent, None, reason)
        children = [o for o in orders if str(o.get("parent_order_id")) == intent.get("order_id") and o.get("status") not in TERMINAL]
        for child in children:
            await self._request_cancel_locked(intent, child, intent["order_id"], reason)
        if not children and position["quantity"] > 0:
            self._halt(f"No active cover child found for {symbol}; inspect Zerodha immediately. No duplicate exit was submitted.", "protection_missing")

    async def _request_cancel_locked(self, intent, order, parent, reason):
        oid = str(order["order_id"])
        if oid in intent.setdefault("exit_requested", []):
            return
        intent["exit_requested"].append(oid)
        intent["exit_at"] = now_ist().isoformat()
        self._persist()
        self._event("cover_exit_request", f"Requesting cover order cancellation/exit: {intent['symbol']}.",
                    {"order_id": oid, "parent_order_id": parent, "reason": reason})
        try:
            await self.broker.cancel_cover(oid, parent)
        except Exception:
            intent["state"] = "exit_unknown"
            self._halt(f"Exit acknowledgement unknown for {intent['symbol']}; reconcile before any further order.", "exit_unknown")
        self._persist()
        self._reconcile_requested.set()

    async def _cancel_pending_entries_locked(self):
        for intent in self.intents.values():
            parent = next((o for o in self.account.get("orders", []) if str(o.get("order_id")) == intent.get("order_id")), None)
            if parent and parent.get("status") not in TERMINAL:
                await self._request_cancel_locked(intent, parent, None, "pause_entries")

    async def _reconcile_live_locked(self):
        orders = self.account.get("orders", [])
        by_id = {str(o.get("order_id")): o for o in orders}
        for tag, intent in self.intents.items():
            if intent.get("state") in {"closed", "rejected"}:
                continue
            matches = [o for o in orders if (o.get("tag") == tag or tag in (o.get("tags") or [])) and not o.get("parent_order_id")]
            if len(matches) > 1:
                intent["state"] = "conflict"
                self._halt(f"Multiple broker orders match intent {tag}; manual reconciliation required.")
                continue
            parent = by_id.get(intent.get("order_id")) or (matches[0] if matches else None)
            if parent is None and intent.get("order_id"):
                try:
                    history = await self.broker.call("order_history", intent["order_id"])
                    parent = history[-1] if history else None
                except Exception:
                    parent = None
                if parent is None and intent.get("broker_parent", {}).get("status") in TERMINAL:
                    parent = intent["broker_parent"]
            if not parent:
                intent["state"] = "unknown"
                self._halt(f"Unresolved order intent for {intent['symbol']}; no automatic resubmission.")
                continue
            intent["order_id"] = str(parent["order_id"])
            if (parent.get("variety") != "co" or parent.get("transaction_type") != "BUY"
                    or parent.get("exchange") != "NSE" or parent.get("tradingsymbol") != intent["symbol"]
                    or parent.get("product") not in {"MIS", "CO"}
                    or int(parent.get("quantity", -1)) != int(intent["quantity"])):
                intent["state"] = "conflict"
                self._halt("Broker order does not match protected long-only ownership journal.")
                continue
            children = [o for o in orders if str(o.get("parent_order_id")) == intent["order_id"]]
            missing_child = False
            for prior in intent.get("broker_children", []):
                if any(str(o.get("order_id")) == str(prior.get("order_id")) for o in children):
                    continue
                resolved = prior if prior.get("status") in TERMINAL else None
                if resolved is None:
                    try:
                        history = await self.broker.call("order_history", str(prior["order_id"]))
                        resolved = history[-1] if history else None
                    except Exception:
                        resolved = None
                if resolved is None:
                    missing_child = True
                    break
                children.append(resolved)
            if missing_child:
                intent["state"] = "unknown"
                self._halt(f"Cover child history for {intent['symbol']} is unavailable. Its absence does not prove an exit; reconcile in Zerodha.", "order_unknown")
                continue
            if any(o.get("exchange") != "NSE" or o.get("tradingsymbol") != intent["symbol"]
                   or o.get("product") not in {"MIS", "CO"} or o.get("variety") != "co"
                   or str(o.get("parent_order_id")) != intent["order_id"]
                   or o.get("transaction_type") != "SELL" for o in children):
                intent["state"] = "conflict"
                self._halt(f"Cover child identity for {intent['symbol']} changed; manual reconciliation required.", "ownership_conflict")
                continue
            intent["broker_parent"] = jsonable(parent)
            intent["broker_children"] = jsonable(children)
            intent["broker_orders"] = [intent["broker_parent"], *intent["broker_children"]]
            filled = int(parent.get("filled_quantity", 0))
            sold = sum(int(o.get("filled_quantity", 0)) for o in children if o.get("transaction_type") == "SELL")
            if sold > filled:
                intent["state"] = "conflict"
                self._halt(f"Cover exit fills exceed entry fills for {intent['symbol']}; account reconciliation is required.", "ownership_conflict")
                continue
            quantity = max(0, filled - sold)
            intent["filled"] = filled
            entry = float(parent.get("average_price", 0)) or intent["entry"]
            pnl = sum((float(o.get("average_price", 0)) - entry) * int(o.get("filled_quantity", 0))
                      for o in children if o.get("transaction_type") == "SELL")
            pnl -= (entry * sold + sum(float(o.get("average_price", 0)) * int(o.get("filled_quantity", 0)) for o in children)) * FEE_RATE
            self.realised += pnl - intent.get("pnl_accounted", 0)
            intent["pnl_accounted"] = pnl
            symbol = intent["symbol"]
            active_children = [o for o in children if o.get("status") not in TERMINAL]
            if quantity:
                self.positions[symbol] = {"symbol": symbol, "token": intent["token"], "strategy": "intraday",
                                          "quantity": quantity, "entry": entry, "stop": intent["stop"],
                                          "target": intent["target"], "tag": tag, "mode": "live",
                                          "last": self.quotes.get(intent["token"], {}).get("last_price", entry),
                                          "entry_fee": entry * quantity * FEE_RATE,
                                          "opened_at": intent["created_at"], "protection": "broker_cover" if active_children else "unconfirmed"}
                protected = sum(int(o.get("pending_quantity", 0)) for o in active_children if o.get("transaction_type") == "SELL")
                stop_changed = any(float(o.get("trigger_price", 0)) + 0.0001 < float(intent["stop"])
                                   for o in active_children if not intent.get("exit_at"))
                if protected != quantity or stop_changed:
                    intent["state"] = "unprotected"
                    self._halt(f"Cover protection quantity or stop for {symbol} differs from the journal; inspect Zerodha immediately.", "protection_missing")
                else:
                    intent["state"] = "open" if parent.get("status") in TERMINAL else "pending"
                if intent.get("exit_at") and active_children:
                    intent["state"] = "exit_pending"
                net = sum(int(p.get("quantity", 0)) for p in self.account.get("positions", {}).get("net", [])
                          if p.get("tradingsymbol") == symbol and p.get("exchange") == "NSE" and p.get("product") in {"MIS", "CO"})
                if net != quantity:
                    intent["state"] = "conflict"
                    self._halt(f"Account quantity for {symbol} differs from the bot journal (manual trade or reconciliation delay). Entries paused.", "ownership_conflict")
            elif parent.get("status") in TERMINAL:
                if any(int(o.get("pending_quantity", 0)) > 0 for o in active_children):
                    intent["state"] = "conflict"
                    self._halt(f"Cover child remains active without owned quantity for {symbol}; inspect Zerodha.", "ownership_conflict")
                    continue
                self.positions.pop(symbol, None)
                intent["state"] = "closed" if filled else "rejected"
                self._event("intent_closed", f"Broker intent resolved: {symbol}.", {"tag": tag, "filled": filled, "pnl_estimated": pnl})
            else:
                intent["state"] = "pending"
            created = parse_time(intent["created_at"])
            if parent.get("status") not in TERMINAL and created and (now_ist() - created).total_seconds() > 30:
                await self._request_cancel_locked(intent, parent, None, "entry_timeout")
            exit_at = parse_time(intent.get("exit_at"))
            if exit_at and quantity and (now_ist() - exit_at).total_seconds() > 30:
                self._halt(f"Exit for {symbol} is still unresolved; inspect its broker cover order immediately.", "exit_pending")

    async def _history(self):
        while True:
            try:
                config = self.strategy_settings()
                today = now_ist().date().isoformat()
                holding_tokens = {int(h.get("instrument_token", 0)) for h in self.account.get("holdings", [])
                                  if h.get("exchange") == "NSE"}
                holding_tokens.update(int(p.get("token", 0)) for p in self.positions.values() if p.get("strategy") == "swing")
                if self.delivery:
                    holding_tokens.update(int(p.get("token", 0)) for p in self.delivery.snapshot().get("positions", {}).values() if p.get("status") != "closed")
                wanted = list(self.universe) if config.get("swing_enabled") else [t for t in self.universe if t in holding_tokens]
                wanted.sort(key=lambda token: (token not in holding_tokens,
                                               -float(self.quotes.get(token, {}).get("volume_traded", 0)) * float(self.quotes.get(token, {}).get("last_price", 0))))
                coverage_key = today + (":all" if config.get("swing_enabled") else ":holdings:" + ",".join(map(str, sorted(holding_tokens))))
                if wanted and self._history_date != coverage_key and self.connected:
                    self._daily_checked.clear()
                    completed, failed = 0, 0
                    self._event("daily_history", "Loading completed daily candles for NSE swing analysis. Coverage grows as the rate-limited download completes.")
                    for token in wanted:
                        if not self.connected:
                            break
                        cache = self.store.get(f"daily:{token}", {})
                        try:
                            if cache.get("date") == today:
                                rows = cache.get("rows", [])
                            else:
                                end = now_ist().replace(hour=0, minute=0, second=0, microsecond=0)
                                rows = await self.broker.call("historical_data", token, end - timedelta(days=160), end - timedelta(seconds=1), "day")
                                self.store.set(f"daily:{token}", {"date": today, "rows": jsonable(rows)})
                                await asyncio.sleep(0.1)
                            bars = []
                            for row in rows:
                                at = parse_time(row.get("date"))
                                if at and at.date() < now_ist().date():
                                    bars.append(Candle(at, float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"]), float(row["volume"])))
                            if len(bars) >= (21 if token in holding_tokens else 55) and (now_ist().date() - bars[-1].time.date()).days <= 7:
                                self.daily[token] = bars
                                self._daily_checked.discard(token)
                            completed += 1
                        except BrokerError as exc:
                            failed += 1
                            if exc.kind == "TokenException":
                                self.connected = False
                                self._halt("Authentication expired while loading daily history. Reconnect Zerodha.", "auth_expired")
                                break
                        if (completed + failed) % 100 == 0:
                            self._event("daily_history", "Daily candle download progress.", {"downloaded": completed, "failed": failed, "ready": len(self.daily), "total": len(self.universe)})
                    self._history_failures = failed
                    if self.connected and not failed:
                        self._history_date = coverage_key
                    self._event("daily_history", "Daily history pass finished.", {"downloaded": completed, "failed": failed, "ready": len(self.daily), "total": len(self.universe)})
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._event("daily_history_error", f"Daily history unavailable ({type(exc).__name__}); swing entries require complete data.", level="error")
                await asyncio.sleep(30)

    async def _intraday_history(self):
        """Bootstrap closed current-session bars, busiest instruments first."""
        while True:
            try:
                if not self.connected or not market_hours() or not self.strategy_settings().get("intraday_enabled"):
                    await asyncio.sleep(15)
                    continue
                if not self.quotes:
                    await asyncio.sleep(1)
                    continue
                wanted = [token for token in self.universe if token not in self._intraday_history_loaded]
                managed_tokens = {p.get("token") for p in self.positions.values()}
                wanted.sort(key=lambda token: (token not in managed_tokens, -float(self.quotes.get(token, {}).get("volume_traded", 0)) * float(self.quotes.get(token, {}).get("last_price", 0))))
                if wanted:
                    self._event("intraday_history", "Loading completed five-minute candles, prioritising current turnover.", {"remaining": len(wanted)})
                for token in wanted:
                    if not self.connected or not market_hours():
                        break
                    now = now_ist()
                    boundary = now.replace(minute=now.minute // 5 * 5, second=0, microsecond=0)
                    start = now.replace(hour=9, minute=15, second=0, microsecond=0)
                    if boundary <= start:
                        break
                    try:
                        rows = await self.broker.call("historical_data", token, start, boundary - timedelta(seconds=1), "5minute")
                        self._seed_intraday(token, rows, boundary)
                        self._intraday_history_loaded.add(token)
                    except BrokerError as exc:
                        self._intraday_history_failed += 1
                        if exc.kind == "TokenException":
                            self.connected = False
                            self._halt("Authentication expired loading intraday history. Reconnect Zerodha.", "auth_expired")
                            break
                    if len(self._intraday_history_loaded) % 100 == 0:
                        self._event("intraday_history", "Intraday warmup progress.",
                                    {"loaded": len(self._intraday_history_loaded), "failed": self._intraday_history_failed,
                                     "warmed": sum(len(b.bars) >= 21 for b in self.books.values()), "total": len(self.universe)})
                    await asyncio.sleep(0.1)
                await asyncio.sleep(15)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._event("intraday_history_error", f"Intraday warmup failed ({type(exc).__name__}); observed candles remain available.", level="error")
                await asyncio.sleep(30)

    def _seed_intraday(self, token, rows, boundary):
        book = self.books.get(token)
        if book is None:
            return
        merged = {b.time: b for b in book.bars}
        for row in rows:
            at = parse_time(row.get("date"))
            if at is None or at.date() != boundary.date() or at + timedelta(minutes=5) > boundary:
                continue
            if at.strftime("%H:%M") < "09:15" or at.minute % 5 or at.second:
                continue
            values = [float(row[k]) for k in ("open", "high", "low", "close", "volume")]
            if not all(math.isfinite(v) for v in values) or min(values[:4]) <= 0 or values[4] < 0:
                continue
            if values[1] < max(values[0], values[3]) or values[2] > min(values[0], values[3]):
                continue
            if book.current and at >= book.current.time:
                continue
            merged[at] = Candle(at, *values)
        book.bars = deque((merged[key] for key in sorted(merged)), maxlen=80)
        self._queue_current_analysis(token)
        # The historical endpoint supplied the earlier portion of the current
        # session, but cannot complete the currently forming observed candle.

    def _analyze_holdings(self):
        """Read all NSE holdings; management permission is a separate decision."""
        config = self.strategy_settings()
        selected = set(config.get("managed_symbols", []))
        results = []
        for holding in self.account.get("holdings", []):
            if holding.get("exchange") != "NSE":
                continue
            symbol = holding.get("tradingsymbol", "")
            token = int(holding.get("instrument_token", 0))
            quantity = max(0, int(holding.get("quantity", 0)) - int(holding.get("used_quantity", 0)) - int(holding.get("collateral_quantity", 0)))
            managed = config.get("manage_existing_holdings") == "all" or symbol in selected
            bars = self.daily.get(token, [])
            record = {"symbol": symbol, "quantity": quantity, "managed": managed,
                      "status": "warming_up", "reason": "Waiting for completed daily candles.",
                      "action": "analysis_only"}
            research = self._analysis_cache.get(("swing", token), {}).get("holding")
            if len(bars) >= 21 and research:
                trailing = research["trailing"]
                trend_exit = research["trend_exit"]
                quote = self.quotes.get(token, {})
                fresh = time.monotonic() - quote.get("received_at", 0) <= 10
                stop_exit = fresh and float(quote.get("last_price", 0)) <= trailing
                record.update(status="exit_candidate" if trend_exit or stop_exit else "hold",
                              reason="Completed daily trend weakened." if trend_exit else "Daily ATR stop breached." if stop_exit else "Daily trend and ATR exit conditions not triggered.",
                              trailing_reference=round(trailing, 2))
                key = self.day + ":" + symbol
                if self.mode == "paper" and self.running and managed and quantity > 0 and (trend_exit or stop_exit) and fresh and key not in self._paper_holding_actions:
                    bid = (quote.get("depth", {}).get("buy") or [{}])[0].get("price", 0)
                    if bid > 0:
                        action = {**record, "action": "simulated_sell", "price": float(bid) * 0.9995,
                                  "time": now_ist().isoformat(), "note": "Shadow holding exit; your actual holding is unchanged."}
                        self._paper_holding_actions[key] = action
                        self.store.set("paper_holding_actions", self._paper_holding_actions)
                        self._event("paper_holding_exit", f"Simulated exit of {quantity} existing {symbol} shares.", action)
                if key in self._paper_holding_actions and self.mode == "paper":
                    record["action"] = "simulated_sell"
            results.append(record)
        self.holdings_signals = results

    def snapshot(self):
        positions = []
        for p in self.positions.values():
            positions.append({**p, "unrealised": round((p.get("last", p["entry"]) - p["entry"]) * p["quantity"] - p.get("entry_fee", 0), 2)})
        pending = any(i.get("state") not in {"closed", "rejected"} for i in self.intents.values())
        delivery_state = self.delivery.snapshot() if self.delivery else {}
        delivery_busy = any(p.get("status") != "closed" for p in delivery_state.get("positions", {}).values())
        unrealised = self._unrealised()
        return jsonable({"mode": self.mode, "status": self.status, "connected": self.connected,
                         "user_id": self.user_id, "capital": self.capital,
                         "equity": round(self.capital + self.realised + unrealised, 2),
                         "realised_pnl": round(self.realised, 2), "unrealised_pnl": round(unrealised, 2),
                         "daily_pnl": round(self._daily_pnl(), 2), "pnl_fees_estimated": True,
                         "risk_used": round(sum(max(0, p["entry"] - p["stop"]) * p["quantity"] for p in self.positions.values()), 2),
                         "universe_count": len(self.universe),
                         "subscribed_count": sum(min(3000, len(self.universe) - i * 3000) for i, ready in self.streams.items() if ready),
                         "warmed_count": sum(len(b.bars) >= 21 for b in self.books.values()),
                         "swing_warmed_count": len(self.daily), "swing_history_failures": self._history_failures,
                         "heartbeat": self._heartbeat, "market_open": market_hours(),
                         "feed_fresh": time.monotonic() - self._last_tick_received <= 10,
                         "account_fresh": time.monotonic() - self._account_at <= 45,
                         "positions": positions, "account": self.account, "signals": list(self.signals),
                         "holdings_signals": self.holdings_signals,
                         "delivery": delivery_state,
                         "performance": self.analytics.snapshot(len(self._analysis_pending), len(self._analysis_cache)),
                         "intents": list(self.intents.values())[-100:], "strategy_settings": self.strategy_settings(),
                         "pending_orders": [i for i in self.intents.values() if i.get("state") not in {"closed", "rejected", "open"}] +
                                           [p for p in delivery_state.get("positions", {}).values() if p.get("status") != "closed"],
                         "safe_to_stop": not self._other_mode_live_risk() and (self.mode != "live" or (not positions and not pending and not delivery_busy and not self.running)),
                         "unmanaged_live_exposure": self._other_mode_live_risk(),
                         "message": self.message, "error": self.error,
                         "recovery": dict(self.recovery),
                         "live_swing_supported": True,
                         "limitations": ["Strategies are unvalidated research rules, not proven profitable models.",
                                         "Paper fills include a 0.05% price adjustment and estimated 0.1% fees per side.",
                                         "Live delivery requires verified DDPI/POA. GTT limits do not guarantee fills through gaps or circuits.",
                                         "Exchange holidays are inferred from fresh market data; no holiday calendar is assumed."]})
