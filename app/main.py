"""Authenticated web application. Run one worker; trading outlives browser sessions."""
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from datetime import datetime, timedelta, time as daytime, timezone
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import time
from urllib.parse import urlencode, urlparse
from zoneinfo import ZoneInfo

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError
import httpx

from .config import Settings
from .security import BodyLimitMiddleware, LoginLimiter, ProcessLock, digest_token
from .storage import Store
from .resources import ResourceMonitor

STATIC = Path(__file__).parent / "static"
COOKIE = "stockpilot_session"
IST = ZoneInfo("Asia/Kolkata")


class LoginBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=512)


class StrategySettings(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    intraday_enabled: bool = True
    swing_enabled: bool = False
    intraday_capital: float = Field(default=100000, ge=0)
    swing_capital: float = Field(default=0, ge=0)
    manage_existing_holdings: str = "selected"
    managed_symbols: list[str] = Field(default_factory=list, max_length=500)


class KitePostback(BaseModel):
    """Validate notification identity; all order state is independently verified."""
    model_config = ConfigDict(extra="ignore", strict=True)
    order_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    order_timestamp: str = Field(min_length=19, max_length=19, pattern=r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
    user_id: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9]+$")
    checksum: str = Field(min_length=64, max_length=64, pattern=r"^[a-fA-F0-9]+$")


def unique_json_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


async def exchange_token(settings, request_token):
    checksum = hashlib.sha256((settings.kite_api_key + request_token + settings.kite_api_secret).encode()).hexdigest()
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post("https://api.kite.trade/session/token", headers={"X-Kite-Version": "3"}, data={
            "api_key": settings.kite_api_key, "request_token": request_token, "checksum": checksum})
        response.raise_for_status()
        payload = response.json()
    if payload.get("status") != "success" or not payload.get("data", {}).get("access_token"):
        raise ValueError("Kite authentication did not produce a session")
    return payload["data"]


def create_app(settings=None, engine_factory=None):
    @asynccontextmanager
    async def lifespan(app):
        async with AsyncExitStack() as resources:
            await initialize(app, resources)
            yield

    async def initialize(app, resources):
        cfg = settings or Settings.from_env()
        cfg.validate()
        lock = ProcessLock(cfg.data_dir / "server.lock")
        lock.acquire()
        resources.callback(lock.release)
        store = Store(cfg.data_dir / "stockpilot.sqlite3", (cfg.kite_api_key, cfg.kite_api_secret, cfg.session_secret, cfg.token_encryption_key, cfg.admin_password_hash))
        resources.callback(store.close)
        from .trading import TradingEngine
        engine = (engine_factory or TradingEngine)(cfg, store)
        async def stop_engine():
            try:
                await engine.shutdown()
            finally:
                store.event("server.stopped", "Server stopped; local monitoring is offline. Existing broker orders remain at Zerodha.", level="warning")
        resources.push_async_callback(stop_engine)
        app.state.settings, app.state.store, app.state.engine = cfg, store, engine
        app.state.control_lock = asyncio.Lock()
        app.state.login_lock = asyncio.Lock()
        app.state.postback_lock = asyncio.Lock()
        app.state.last_postback_reconciliation = float("-inf")
        app.state.streams = 0
        app.state.resources = ResourceMonitor()
        app.state.limiter = LoginLimiter(store)
        app.state.cipher = Fernet(cfg.token_encryption_key.encode())
        fingerprint = digest_token(cfg.admin_username + ":" + cfg.admin_password_hash, cfg.session_secret)
        if store.get("admin_fingerprint") != fingerprint:
            store.revoke_sessions()
            store.set("admin_fingerprint", fingerprint)
        if store.get("strategy_settings") is None:
            store.set("strategy_settings", StrategySettings(intraday_capital=cfg.capital).model_dump())
        store.event("server.started", "Server started. New entries remain paused until Start Trading is selected.", {"mode": cfg.trading_mode})
        saved = store.get("kite_session")
        if saved:
            try:
                session = json.loads(app.state.cipher.decrypt(saved.encode()))
                if session["expires"] > time.time() and session["user_id"].upper() == cfg.kite_user_id.upper():
                    store.add_secret(session["access_token"])
                    await engine.connect(session["access_token"], session["user_id"])
                    store.event("session.restored", "Zerodha monitoring restored. New entries are paused.")
                else:
                    store.delete("kite_session")
            except Exception:
                store.event("session.restore_failed", "Reconnect to Zerodha. The saved session could not be restored.", level="warning")

        async def record_equity():
            while True:
                await asyncio.sleep(30)
                view = engine.snapshot()
                equity = view.get("equity")
                if view.get("connected") and isinstance(equity, (int, float)):
                    store.sample(cfg.trading_mode, equity)
        sampler = asyncio.create_task(record_equity())
        async def stop_sampler():
            sampler.cancel()
            with suppress(asyncio.CancelledError):
                await sampler
        resources.push_async_callback(stop_sampler)

    app = FastAPI(title="StockPilot", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(BodyLimitMiddleware)

    @app.middleware("http")
    async def secure_request(request, call_next):
        cfg = getattr(app.state, "settings", None)
        if cfg:
            host = request.headers.get("host", "").split(":", 1)[0]
            allowed = {urlparse(cfg.public_url).hostname}
            if cfg.app_env != "production":
                allowed.update({"localhost", "127.0.0.1", "testserver"})
            # Deployment health requests are loopback-only; all public requests require the configured host.
            if request.url.path == "/health":
                allowed.add("127.0.0.1")
            if host not in allowed:
                return JSONResponse({"detail": "Unrecognized host"}, status_code=400)
            if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
                is_postback = request.method == "POST" and request.url.path == "/api/kite/postback"
                if not is_postback and request.headers.get("origin", "").rstrip("/") != cfg.public_url.rstrip("/"):
                    return JSONResponse({"detail": "Invalid request origin"}, status_code=403)
                size = request.headers.get("content-length", "0")
                if not size.isdigit() or int(size) > 32768:
                    return JSONResponse({"detail": "Request too large"}, status_code=413)
        response = await call_next(request)
        response.headers.update({
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://kite.zerodha.com",
        })
        if cfg and cfg.secure_cookies:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    def authenticated(request, mutation=False):
        cfg, store = app.state.settings, app.state.store
        value = request.cookies.get(COOKIE, "")
        digest = digest_token(value, cfg.session_secret)
        session = store.session(digest) if value else None
        if not session:
            raise HTTPException(401, "Sign in to continue")
        if mutation and not hmac.compare_digest(request.headers.get("x-csrf-token", "").encode(), session["csrf"].encode()):
            raise HTTPException(403, "Invalid session protection token")
        return session

    def ready_to_start():
        cfg = app.state.settings
        if (cfg.data_dir / "maintenance.lock").exists():
            raise HTTPException(409, "Server maintenance is in progress")
        if not cfg.configured:
            raise HTTPException(409, "Set the Kite API key, secret and Zerodha client ID on the server first")
        if cfg.trading_mode == "live" and (not cfg.live_trading_enabled or cfg.live_capital <= 0):
            raise HTTPException(409, "Live trading requires LIVE_TRADING_ENABLED=true and an explicit LIVE_CAPITAL allocation")

    def public_snapshot():
        cfg, engine, store = app.state.settings, app.state.engine, app.state.store
        return {**store.redact(engine.snapshot()), "configured": cfg.configured,
                "resources": app.state.resources.snapshot(),
                "strategy_settings": store.get("strategy_settings"),
                "limits": {"capital": cfg.capital, "risk_per_trade_pct": cfg.risk_per_trade_pct,
                           "daily_loss_pct": cfg.daily_loss_pct, "max_positions": cfg.max_positions,
                           "max_position_pct": cfg.max_position_pct, "entry_cutoff": cfg.entry_cutoff, "exit_time": cfg.exit_time},
                "server_time": datetime.now(IST).isoformat(), "maintenance": (cfg.data_dir / "maintenance.lock").exists()}

    @app.get("/health")
    async def health():
        state = app.state.engine.snapshot()
        return {"status": "ok", "safe_to_stop": state.get("safe_to_stop") is True}

    @app.post("/api/kite/postback")
    async def kite_postback(request: Request):
        cfg, store = app.state.settings, app.state.store
        if not cfg.configured:
            raise HTTPException(503, "Kite account is not configured")
        try:
            payload = json.loads(await request.body(), object_pairs_hook=unique_json_fields)
            body = KitePostback.model_validate(payload)
            datetime.strptime(body.order_timestamp, "%Y-%m-%d %H:%M:%S")
            # Canonicalize all fields so distinct partial-fill/price/status updates
            # sharing a checksum are not mistaken for retries. Reject non-JSON numbers.
            canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
        except (ValueError, TypeError, UnicodeDecodeError, RecursionError, ValidationError):
            raise HTTPException(400, "Invalid Kite postback payload") from None
        expected = hashlib.sha256((body.order_id + body.order_timestamp + cfg.kite_api_secret).encode()).hexdigest()
        valid_checksum = hmac.compare_digest(expected, body.checksum.lower())
        valid_account = hmac.compare_digest(body.user_id.upper().encode(), cfg.kite_user_id.upper().encode())
        if not valid_checksum or not valid_account:
            raise HTTPException(403, "Invalid Kite postback authentication")
        signature = hashlib.sha256(canonical.encode()).hexdigest()
        async with app.state.postback_lock:
            now = time.time()
            seen = [item for item in store.get("kite_postback_receipts", []) if item["received_at"] > now - 86400]
            if not any(item["signature"] == signature for item in seen):
                # The checksum does not cover status, quantities or prices. Never
                # pass the payload to _on_order, mutate positions, or submit orders.
                store.event("kite.postback_received", "Kite order notification received. Order state is verified separately with Zerodha.",
                            {"order_id": body.order_id, "order_timestamp": body.order_timestamp})
                store.set("kite_postback_receipts", (seen + [{"signature": signature, "received_at": now}])[-2048:])
                tick = time.monotonic()
                if tick - app.state.last_postback_reconciliation >= 15:
                    app.state.engine.request_reconciliation()
                    app.state.last_postback_reconciliation = tick
        return {"status": "success"}

    @app.get("/")
    @app.get("/settings")
    async def index(request: Request):
        try:
            authenticated(request)
        except HTTPException:
            return RedirectResponse("/login", status_code=303)
        return FileResponse(STATIC / "index.html")

    @app.get("/login")
    async def login_page():
        return FileResponse(STATIC / "login.html")

    @app.post("/api/login")
    async def login(request: Request, body: LoginBody):
        cfg, store = app.state.settings, app.state.store
        ip = request.client.host if request.client else "unknown"
        async with app.state.login_lock:
            if not app.state.limiter.check(ip):
                raise HTTPException(429, "Too many sign-in attempts. Try again in 15 minutes.")
            try:
                valid_password = await asyncio.to_thread(PasswordHasher().verify, cfg.admin_password_hash, body.password)
            except (VerificationError, InvalidHashError):
                valid_password = False
            if not hmac.compare_digest(body.username.encode(), cfg.admin_username.encode()) or not valid_password:
                app.state.limiter.failure(ip)
                store.event("auth.failed", "An unsuccessful dashboard sign-in was recorded.", level="warning")
                raise HTTPException(401, "Incorrect username or password")
            token, csrf = secrets.token_urlsafe(48), secrets.token_urlsafe(32)
            store.new_session(digest_token(token, cfg.session_secret), csrf, time.time() + 12 * 3600)
            store.event("auth.login", "Administrator signed in to the dashboard.")
        response = JSONResponse({"ok": True})
        response.set_cookie(COOKIE, token, max_age=12 * 3600, httponly=True, secure=cfg.secure_cookies, samesite="lax", path="/")
        return response

    @app.get("/api/session")
    async def session_view(request: Request):
        session = authenticated(request)
        return {"username": app.state.settings.admin_username, "csrf": session["csrf"], "expires": session["expires"]}

    @app.post("/api/logout")
    async def logout(request: Request):
        session = authenticated(request, True)
        app.state.store.drop_session(session["digest"])
        app.state.store.event("auth.logout", "Administrator signed out. Trading state is unchanged.")
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE, path="/")
        return response

    @app.get("/api/state")
    async def state(request: Request):
        authenticated(request)
        return {"state": public_snapshot(), "events": app.state.store.latest_events(), "equity_history": app.state.store.samples(app.state.settings.trading_mode)}

    @app.get("/api/events")
    async def events(request: Request, after: int = 0):
        authenticated(request)
        return app.state.store.events(max(0, after))

    @app.get("/api/events/export")
    async def export_events(request: Request):
        authenticated(request)
        latest = app.state.store.latest_events(1)
        last_id = latest[0]["id"] if latest else 0
        async def generate():
            after = 0
            while after < last_id:
                if not app.state.store.session(authenticated(request)["digest"]):
                    return
                batch = app.state.store.events(after, 500)
                for event in batch:
                    if event["id"] > last_id:
                        return
                    yield json.dumps(event, default=str) + "\n"
                    after = event["id"]
                if not batch:
                    break
                await asyncio.sleep(0)
        return StreamingResponse(generate(), media_type="application/x-ndjson", headers={"Content-Disposition": 'attachment; filename="stockpilot-audit.ndjson"'})

    @app.get("/api/stream")
    async def stream(request: Request, after: int = 0):
        session = authenticated(request)
        if app.state.streams >= 8:
            raise HTTPException(429, "Too many live dashboard connections")
        app.state.streams += 1
        async def generate():
            cursor = max(0, after)
            try:
                while not await request.is_disconnected():
                    if not app.state.store.session(session["digest"]):
                        yield 'event: expired\ndata: {}\n\n'
                        return
                    rows = app.state.store.events(cursor)
                    if rows:
                        cursor = rows[-1]["id"]
                    payload = {"state": public_snapshot(), "events": rows}
                    yield "event: update\ndata: " + json.dumps(payload, default=str, allow_nan=False) + "\n\n"
                    await asyncio.sleep(2)
            finally:
                app.state.streams -= 1
        return StreamingResponse(generate(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})

    @app.put("/api/settings")
    async def update_settings(request: Request, body: StrategySettings):
        authenticated(request, True)
        cfg = app.state.settings
        if body.manage_existing_holdings not in ("all", "selected"):
            raise HTTPException(422, "Choose all or selected holdings")
        if any(not s or len(s) > 40 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&-." for c in s) for s in body.managed_symbols):
            raise HTTPException(422, "Use valid uppercase NSE trading symbols")
        if body.intraday_capital + body.swing_capital > cfg.capital + 0.001:
            raise HTTPException(422, "Strategy allocations cannot exceed the configured trading capital")
        if body.intraday_enabled and body.intraday_capital <= 0 or body.swing_enabled and body.swing_capital <= 0:
            raise HTTPException(422, "Each enabled strategy needs a positive capital allocation")
        async with app.state.control_lock:
            view = app.state.engine.snapshot()
            if view.get("status") == "running" or view.get("positions") or view.get("pending_orders"):
                raise HTTPException(409, "Pause new entries and close managed positions before changing strategy allocations")
            if (cfg.data_dir / "maintenance.lock").exists():
                raise HTTPException(409, "Server maintenance is in progress")
            values = body.model_dump()
            values["managed_symbols"] = sorted(set(values["managed_symbols"]))
            app.state.store.set("strategy_settings", values)
            app.state.store.event("settings.changed", "Trading strategies and holding permissions updated.", values)
        return {"ok": True, "settings": values}

    @app.post("/api/trading/start")
    async def start(request: Request):
        session = authenticated(request, True)
        async with app.state.control_lock:
            ready_to_start()
            view = app.state.engine.snapshot()
            if view.get("connected"):
                try:
                    await app.state.engine.start()
                except (ValueError, RuntimeError) as exc:
                    raise HTTPException(409, app.state.store.redact(str(exc))) from None
                return {"ok": True}
            nonce = secrets.token_urlsafe(32)
            app.state.store.set("oauth:" + session["digest"], {"nonce": nonce, "expires": time.time() + 600})
            params = urlencode({"v": "3", "api_key": app.state.settings.kite_api_key, "redirect_params": urlencode({"state": nonce})})
            app.state.store.event("session.login_requested", "Start Trading requested. Waiting for Zerodha sign-in.")
            return {"redirect_url": "https://kite.zerodha.com/connect/login?" + params}

    @app.get("/auth/kite/callback")
    async def kite_callback(request: Request):
        try:
            session = authenticated(request)
        except HTTPException:
            return RedirectResponse("/login?error=expired", status_code=303)
        store, cfg = app.state.store, app.state.settings
        async with app.state.control_lock:
            pending = store.get("oauth:" + session["digest"])
            state_value = request.query_params.get("state", "")
            if not pending or pending["expires"] < time.time() or not hmac.compare_digest(pending["nonce"].encode(), state_value.encode()):
                store.event("session.rejected", "A Zerodha callback failed its session check.", level="warning")
                return RedirectResponse("/?error=callback", status_code=303)
            store.delete("oauth:" + session["digest"])
            token = request.query_params.get("request_token", "")
            if not token or len(token) > 1024 or request.query_params.get("status") != "success":
                return RedirectResponse("/?error=kite_login", status_code=303)
            store.add_secret(token)
            try:
                ready_to_start()
                result = await exchange_token(cfg, token)
                if str(result.get("user_id", "")).upper() != cfg.kite_user_id.upper():
                    store.event("session.wrong_account", "Zerodha login rejected: client ID did not match the configured account.", level="error")
                    return RedirectResponse("/?error=wrong_account", status_code=303)
                access = result["access_token"]
                store.add_secret(access)
                expiry = datetime.combine(datetime.now(IST).date() + timedelta(days=1), daytime(6), IST).timestamp()
                saved = {"access_token": access, "user_id": result["user_id"], "expires": expiry}
                store.set("kite_session", app.state.cipher.encrypt(json.dumps(saved).encode()).decode())
                await app.state.engine.connect(access, result["user_id"])
                store.event("session.connected", "Zerodha account connected. Live account monitoring is active.")
                await app.state.engine.start()
            except Exception:
                # Never include broker exception text here; it may contain a secret-bearing URL.
                store.event("session.start_failed", "Zerodha session could not start trading. Check the dashboard status and reconnect if needed.", level="error")
                return RedirectResponse("/?error=start", status_code=303)
        return RedirectResponse("/", status_code=303)

    @app.post("/api/trading/pause")
    async def pause(request: Request):
        authenticated(request, True)
        async with app.state.control_lock:
            await app.state.engine.pause()
        return {"ok": True}

    @app.post("/api/trading/flatten")
    async def flatten(request: Request):
        authenticated(request, True)
        async with app.state.control_lock:
            try:
                await app.state.engine.flatten()
            except (ValueError, RuntimeError) as exc:
                raise HTTPException(409, app.state.store.redact(str(exc))) from None
        return {"ok": True}

    app.mount("/static", StaticFiles(directory=STATIC, check_dir=False), name="static")
    return app


app = create_app()
