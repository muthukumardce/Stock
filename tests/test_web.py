from dataclasses import replace
import json
from urllib.parse import urlparse, parse_qs

from argon2 import PasswordHasher
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
import pytest

from app.config import Settings
from app.main import create_app
from app.security import ProcessLock
from app.storage import Store

PASSWORD = "a-long-test-password-only"


class FakeEngine:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store
        self.connected = False
        self.status = "disconnected"
        self.positions = []
        self.starts = 0

    async def connect(self, token, user_id):
        self.connected = True
        self.status = "monitoring"

    async def start(self):
        self.status = "running"
        self.starts += 1

    async def pause(self):
        self.status = "paused"

    async def flatten(self):
        self.positions = []
        self.status = "paused"

    async def shutdown(self):
        pass

    def snapshot(self):
        return {"mode": self.settings.trading_mode, "status": self.status,
                "connected": self.connected, "equity": 100000, "positions": self.positions,
                "account": {}, "safe_to_stop": not self.positions}


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path, public_url="http://testserver",
                    session_secret="s" * 40, token_encryption_key=Fernet.generate_key().decode(),
                    admin_password_hash=PasswordHasher().hash(PASSWORD), kite_api_key="testapikey",
                    kite_api_secret="testapisecret", kite_user_id="AB1234")


def login(client, password=PASSWORD):
    result = client.post("/api/login", json={"username": "admin", "password": password}, headers={"Origin": "http://testserver"})
    assert result.status_code == 200, result.text
    session = client.get("/api/session").json()
    return {"Origin": "http://testserver", "X-CSRF-Token": session["csrf"]}


def test_authentication_origin_csrf_and_logout(settings):
    with TestClient(create_app(settings, FakeEngine)) as client:
        assert client.get("/api/state").status_code == 401
        assert client.get("/", follow_redirects=False).headers["location"] == "/login"
        assert client.post("/api/login", json={"username": "admin", "password": PASSWORD}).status_code == 403
        headers = login(client)
        assert client.get("/api/state").status_code == 200
        assert client.post("/api/trading/pause", headers={"Origin": "http://testserver"}).status_code == 403
        assert client.post("/api/trading/pause", headers={**headers, "Origin": "https://evil.test"}).status_code == 403
        assert client.post("/api/logout", headers=headers).status_code == 200
        assert client.get("/api/session").status_code == 401


def test_body_limit_handles_chunked_and_declared_lengths(settings):
    with TestClient(create_app(settings, FakeEngine)) as client:
        oversized = json.dumps({"username": "admin", "password": PASSWORD}).encode() + b" " * 50000
        headers = {"Origin": "http://testserver", "Content-Type": "application/json"}
        assert client.post("/api/login", content=oversized, headers=headers).status_code == 413
        assert client.post("/api/login", content=iter([oversized[:100], oversized[100:]]), headers=headers).status_code == 413


def test_login_rate_limit_persists(settings):
    for attempt in range(2):
        with TestClient(create_app(settings, FakeEngine)) as client:
            if attempt == 0:
                for _ in range(5):
                    assert client.post("/api/login", json={"username": "admin", "password": "incorrect"}, headers={"Origin": "http://testserver"}).status_code == 401
            assert client.post("/api/login", json={"username": "admin", "password": PASSWORD}, headers={"Origin": "http://testserver"}).status_code == 429


def test_credential_rotation_revokes_previous_sessions(settings):
    with TestClient(create_app(settings, FakeEngine)) as client:
        login(client)
        cookies = dict(client.cookies)
    changed = replace(settings, admin_password_hash=PasswordHasher().hash("a-new-password-for-testing"))
    with TestClient(create_app(changed, FakeEngine)) as client:
        client.cookies.update(cookies)
        assert client.get("/api/session").status_code == 401


def test_oauth_state_single_use_account_binding_and_encrypted_storage(settings, monkeypatch):
    import app.main as main
    calls = []
    async def exchange(cfg, token):
        calls.append(token)
        return {"access_token": "super-secret-token-value", "user_id": "AB1234"}
    monkeypatch.setattr(main, "exchange_token", exchange)
    app = create_app(settings, FakeEngine)
    with TestClient(app) as client:
        headers = login(client)
        redirect = client.post("/api/trading/start", headers=headers).json()["redirect_url"]
        state = parse_qs(parse_qs(urlparse(redirect).query)["redirect_params"][0])["state"][0]
        bad = client.get("/auth/kite/callback", params={"state": "é", "request_token": "requestsecret", "status": "success"}, follow_redirects=False)
        assert bad.status_code == 303 and not calls
        args = {"state": state, "request_token": "requestsecret", "status": "success"}
        result = client.get("/auth/kite/callback", params=args, follow_redirects=False)
        assert result.status_code == 303 and result.headers["location"] == "/"
        assert app.state.engine.starts == 1
        encrypted = app.state.store.get("kite_session")
        assert "super-secret-token-value" not in encrypted
        assert json.loads(Fernet(settings.token_encryption_key).decrypt(encrypted.encode()))["user_id"] == "AB1234"
        client.get("/auth/kite/callback", params=args, follow_redirects=False)
        assert len(calls) == 1
        audit = client.get("/api/events/export").text
        assert "super-secret-token-value" not in audit and "requestsecret" not in audit


def test_wrong_zerodha_account_never_starts(settings, monkeypatch):
    async def exchange(cfg, token):
        return {"access_token": "wrong-account-secret", "user_id": "ZZ0000"}
    monkeypatch.setattr("app.main.exchange_token", exchange)
    app = create_app(settings, FakeEngine)
    with TestClient(app) as client:
        headers = login(client)
        redirect = client.post("/api/trading/start", headers=headers).json()["redirect_url"]
        state = parse_qs(parse_qs(urlparse(redirect).query)["redirect_params"][0])["state"][0]
        result = client.get("/auth/kite/callback", params={"state": state, "status": "success", "request_token": "123"}, follow_redirects=False)
        assert result.headers["location"] == "/?error=wrong_account"
        assert app.state.engine.starts == 0
        assert app.state.store.get("kite_session") is None


def test_https_tunnel_login_and_callback_keep_same_origin(settings, monkeypatch):
    origin = "https://stockpilot-example.trycloudflare.com"
    cfg = replace(settings, public_url=origin, app_env="production")

    async def exchange(_cfg, _token):
        return {"access_token": "https-test-access-token", "user_id": "AB1234"}

    monkeypatch.setattr("app.main.exchange_token", exchange)
    app = create_app(cfg, FakeEngine)
    with TestClient(app, base_url=origin) as client:
        response = client.post("/api/login", json={"username": "admin", "password": PASSWORD},
                               headers={"Origin": origin})
        assert response.status_code == 200
        cookie = response.headers["set-cookie"].lower()
        assert "secure" in cookie and "httponly" in cookie and "samesite=lax" in cookie
        csrf = client.get("/api/session").json()["csrf"]
        headers = {"Origin": origin, "X-CSRF-Token": csrf}
        assert client.get("/api/state").status_code == 200
        assert client.get("/", headers={"Host": "localhost:3000"}).status_code == 400
        assert client.post("/api/trading/start", headers={**headers, "Origin": "http://localhost:3000"}).status_code == 403
        redirect = client.post("/api/trading/start", headers=headers).json()["redirect_url"]
        state = parse_qs(parse_qs(urlparse(redirect).query)["redirect_params"][0])["state"][0]
        callback = client.get("/auth/kite/callback", params={"state": state,
                              "status": "success", "request_token": "https-test-request-token"},
                              follow_redirects=False)
        assert callback.status_code == 303 and callback.headers["location"] == "/"
        assert app.state.engine.connected and app.state.engine.starts == 1


def test_restart_restores_broker_monitoring_before_resuming_entries(settings, monkeypatch):
    async def exchange(_cfg, _token):
        return {"access_token": "restart-test-token", "user_id": "AB1234"}

    monkeypatch.setattr("app.main.exchange_token", exchange)
    first = create_app(settings, FakeEngine)
    with TestClient(first) as client:
        headers = login(client)
        redirect = client.post("/api/trading/start", headers=headers).json()["redirect_url"]
        state = parse_qs(parse_qs(urlparse(redirect).query)["redirect_params"][0])["state"][0]
        client.get("/auth/kite/callback", params={"state": state, "status": "success", "request_token": "restart-request"})
        assert first.state.engine.starts == 1

    restored = create_app(settings, FakeEngine)
    with TestClient(restored) as client:
        assert restored.state.engine.connected
        assert restored.state.engine.status == "monitoring"
        assert restored.state.engine.starts == 0
        headers = login(client)
        assert restored.state.engine.starts == 0  # Admin sign-in alone never submits trades.
        response = client.post("/api/trading/start", headers=headers)
        assert response.status_code == 200 and "redirect_url" not in response.json()
        assert restored.state.engine.starts == 1
        saved = json.loads(restored.state.cipher.decrypt(restored.state.store.get("kite_session").encode()))
        saved["expires"] = 0
        restored.state.store.set("kite_session", restored.state.cipher.encrypt(json.dumps(saved).encode()).decode())

    expired = create_app(settings, FakeEngine)
    with TestClient(expired) as client:
        assert not expired.state.engine.connected and expired.state.engine.starts == 0
        headers = login(client)
        response = client.post("/api/trading/start", headers=headers)
        assert response.status_code == 200 and "redirect_url" in response.json()
        assert expired.state.store.get("kite_session") is None


def test_strategy_settings_defaults_validation_and_open_position_guard(settings):
    app = create_app(settings, FakeEngine)
    with TestClient(app) as client:
        headers = login(client)
        config = client.get("/api/state").json()["state"]["strategy_settings"]
        assert config["intraday_enabled"] and not config["swing_enabled"]
        assert config["manage_existing_holdings"] == "selected"
        invalid = {**config, "swing_enabled": True, "swing_capital": 50000}
        assert client.put("/api/settings", json=invalid, headers=headers).status_code == 422
        valid = {**invalid, "intraday_capital": 50000, "managed_symbols": ["INFY", "INFY"]}
        result = client.put("/api/settings", json=valid, headers=headers)
        assert result.status_code == 200 and result.json()["settings"]["managed_symbols"] == ["INFY"]
        app.state.engine.positions = [{"symbol": "INFY", "quantity": 1}]
        assert client.put("/api/settings", json=config, headers=headers).status_code == 409


def test_maintenance_and_live_gate(settings):
    app = create_app(replace(settings, trading_mode="live"), FakeEngine)
    with TestClient(app) as client:
        headers = login(client)
        assert client.post("/api/trading/start", headers=headers).status_code == 409
    app = create_app(settings, FakeEngine)
    with TestClient(app) as client:
        headers = login(client)
        (settings.data_dir / "maintenance.lock").touch()
        assert client.post("/api/trading/start", headers=headers).status_code == 409


def test_shutdown_error_still_releases_store_and_process_lock(settings):
    class BrokenShutdown(FakeEngine):
        async def shutdown(self):
            raise RuntimeError("expected teardown error")
    app = create_app(settings, BrokenShutdown)
    with pytest.raises(RuntimeError, match="expected teardown"):
        with TestClient(app):
            pass
    lock = ProcessLock(settings.data_dir / "server.lock")
    lock.acquire()
    lock.release()
    import sqlite3
    with pytest.raises(sqlite3.ProgrammingError):
        app.state.store.get("anything")


def test_audit_redacts_structured_and_embedded_secrets(tmp_path):
    store = Store(tmp_path / "audit.db", secrets=["token-value-123"])
    store.event("test", "access_token=other-token and token-value-123", {"api_secret": "secret", "nested": [{"access_token": "hidden"}], "safe": "preserved"})
    serialized = json.dumps(store.events())
    assert "other-token" not in serialized and "token-value-123" not in serialized and "hidden" not in serialized
    assert "preserved" in serialized
    store.close()
