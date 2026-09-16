"""Thin Kite SDK adapter. REST mutations are never automatically retried."""
from __future__ import annotations

import asyncio
from datetime import date, datetime
import logging
import re
import time


def jsonable(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()
                if str(k).lower() not in {"access_token", "api_key", "api_secret", "request_token", "password", "enctoken"}}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


class BrokerError(RuntimeError):
    def __init__(self, kind: str, detail=""):
        self.kind = kind
        self.detail = detail
        super().__init__(f"Zerodha request failed ({kind}). Check account activity and reconnect if needed.")


class KiteBroker:
    def __init__(self, api_key, access_token):
        from kiteconnect import KiteConnect
        self.client = KiteConnect(api_key=api_key, access_token=access_token, timeout=8)
        self.api_key, self.access_token = api_key, access_token
        self._rest_lock = asyncio.Lock()
        self._last_call = 0.0
        self._last_quote = 0.0
        self.sockets = []
        # SDK error messages can contain connection URLs. Application logs its
        # own code-only feed errors; never log SDK HTTP bodies or URL secrets.
        logging.getLogger("kiteconnect.ticker").disabled = True

    async def call(self, method, *args, **kwargs):
        async with self._rest_lock:
            # Serial calls keep the application well below general API limits.
            await asyncio.sleep(max(0, 0.36 - (time.monotonic() - self._last_call)))
            if method == "quote":
                await asyncio.sleep(max(0, 1.05 - (time.monotonic() - self._last_quote)))
                self._last_quote = time.monotonic()
            self._last_call = time.monotonic()
            try:
                return await asyncio.to_thread(getattr(self.client, method), *args, **kwargs)
            except Exception as exc:
                detail = str(exc)
                for secret in (self.api_key, self.access_token):
                    if secret:
                        detail = detail.replace(secret, "[redacted]")
                detail = re.sub(r"https?://\S+", "[broker endpoint]", detail)[:500]
                raise BrokerError(type(exc).__name__, detail) from None

    async def account(self):
        result = {}
        for key in ("margins", "holdings", "positions", "orders", "trades"):
            result[key] = jsonable(await self.call(key))
        result["updated_at"] = datetime.now().astimezone().isoformat()
        return result

    async def buy_cover(self, symbol, quantity, price, stop, tag):
        # https://kite.trade/docs/connect/v3/orders/#multi-legged-orders-co
        # Broker creates the protective second leg; no separate naked BUY.
        return await self.call("place_order", variety="co", exchange="NSE",
                               tradingsymbol=symbol, transaction_type="BUY", quantity=quantity,
                               product="MIS", order_type="LIMIT", price=price,
                               trigger_price=stop, validity="DAY", tag=tag)

    async def cancel_cover(self, order_id, parent_order_id=None):
        # Cancelling a CO second leg requests the broker-managed exit. Never
        # follow with an independent SELL, which could create a short position.
        kwargs = {"variety": "co", "order_id": str(order_id)}
        if parent_order_id:
            kwargs["parent_order_id"] = str(parent_order_id)
        return await self.call("cancel_order", **kwargs)

    async def stream(self, tokens, on_ticks, on_order, on_status):
        from kiteconnect import KiteTicker
        from twisted.internet import reactor
        if len(tokens) > 9000:
            raise ValueError("Universe exceeds Kite's 9,000-instrument streaming capacity.")
        loop = asyncio.get_running_loop()
        def deliver(callback, *args):
            if not loop.is_closed():
                loop.call_soon_threadsafe(callback, *args)
        for index, offset in enumerate(range(0, len(tokens), 3000)):
            chunk = list(tokens[offset:offset + 3000])
            ticker = KiteTicker(self.api_key, self.access_token, reconnect=True,
                                reconnect_max_tries=50, reconnect_max_delay=60)
            def connected(ws, response, i=index, selected=chunk):
                ws.subscribe(selected)
                ws.set_mode(ws.MODE_FULL, selected)
                deliver(on_status, i, True, selected)
            ticker.on_connect = connected
            ticker.on_ticks = lambda ws, ticks: deliver(on_ticks, ticks)
            ticker.on_order_update = lambda ws, order: deliver(on_order, jsonable(order))
            ticker.on_close = lambda ws, code, reason, i=index, selected=chunk: deliver(on_status, i, False, selected)
            ticker.on_error = lambda ws, code, reason, i=index, selected=chunk: deliver(on_status, i, False, selected)
            self.sockets.append(ticker)
            if reactor.running:
                reactor.callFromThread(ticker.connect, threaded=True)
            else:
                ticker.connect(threaded=True)
            # First socket starts the shared Twisted reactor; subsequent calls
            # must be scheduled on its own thread.
            for _ in range(100):
                if reactor.running:
                    break
                await asyncio.sleep(0.01)

    def close(self):
        if not self.sockets:
            return
        from twisted.internet import reactor
        for ticker in self.sockets:
            if reactor.running:
                reactor.callFromThread(ticker.close)
        self.sockets.clear()
