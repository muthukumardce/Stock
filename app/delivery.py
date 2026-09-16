"""Durable delivery order lifecycle and opt-in management of existing holdings.

Kite does not offer idempotency keys or atomic CNC entry + GTT placement. Every
mutation is recorded before submission, never retried blindly, and ambiguous
results stop new delivery entries. IOC entries limit the unprotected fill window;
only a terminal order's confirmed filled quantity is protected. GTT is a broker
trigger for a LIMIT order, not a guaranteed exit through gaps/circuits.

References: https://kite.trade/docs/connect/v3/{orders,gtt,portfolio,user}/
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from math import isfinite
from statistics import mean
from time import monotonic
from uuid import uuid4

from .strategy import Candle, atr

IST = timezone(timedelta(hours=5, minutes=30))
TERMINAL = {"COMPLETE", "CANCELLED", "REJECTED"}
INACTIVE_GTT = {"deleted", "cancelled", "expired", "rejected", "disabled"}


def _now():
    return datetime.now(IST).isoformat()


def _price(value, tick=0.05, up=False):
    if not isfinite(float(value)) or not isfinite(float(tick)) or value <= 0 or tick <= 0:
        raise ValueError("Prices and tick sizes must be positive and finite")
    rounding = ROUND_CEILING if up else ROUND_FLOOR
    return float((Decimal(str(value)) / Decimal(str(tick))).to_integral_value(rounding=rounding) * Decimal(str(tick)))


def _quantity(value):
    number = int(value)
    if isinstance(value, bool) or number != value or number <= 0:
        raise ValueError("Quantity must be a positive integer")
    return number


def _matches_symbol(row, symbol):
    return row.get("exchange") == "NSE" and row.get("tradingsymbol") == symbol


def _holding_available(row):
    # Do not automatically sell unsettled, pledged, discrepant or MTF shares.
    if row.get("discrepancy") or row.get("product", "CNC") != "CNC":
        return 0
    return max(0, int(row.get("quantity", 0)) - int(row.get("used_quantity", 0))
               - int(row.get("collateral_quantity", 0)))


class DeliveryManager:
    """Single-process async manager. The caller owns live-mode/session gating.

    ``broker.call(name, *args, **kwargs)`` is the async Kite SDK adapter. Methods
    return JSON-safe dictionaries with ``status``, ``blocked`` and ``reason``.
    ``snapshot`` contains positions, durable intents and aggregate block reasons.
    Use one instance per account and one application worker for the SQLite file.
    """

    def __init__(self, store, broker, settings=None, now=None):
        self.store, self.broker, self.settings = store, broker, settings
        self.now = now or (lambda: datetime.now(IST))
        self.lock = asyncio.Lock()
        self.state = store.get("delivery_state", {"positions": {}, "intents": {}})

    def _save(self):
        self.store.set("delivery_state", self.state)

    def remap_tokens(self, tokens):
        for symbol, position in self.state["positions"].items():
            position["token"] = tokens.get(symbol, 0)
        self._save()

    def snapshot(self):
        result = deepcopy(self.state)
        for p in result["positions"].values():
            p.update(strategy="swing", mode="live", token=p.get("token", 0),
                     entry=p.get("entry_price", 0), last=p.get("last", p.get("entry_price", 0)),
                     tag=p.get("entry_intent", "existing"),
                     entry_fee=(p.get("entry_price", 0) * max(0, p.get("quantity", 0) - p.get("sold_quantity", 0)) * 0.001
                                if p.get("source") == "swing" else 0),
                     protection=p.get("gtt_id"), is_bot_owned=p.get("source") == "swing", origin=p.get("source"),
                     remaining_quantity=max(0, p.get("quantity", 0) - p.get("sold_quantity", 0)))
        result["realised_pnl"] = self.state.get("archived_pnl", 0) + sum(p.get("realised_pnl", 0) for p in result["positions"].values())
        result["bot_realised_pnl"] = self.state.get("archived_bot_pnl", 0) + sum(p.get("realised_pnl", 0)
            for p in result["positions"].values() if p.get("source") == "swing")
        result["existing_holdings_realised_pnl"] = result["realised_pnl"] - result["bot_realised_pnl"]
        result["reasons"] = [f"{symbol}: {p['reason']}" for symbol, p in result["positions"].items()
                             if p.get("blocked") and p.get("status") != "closed"]
        result["blocked"] = bool(result["reasons"])
        return result

    def _result(self, p=None, status=None, reason=None, blocked=None):
        return {"status": status or (p or {}).get("status", "ready"),
                "reason": reason if reason is not None else (p or {}).get("reason", ""),
                "blocked": blocked if blocked is not None else (p or {}).get("blocked", False),
                **({"position": deepcopy(p)} if p else {})}

    def _set(self, p, status, reason="", blocked=False):
        changed = (p.get("status"), p.get("reason"), p.get("blocked")) != (status, reason, blocked)
        p.update(status=status, reason=reason, blocked=blocked, updated_at=_now())
        self._save()
        if changed:
            self.store.event("delivery", f"{p['symbol']}: {reason or status}",
                             {"symbol": p["symbol"], "status": status}, level="error" if blocked else "info")
        return self._result(p)

    def _intent(self, kind, symbol, payload):
        tag = "dl" + uuid4().hex[:18]
        row = {"id": tag, "kind": kind, "symbol": symbol, "payload": payload,
               "state": "submitting", "created_at": _now()}
        self.state["intents"][tag] = row
        self._save()
        return row

    def _live_gate(self, buying=False):
        if self.settings is None or self.settings.trading_mode != "live" or not self.settings.live_trading_enabled:
            return "Live delivery trading is disabled by server configuration"
        if buying and ((self.settings.data_dir / "maintenance.lock").exists() or self.store.get("maintenance_lock", False)):
            return "Maintenance lock prevents new delivery entries"
        return ""

    def _session_open(self):
        at = self.now().astimezone(IST)
        return at.weekday() < 5 and time(9, 15) <= at.time().replace(tzinfo=None) < time(15, 30)

    def _fresh_quote(self, quote, max_age=30):
        at = quote.get("timestamp")
        if isinstance(at, str):
            at = datetime.fromisoformat(at)
        if not isinstance(at, datetime):
            return False
        if at.tzinfo is None:
            at = at.replace(tzinfo=IST)
        return -5 <= (self.now() - at).total_seconds() <= max_age

    def _quote_hint(self, hint):
        """Use a stream hint only when exchange and local receive clocks agree."""
        try:
            quote = dict(hint or {})
            quote["timestamp"] = quote.get("timestamp", quote.get("exchange_timestamp"))
            if 0 <= monotonic() - float(quote.get("received_at", 0)) <= 10 and self._fresh_quote(quote, max_age=10):
                return quote
        except (TypeError, ValueError, OverflowError):
            pass
        return None

    async def _profile_ready(self):
        profile = await self.broker.call("profile")
        # 'physical' is Kite's documented value meaning no daily CDSL flow.
        # A checkbox or today's authorised_quantity is not durable DDPI/POA.
        return profile.get("meta", {}).get("demat_consent") == "physical"

    async def _account(self):
        return {"orders": await self.broker.call("orders"),
                "holdings": await self.broker.call("holdings"),
                "positions": await self.broker.call("positions")}

    def _available(self, account, p):
        holdings = sum(_holding_available(h) for h in account.get("holdings", []) if _matches_symbol(h, p["symbol"]))
        if p.get("source") == "existing":
            return holdings
        positions = account.get("positions", {})
        rows = positions.get("net", []) if isinstance(positions, dict) else positions
        bought = sum(max(0, int(r.get("quantity", 0))) for r in rows
                     if _matches_symbol(r, p["symbol"]) and r.get("product") == "CNC")
        # A CNC purchase may appear in both endpoints around settlement. Never
        # add these numbers (which could double-count the same shares).
        return max(holdings, bought)

    @staticmethod
    def _gtt_symbol(gtt, symbol):
        return _matches_symbol(gtt.get("condition", {}), symbol)

    def _gtt_conflict(self, gtt, symbol):
        return self._gtt_symbol(gtt, symbol) and (gtt.get("status") == "active" or
            gtt.get("status") == "triggered" and str(gtt.get("id")) not in self.state.get("settled_gtts", []))

    @staticmethod
    def _gtt_order_ids(gtt):
        ids, ambiguous = [], False
        for order in gtt.get("orders", []):
            result = order.get("result")
            if result:
                outcome = result.get("order_result", {})
                oid = outcome.get("order_id")
                if oid:
                    ids.append(str(oid))
                elif outcome.get("status") != "failed":
                    ambiguous = True
        if gtt.get("status") == "triggered" and not any(o.get("result") for o in gtt.get("orders", [])):
            ambiguous = True
        return ids, ambiguous

    async def _order(self, intent, account):
        if intent.get("state") == "terminal":
            return intent["order"]
        rows = account.get("orders", [])
        if intent.get("order_id"):
            matches = [o for o in rows if str(o.get("order_id")) == str(intent["order_id"])]
            if not matches:
                try:
                    matches = await self.broker.call("order_history", str(intent["order_id"]))
                    matches = matches[-1:]
                except Exception:
                    return None
        else:
            matches = [o for o in rows if o.get("tag") == intent["id"]]
        if len(matches) != 1:
            return None
        order = matches[0]
        payload = intent["payload"]
        if (not _matches_symbol(order, intent["symbol"]) or order.get("product") != "CNC"
                or order.get("transaction_type") != payload.get("transaction_type")
                or int(order.get("quantity", -1)) != int(payload.get("quantity", -2))):
            return None
        intent.update(order_id=str(order["order_id"]), order=deepcopy(order),
                      state="terminal" if order.get("status") in TERMINAL else "acknowledged")
        self._save()
        return order

    async def _submit_order(self, p, kind, side, quantity, price):
        gate = self._live_gate(buying=side == "BUY")
        if gate:
            self._set(p, "blocked", gate, True)
            return None
        payload = {"variety": "regular", "exchange": "NSE", "tradingsymbol": p["symbol"],
                   "transaction_type": side, "quantity": quantity, "product": "CNC",
                   "order_type": "LIMIT", "price": price, "validity": "IOC"}
        intent = self._intent(kind, p["symbol"], payload)
        if kind == "entry":
            p["entry_intent"] = intent["id"]
        else:
            p.setdefault("exit_intents", []).append(intent["id"])
        # Intent and position association must both be durable before REST call.
        self._save()
        try:
            gate = self._live_gate(buying=side == "BUY")
            if gate:
                intent["state"] = "aborted"
                self._save()
                self._set(p, "closed" if kind == "entry" else "blocked", gate, kind != "entry")
                return None
            oid = await self.broker.call("place_order", **payload, tag=intent["id"])
            if not oid:
                raise ValueError("Missing broker order id")
            intent.update(order_id=str(oid), state="acknowledged")
        except Exception as exc:
            intent.update(state="unknown", error=type(exc).__name__)
        self._save()
        return intent

    async def submit_entry(self, symbol, quantity, limit_price, stop_price, target_price=None, tick_size=0.05, token=0):
        async with self.lock:
            quantity = _quantity(quantity)
            entry = _price(limit_price, tick_size, up=True)
            stop = _price(stop_price, tick_size)
            target = _price(target_price, tick_size, up=True) if target_price else None
            if not symbol or stop >= entry or (target is not None and target <= entry):
                raise ValueError("Require stop < entry < target")
            gate = self._live_gate(buying=True)
            if gate:
                return self._result(status="blocked", reason=gate, blocked=True)
            if not self._session_open():
                return self._result(status="waiting", reason="Delivery entry requires an open regular session", blocked=True)
            settings = self.store.get("strategy_settings", {})
            if not settings.get("swing_enabled", False) or float(settings.get("swing_capital", 0)) <= 0:
                return self._result(status="disabled", reason="Swing needs an enabled strategy and allocated funds", blocked=True)
            if self.snapshot()["blocked"]:
                return self._result(status="blocked", reason="Resolve existing delivery protection/order uncertainty first", blocked=True)
            previous = self.state["positions"].get(symbol)
            if previous and previous.get("status") != "closed":
                return self._result(previous)
            reserved = sum(float(p.get("entry_price", 0)) * int(p.get("requested_quantity", p.get("quantity", 0)))
                           for p in self.state["positions"].values()
                           if p.get("source") == "swing" and p.get("status") != "closed")
            if reserved + entry * quantity * 1.001 > float(settings["swing_capital"]):
                return self._result(status="blocked", reason="Swing allocation would be exceeded", blocked=True)
            try:
                if not await self._profile_ready():
                    return self._result(status="blocked", reason="Verified DDPI/POA is required for unattended delivery exits", blocked=True)
                account, gtts = await self._account(), await self.broker.call("get_gtts")
                probe = {"symbol": symbol, "source": "swing"}
                if self._available(account, probe) or any(_matches_symbol(o, symbol) and o.get("product") == "CNC"
                        and o.get("status") not in TERMINAL for o in account["orders"]):
                    return self._result(status="blocked", reason="Existing delivery exposure or order already owns this symbol", blocked=True)
                if any(self._gtt_conflict(g, symbol) for g in gtts):
                    return self._result(status="blocked", reason="Existing GTT requires reconciliation before entry", blocked=True)
                quote = (await self.broker.call("quote", ["NSE:" + symbol])).get("NSE:" + symbol, {})
                if not self._fresh_quote(quote):
                    return self._result(status="blocked", reason="Fresh exchange quote required before delivery entry", blocked=True)
            except Exception:
                return self._result(status="blocked", reason="Delivery preflight unavailable", blocked=True)
            p = {"symbol": symbol, "source": "swing", "status": "entry_pending", "blocked": True,
                 "reason": "Entry awaiting confirmed fills and GTT protection", "requested_quantity": quantity,
                 "quantity": 0, "sold_quantity": 0, "entry_price": entry, "stop": stop, "target": target,
                 "tick_size": tick_size, "token": token, "exit_intents": [], "gtt_order_ids": [], "created_at": _now()}
            if previous:
                self.state["archived_pnl"] = self.state.get("archived_pnl", 0) + previous.get("realised_pnl", 0)
                if previous.get("source") == "swing":
                    self.state["archived_bot_pnl"] = self.state.get("archived_bot_pnl", 0) + previous.get("realised_pnl", 0)
            self.state["positions"][symbol] = p
            self._save()
            if not await self._submit_order(p, "entry", "BUY", quantity, entry):
                return self._result(p)
            return await self._reconcile_position(p, await self._safe_account())

    async def _safe_account(self):
        try:
            return await self._account()
        except Exception:
            return None

    async def _protect(self, p):
        remaining = p["quantity"] - p.get("sold_quantity", 0)
        if remaining <= 0:
            return self._set(p, "closed")
        if p.get("gtt_intent"):
            intent = self.state["intents"][p["gtt_intent"]]
            # GTT has no client tag. Only adopt a unique newly-created exact
            # payload match relative to a persisted pre-submission snapshot.
            if not p.get("gtt_id"):
                try:
                    gtts = await self.broker.call("get_gtts")
                    matches = [g for g in gtts if str(g.get("id")) not in intent["before_ids"] and self._same_gtt(g, intent["payload"])]
                    if len(matches) == 1:
                        p["gtt_id"] = str(matches[0]["id"])
                        intent.update(state="acknowledged", trigger_id=p["gtt_id"])
                        self._save()
                    else:
                        return self._set(p, "blocked", "GTT placement is ambiguous; do not repeat or sell", True)
                except Exception:
                    return self._set(p, "blocked", "GTT placement cannot be reconciled", True)
            return None
        gate = self._live_gate()
        if gate:
            return self._set(p, "blocked", gate, True)
        try:
            if not await self._profile_ready():
                return self._set(p, "blocked", "DDPI/POA verification required before GTT protection", True)
            quotes = await self.broker.call("quote", ["NSE:" + p["symbol"]])
            quote = quotes.get("NSE:" + p["symbol"], {})
            last = float(quote.get("last_price", 0))
            if not isfinite(last) or last <= p["stop"] or (p.get("target") and last >= p["target"]):
                return self._set(p, "blocked", "Price already crossed the planned GTT boundary; exit review required", True)
            gtts = await self.broker.call("get_gtts")
            if any(self._gtt_conflict(g, p["symbol"]) for g in gtts):
                return self._set(p, "blocked", "Another GTT exists for this symbol; protection ownership uncertain", True)
            if sum(g.get("status") == "active" for g in gtts) >= 500:
                return self._set(p, "blocked", "Account GTT capacity exhausted", True)
            stop_limit = _price(p["stop"] * 0.995, p["tick_size"])
            low = float(quote.get("lower_circuit_limit", 0) or 0)
            if stop_limit < low:
                stop_limit = _price(low, p["tick_size"], up=True)
            if stop_limit > p["stop"] or stop_limit <= 0:
                return self._set(p, "blocked", "Protective limit is outside the current circuit range", True)
            values, prices = [p["stop"]], [stop_limit]
            if p.get("target"):
                values.append(p["target"])
                prices.append(p["target"])
            payload = {"trigger_type": "two-leg" if p.get("target") else "single", "tradingsymbol": p["symbol"],
                       "exchange": "NSE", "trigger_values": values, "last_price": last,
                       "orders": [{"exchange": "NSE", "tradingsymbol": p["symbol"], "transaction_type": "SELL",
                                   "quantity": remaining, "order_type": "LIMIT", "product": "CNC", "price": price}
                                  for price in prices]}
            intent = self._intent("gtt", p["symbol"], payload)
            intent["before_ids"] = [str(g.get("id")) for g in gtts]
            p["gtt_intent"] = intent["id"]
            self._save()
            try:
                response = await self.broker.call("place_gtt", **payload)
                if not response.get("trigger_id"):
                    raise ValueError("Missing trigger id")
                p["gtt_id"] = str(response["trigger_id"])
                intent.update(state="acknowledged", trigger_id=p["gtt_id"])
            except Exception as exc:
                intent.update(state="unknown", error=type(exc).__name__)
                self._save()
                return self._set(p, "blocked", "GTT placement response uncertain; reconciling without retry", True)
            self._save()
            return None
        except Exception:
            return self._set(p, "blocked", "Unable to establish broker-held GTT protection", True)

    @staticmethod
    def _same_gtt(gtt, payload):
        condition = gtt.get("condition", {})
        if (gtt.get("type") != payload["trigger_type"] or condition.get("exchange") != "NSE"
                or condition.get("tradingsymbol") != payload["tradingsymbol"]
                or condition.get("trigger_values") != payload["trigger_values"]):
            return False
        fields = ("exchange", "tradingsymbol", "transaction_type", "quantity", "order_type", "product", "price")
        return [[o.get(k) for k in fields] for o in gtt.get("orders", [])] == [[o.get(k) for k in fields] for o in payload["orders"]]

    async def _gtt_fills(self, p, gtt, account):
        ids, ambiguous = self._gtt_order_ids(gtt)
        if ambiguous:
            return False, "Triggered GTT has an unresolved exchange order"
        for oid in ids:
            if oid not in p.setdefault("gtt_order_ids", []):
                p["gtt_order_ids"].append(oid)
        fills, pending = 0, False
        for oid in p.get("gtt_order_ids", []):
            prior = p.setdefault("gtt_orders", {}).get(oid)
            if prior and prior.get("status") in TERMINAL:
                order = prior
            else:
                matches = [o for o in account["orders"] if str(o.get("order_id")) == oid]
                if not matches:
                    try:
                        matches = (await self.broker.call("order_history", oid))[-1:]
                    except Exception:
                        return False, "Triggered GTT order cannot be reconciled"
                if not matches:
                    return False, "Triggered GTT order is missing"
                order = matches[-1]
                if not _matches_symbol(order, p["symbol"]) or order.get("product") != "CNC" or order.get("transaction_type") != "SELL":
                    return False, "Triggered GTT order identity mismatch"
                p["gtt_orders"][oid] = deepcopy(order)
            fills += int(order.get("filled_quantity", 0))
            pending = pending or order.get("status") not in TERMINAL
        p["gtt_filled_quantity"] = fills
        if not pending and gtt.get("status") == "triggered":
            settled = self.state.setdefault("settled_gtts", [])
            if str(gtt["id"]) not in settled:
                settled.append(str(gtt["id"]))
        self._save()
        return not pending, "Triggered GTT sell remains open" if pending else ""

    async def _reconcile_position(self, p, account):
        if p.get("status") == "closed":
            return self._result(p)
        if account is None:
            return self._set(p, "blocked", "Broker account unavailable; delivery reconciliation required", True)
        if p.get("entry_intent"):
            order = await self._order(self.state["intents"][p["entry_intent"]], account)
            if order:
                p["quantity"] = int(order.get("filled_quantity", 0))
                if p["quantity"]:
                    p["entry_price"] = float(order.get("average_price") or p["entry_price"])
            if not order or order.get("status") not in TERMINAL:
                return self._set(p, "entry_pending", "Entry outcome unresolved; no additional entry or duplicate retry", True)
            p["quantity"] = int(order.get("filled_quantity", 0))
            if p["quantity"] == 0:
                return self._set(p, "closed", "Entry ended without a fill")
            if p["quantity"] > p["requested_quantity"]:
                return self._set(p, "blocked", "Entry filled more than the intended quantity", True)
            p["entry_price"] = float(order.get("average_price") or p["entry_price"])
        explicit_fills, unresolved_exit = 0, False
        for iid in p.get("exit_intents", []):
            order = await self._order(self.state["intents"][iid], account)
            if not order or order.get("status") not in TERMINAL:
                unresolved_exit = True
            explicit_fills += int((order or {}).get("filled_quantity", 0))
        p["sold_quantity"] = explicit_fills + int(p.get("gtt_filled_quantity", 0))
        self._realised(p)
        if unresolved_exit:
            return self._set(p, "exit_pending", "Exit outcome unresolved; no duplicate sell", True)
        if p["sold_quantity"] > p["quantity"]:
            return self._set(p, "blocked", "Sell fills exceed managed quantity; reconcile account immediately", True)
        if p["sold_quantity"] == p["quantity"]:
            self._realised(p)
            return self._set(p, "closed", "Confirmed delivery exit")
        if p.get("exit_requested") and not p.get("gtt_id") and not p.get("gtt_intent"):
            return self._set(p, "exit_pending", "Residual shares await a confirmed follow-up exit", True)
        if not p.get("gtt_id"):
            if not p.get("gtt_intent") and self._available(account, p) < p["quantity"] - p["sold_quantity"]:
                return self._set(p, "blocked", "Delivery quantity changed while offline; verify shares before creating protection", True)
            protection = await self._protect(p)
            if protection:
                return protection
        try:
            gtt = await self.broker.call("get_gtt", p["gtt_id"])
        except Exception:
            return self._set(p, "blocked", "GTT status unavailable; do not create another trigger or sell", True)
        complete, reason = await self._gtt_fills(p, gtt, account)
        p["sold_quantity"] = explicit_fills + int(p.get("gtt_filled_quantity", 0))
        self._realised(p)
        if not complete:
            return self._set(p, "exit_pending", reason, True)
        if p["sold_quantity"] > p["quantity"]:
            return self._set(p, "blocked", "Sell fills exceed managed quantity; reconcile account immediately", True)
        if p["sold_quantity"] == p["quantity"]:
            self._realised(p)
            return self._set(p, "closed", "Confirmed GTT exit")
        if p.get("exit_requested"):
            return self._set(p, "exit_pending", "Explicit exit requested; reconcile trigger before selling", True)
        intent = self.state["intents"].get(p.get("gtt_intent"), {})
        if gtt.get("status") != "active" or not self._same_gtt(gtt, intent.get("payload", {})):
            return self._set(p, "blocked", "GTT is inactive or changed; remaining shares are not verified protected", True)
        try:
            others = await self.broker.call("get_gtts")
            if any(self._gtt_conflict(g, p["symbol"]) and str(g.get("id")) != p["gtt_id"] for g in others):
                return self._set(p, "blocked", "Additional GTT on managed symbol; exit ownership is ambiguous", True)
        except Exception:
            return self._set(p, "blocked", "Cannot verify exclusive GTT protection ownership", True)
        if self._available(account, p) < p["quantity"] - p["sold_quantity"]:
            return self._set(p, "blocked", "Delivery quantity changed outside this strategy; reconcile GTT before trading", True)
        return self._set(p, "protected", "Broker-held GTT verified for confirmed delivery quantity")

    def _realised(self, p):
        orders = list(p.get("gtt_orders", {}).values())
        orders += [self.state["intents"][iid].get("order", {}) for iid in p.get("exit_intents", [])]
        value = sum(float(o.get("average_price", 0)) * int(o.get("filled_quantity", 0)) for o in orders)
        qty = sum(int(o.get("filled_quantity", 0)) for o in orders)
        # Estimated costs are deliberately explicit; contract-note costs should
        # replace this estimate in reporting/reconciliation.
        p["realised_pnl"] = value - qty * p.get("entry_price", 0) - value * 0.001 - qty * p.get("entry_price", 0) * 0.001
        p["pnl_is_estimate"] = True

    async def cancel_pending_entries(self):
        """Pause entries without cancelling protection on filled shares."""
        async with self.lock:
            results = []
            account = await self._safe_account()
            if account is None:
                return self._result(status="blocked", reason="Cannot reconcile pending delivery entries", blocked=True)
            for p in self.state["positions"].values():
                if not p.get("entry_intent") or p.get("status") == "closed":
                    continue
                intent = self.state["intents"][p["entry_intent"]]
                order = await self._order(intent, account)
                if not order:
                    results.append(self._set(p, "blocked", "Unknown entry cannot be cancelled or retried safely", True))
                    continue
                if order.get("status") not in TERMINAL and not p.get("entry_cancel_intent"):
                    cancel = self._intent("cancel_entry", p["symbol"], {"order_id": intent["order_id"]})
                    p["entry_cancel_intent"] = cancel["id"]
                    self._save()
                    try:
                        await self.broker.call("cancel_order", variety="regular", order_id=intent["order_id"])
                        cancel["state"] = "acknowledged"
                    except Exception:
                        cancel["state"] = "unknown"
                    self._save()
                results.append(await self._reconcile_position(p, await self._safe_account()))
            return {"status": "paused", "blocked": any(r["blocked"] for r in results), "reason": "", "results": results}

    async def reconcile(self, account=None):
        async with self.lock:
            account = account if account is not None else await self._safe_account()
            results = []
            for p in self.state["positions"].values():
                try:
                    results.append(await self._reconcile_position(p, account))
                except Exception:
                    results.append(self._set(p, "blocked", "Delivery reconciliation failed", True))
            return {"status": "blocked" if self.snapshot()["blocked"] else "ready", "blocked": self.snapshot()["blocked"],
                    "reason": "; ".join(self.snapshot()["reasons"]), "results": results}

    async def _disarm(self, p, account):
        # Unknown GTT creation must first resolve, never be bypassed by a SELL.
        if p.get("gtt_intent") and not p.get("gtt_id"):
            result = await self._protect(p)
            if result:
                return False, result["reason"]
        if not p.get("gtt_id"):
            return True, ""
        try:
            gtt = await self.broker.call("get_gtt", p["gtt_id"])
            if gtt.get("status") == "active":
                original = self.state["intents"].get(p.get("gtt_intent"), {}).get("payload")
                if not original or not self._same_gtt(gtt, original):
                    return False, "GTT was changed outside this manager; reconcile before cancellation"
                cancel_key = p.get("gtt_cancel_intent")
                if not cancel_key:
                    cancel = self._intent("cancel_gtt", p["symbol"], {"trigger_id": p["gtt_id"]})
                    p["gtt_cancel_intent"] = cancel["id"]
                    self._save()
                    try:
                        await self.broker.call("delete_gtt", p["gtt_id"])
                        cancel["state"] = "acknowledged"
                    except Exception:
                        cancel["state"] = "unknown"
                    self._save()
                # HTTP success is insufficient: it may have triggered during
                # cancellation. Always inspect the resulting trigger and order.
                gtt = await self.broker.call("get_gtt", p["gtt_id"])
            if gtt.get("status") not in INACTIVE_GTT | {"triggered"}:
                return False, "GTT cancellation not confirmed; explicit sell withheld"
            complete, reason = await self._gtt_fills(p, gtt, account)
            if not complete:
                # Keep the actual triggered LIMIT order; do not introduce a
                # second competing exit. Reconciliation resumes after terminal.
                return False, reason
            return True, ""
        except Exception:
            return False, "GTT cancellation/trigger outcome unknown; explicit sell withheld"

    async def request_exit(self, symbol, quantity, limit_price, reason="Strategy exit"):
        async with self.lock:
            quantity = _quantity(quantity)
            p = self.state["positions"].get(symbol)
            if not p or p.get("status") == "closed":
                return self._result(p, status="closed", reason="No managed delivery quantity remains")
            gate = self._live_gate()
            if gate:
                return self._set(p, "blocked", gate, True)
            if not self._session_open():
                return self._result(p, status="waiting", reason="Delivery exit requires an open regular session", blocked=True)
            price = _price(limit_price, p["tick_size"])
            try:
                if not await self._profile_ready():
                    return self._set(p, "blocked", "DDPI/POA is required for unattended holdings selling", True)
                quote = (await self.broker.call("quote", ["NSE:" + symbol])).get("NSE:" + symbol, {})
                bids = quote.get("depth", {}).get("buy") or []
                if not self._fresh_quote(quote) or not bids or float(bids[0].get("price", 0)) <= 0 or int(bids[0].get("quantity", 0)) <= 0:
                    return self._result(p, status="waiting", reason="Fresh exchange quote and executable bid required for exit", blocked=True)
                account = await self._account()
            except Exception:
                return self._set(p, "blocked", "Exit preflight unavailable", True)
            # Finish every previous intent before any new request; in particular
            # a timeout may still have reached the exchange.
            if p.get("entry_intent"):
                entry = await self._order(self.state["intents"][p["entry_intent"]], account)
                if not entry or entry.get("status") not in TERMINAL:
                    return self._set(p, "blocked", "Entry is not terminal; exit quantity is uncertain", True)
                p["quantity"] = int(entry.get("filled_quantity", 0))
            explicit_fills = 0
            for iid in p.get("exit_intents", []):
                order = await self._order(self.state["intents"][iid], account)
                if not order or order.get("status") not in TERMINAL:
                    return self._set(p, "exit_pending", "Prior exit unresolved; duplicate sell withheld", True)
                explicit_fills += int(order.get("filled_quantity", 0))
            p["exit_requested"] = {"reason": reason, "price": price, "quantity": quantity, "at": _now()}
            self._save()
            safe, why = await self._disarm(p, account)
            if not safe:
                return self._set(p, "exit_pending", why, True)
            try:
                gtts = await self.broker.call("get_gtts")
                if any(self._gtt_conflict(g, symbol) and str(g.get("id")) != p.get("gtt_id") for g in gtts):
                    return self._set(p, "blocked", "Another unresolved GTT can sell these shares; explicit exit withheld", True)
            except Exception:
                return self._set(p, "blocked", "Cannot verify other GTTs before explicit exit", True)
            p["sold_quantity"] = explicit_fills + int(p.get("gtt_filled_quantity", 0))
            remaining = p["quantity"] - p["sold_quantity"]
            if remaining < 0:
                return self._set(p, "blocked", "Sell fills exceed managed quantity; reconcile account immediately", True)
            if remaining == 0:
                self._realised(p)
                return self._set(p, "closed", "Exit already filled by GTT")
            # Account read follows confirmed trigger resolution, closing the
            # cancel-vs-trigger race before calculating a residual SELL.
            account = await self._safe_account()
            if account is None:
                return self._set(p, "blocked", "Fresh holdings unavailable after GTT cancellation", True)
            if any(_matches_symbol(o, symbol) and o.get("product") == "CNC" and o.get("transaction_type") == "SELL"
                   and o.get("status") not in TERMINAL for o in account["orders"]):
                return self._set(p, "exit_pending", "Another CNC sell is open; additional sell withheld", True)
            quantity = min(quantity, remaining)
            if self._available(account, p) < quantity:
                return self._set(p, "blocked", "Insufficient verified free delivery shares for exit", True)
            await self._submit_order(p, "exit", "SELL", quantity, price)
            result = await self._reconcile_position(p, await self._safe_account())
            # IOC partial exits are deliberately retried only by a subsequent
            # strategy evaluation, after terminal fills are durably reconciled.
            return result

    @staticmethod
    def _daily_bars(rows):
        bars = []
        today = datetime.now(IST).date()
        for row in rows:
            if isinstance(row, Candle):
                bar = row
            else:
                at = row.get("time", row.get("date"))
                at = datetime.fromisoformat(at) if isinstance(at, str) else at
                bar = Candle(at, float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"]), float(row["volume"]))
            if bar.time and bar.time.date() < today:
                bars.append(bar)
        bars.sort(key=lambda b: b.time)
        if len(bars) < 21 or (today - bars[-1].time.date()).days > 7:
            return []
        if any(not all(isfinite(x) and x > 0 for x in (b.open, b.high, b.low, b.close)) or b.high < b.low for b in bars[-21:]):
            return []
        recent = bars[-22:]
        if any(abs(b.open / a.close - 1) > 0.2 or (b.time.date() - a.time.date()).days > 7
               for a, b in zip(recent, recent[1:])):
            return []
        return bars

    async def evaluate_holdings(self, bars_by_symbol, settings, quotes_by_symbol=None, *, adopt_new=True):
        """Evaluate opted-in existing holdings and all strategy-owned swings.

        Uses completed daily SMA20 trend loss or a 3*ATR14 trailing close stop.
        Existing holdings management does not require new swing capital. Quote
        inputs are optional hints; actual exits fetch a fresh broker quote.
        Paused callers pass adopt_new=False to continue previously authorized
        position exits without taking control of additional holdings.
        """
        results = []
        evaluated_symbols = set()
        mode = settings.get("manage_existing_holdings", "selected")
        selected = set(settings.get("managed_symbols", []))
        async with self.lock:
            account = await self._safe_account() if adopt_new else {"holdings": []}
            if account is None:
                return self._result(status="blocked", reason="Holdings evaluation unavailable", blocked=True)
            for holding in account["holdings"]:
                symbol = holding.get("tradingsymbol", "")
                if holding.get("exchange") != "NSE" or not (mode == "all" or mode == "selected" and symbol in selected):
                    continue
                if symbol in self.state["positions"] and self.state["positions"][symbol].get("status") != "closed":
                    continue
                qty = _holding_available(holding)
                bars = self._daily_bars(bars_by_symbol.get(symbol, []))
                if not qty or not bars or atr(bars) <= 0:
                    results.append(self._result(status="waiting", reason=f"{symbol}: settled shares and valid daily bars required"))
                    continue
                try:
                    if not await self._profile_ready():
                        results.append(self._result(status="blocked", reason=f"{symbol}: DDPI/POA required", blocked=True))
                        continue
                    gtts = await self.broker.call("get_gtts")
                    if any(self._gtt_conflict(g, symbol) for g in gtts):
                        results.append(self._result(status="blocked", reason=f"{symbol}: existing external GTT needs review", blocked=True))
                        continue
                    if any(_matches_symbol(o, symbol) and o.get("product") == "CNC" and o.get("status") not in TERMINAL for o in account["orders"]):
                        results.append(self._result(status="blocked", reason=f"{symbol}: external CNC order needs review", blocked=True))
                        continue
                except Exception:
                    results.append(self._result(status="blocked", reason=f"{symbol}: delivery preflight unavailable", blocked=True))
                    continue
                tick = float((quotes_by_symbol or {}).get(symbol, {}).get("tick_size", 0.05))
                p = {"symbol": symbol, "source": "existing", "quantity": qty, "requested_quantity": qty,
                     "token": holding.get("instrument_token", 0),
                     "sold_quantity": 0, "entry_price": float(holding.get("average_price", 0)), "tick_size": tick,
                     "stop": _price(max(tick, max(b.close for b in bars[-20:]) - 3 * atr(bars)), tick),
                     "target": None, "exit_intents": [], "gtt_order_ids": [], "created_at": _now(),
                     "status": "managing", "blocked": False, "reason": "Existing holding selected for management"}
                previous = self.state["positions"].get(symbol)
                if previous:
                    self.state["archived_pnl"] = self.state.get("archived_pnl", 0) + previous.get("realised_pnl", 0)
                    if previous.get("source") == "swing":
                        self.state["archived_bot_pnl"] = self.state.get("archived_bot_pnl", 0) + previous.get("realised_pnl", 0)
                self.state["positions"][symbol] = p
                self._save()
        # Public methods acquire the same lock, so run evaluations outside it.
        for symbol, p in list(self.state["positions"].items()):
            if p.get("status") == "closed":
                continue
            if p.get("source") == "existing" and not (mode == "all" or mode == "selected" and symbol in selected):
                continue
            bars = self._daily_bars(bars_by_symbol.get(symbol, []))
            if not bars or atr(bars) <= 0:
                results.append(self._result(status="waiting", reason=f"{symbol}: valid completed daily bars required"))
                continue
            trailing = _price(max(p.get("trailing_stop", p.get("stop", 0)), max(b.close for b in bars[-20:]) - 3 * atr(bars)), p["tick_size"])
            p["trailing_stop"] = trailing
            self._save()
            trend_exit = bars[-1].close < mean(b.close for b in bars[-20:]) and mean(b.close for b in bars[-5:]) < mean(b.close for b in bars[-20:])
            try:
                quote = self._quote_hint((quotes_by_symbol or {}).get(symbol))
                if quote is None:
                    quote = (await self.broker.call("quote", ["NSE:" + symbol])).get("NSE:" + symbol, {})
                price = float(quote.get("last_price", 0))
                if not isfinite(price) or price <= 0:
                    raise ValueError("No current quote")
                if not self._fresh_quote(quote):
                    raise ValueError("Stale quote")
                if trend_exit or price <= trailing or p.get("exit_requested"):
                    if not self._fresh_quote(quote):
                        raise ValueError("Stale quote")
                    bid = float((quote.get("depth", {}).get("buy") or [{}])[0].get("price") or 0)
                    if bid <= 0:
                        raise ValueError("No executable bid")
                    results.append(await self.request_exit(symbol, max(1, p["quantity"] - p.get("sold_quantity", 0)), bid,
                                                          "Daily trend loss" if trend_exit else "Daily ATR trailing exit"))
                else:
                    async with self.lock:
                        results.append(await self._reconcile_position(p, await self._safe_account()))
                if not results[-1].get("blocked"):
                    evaluated_symbols.add(symbol)
            except Exception:
                results.append(self._result(status="blocked", reason=f"{symbol}: quote/exit evaluation failed", blocked=True))
        return {"status": "blocked" if any(r["blocked"] for r in results) else "ready",
                "blocked": any(r["blocked"] for r in results), "reason": "", "results": results,
                "evaluated_symbols": sorted(evaluated_symbols)}
