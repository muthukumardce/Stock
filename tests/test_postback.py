"""Broker postbacks notify the monitor but never supply trusted execution state."""
import asyncio
from dataclasses import replace
import hashlib
import json

from argon2 import PasswordHasher
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
import pytest

from app.config import Settings
from app.main import create_app
from app.trading import TradingEngine


class NotificationEngine:
    def __init__(self, settings, store):
        self.requests = 0

    def request_reconciliation(self):
        self.requests += 1

    def snapshot(self):
        return {"connected": False, "safe_to_stop": True}

    async def shutdown(self):
        pass


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path, public_url="https://trading.example.com", app_env="production",
                    session_secret="s" * 40, token_encryption_key=Fernet.generate_key().decode(),
                    admin_password_hash=PasswordHasher().hash("test-password-for-postbacks"),
                    kite_api_key="test-app-key", kite_api_secret="test-api-secret", kite_user_id="AB1234")


def notification(settings, **changes):
    payload = {"order_id": "220303000308932", "order_timestamp": "2022-03-03 09:24:25",
               "user_id": "AB1234", "status": "UPDATE", "filled_quantity": 1, "pending_quantity": 3}
    payload.update(changes)
    payload["checksum"] = hashlib.sha256((payload["order_id"] + payload["order_timestamp"] + settings.kite_api_secret).encode()).hexdigest()
    return payload


def receipts(app):
    return [event for event in app.state.store.events() if event["kind"] == "kite.postback_received"]


def test_postback_without_login_origin_or_active_kite_session_only_notifies(settings):
    app = create_app(settings, NotificationEngine)
    body = notification(settings, status_message="untrusted message must not be logged")
    with TestClient(app, base_url=settings.public_url) as client:
        result = client.post("/api/kite/postback", json=body)
        assert result.status_code == 200 and result.json() == {"status": "success"}
        assert app.state.engine.requests == 1
        assert app.state.store.get("kite_session") is None
        assert receipts(app)[0]["data"] == {"order_id": body["order_id"], "order_timestamp": body["order_timestamp"]}
        audit = json.dumps(app.state.store.events())
        assert body["checksum"] not in audit
        assert "untrusted message" not in audit and "filled_quantity" not in audit


def test_duplicate_receipts_are_durable_but_changed_order_payload_is_not_suppressed(settings):
    body = notification(settings)
    for restart in range(2):
        app = create_app(settings, NotificationEngine)
        with TestClient(app, base_url=settings.public_url) as client:
            assert client.post("/api/kite/postback", json=body).status_code == 200
            assert client.post("/api/kite/postback", json=dict(reversed(list(body.items())))).status_code == 200
            assert len(receipts(app)) == 1
            assert app.state.engine.requests == (1 if restart == 0 else 0)
            if restart:
                changed = {**body, "filled_quantity": 2, "pending_quantity": 2}
                assert client.post("/api/kite/postback", json=changed).status_code == 200
                assert len(receipts(app)) == 2
                assert app.state.engine.requests == 1


def test_changed_notifications_cannot_force_unbounded_account_refreshes(settings):
    app = create_app(settings, NotificationEngine)
    with TestClient(app, base_url=settings.public_url) as client:
        # Keep the entire burst inside one throttle interval without patching the
        # event loop's global monotonic clock.
        app.state.last_postback_reconciliation = float("inf")
        for quantity in range(5):
            assert client.post("/api/kite/postback", json=notification(settings, filled_quantity=quantity)).status_code == 200
        assert app.state.engine.requests == 0 and len(receipts(app)) == 5


@pytest.mark.parametrize("change, expected", [
    ({"checksum": "0" * 64}, 403),
    ({"user_id": "ZZ0000"}, 403),
    ({"checksum": "invalid"}, 400),
    ({"order_id": "x" * 65}, 400),
    ({"order_id": 123}, 400),
    ({"user_id": ["AB1234"]}, 400),
    ({"order_timestamp": "2022-99-03 09:24:25"}, 400),
    ({"order_timestamp": None}, 400),
])
def test_bad_authentication_and_identity_fields_are_rejected(settings, change, expected):
    app = create_app(settings, NotificationEngine)
    with TestClient(app, base_url=settings.public_url) as client:
        result = client.post("/api/kite/postback", json={**notification(settings), **change})
        assert result.status_code == expected
        assert app.state.engine.requests == 0 and receipts(app) == []


@pytest.mark.parametrize("raw", [b"not json", b"[]", b"null", b'{"order_id": "a", "order_id": "b"}', b'\xff'])
def test_malformed_json_is_rejected_without_engine_actions(settings, raw):
    app = create_app(settings, NotificationEngine)
    with TestClient(app, base_url=settings.public_url) as client:
        assert client.post("/api/kite/postback", content=raw).status_code == 400
        assert app.state.engine.requests == 0 and receipts(app) == []


def test_postback_limits_cover_actual_bytes_and_nonfinite_json(settings):
    app = create_app(settings, NotificationEngine)
    with TestClient(app, base_url=settings.public_url) as client:
        body = json.dumps(notification(settings)).encode()
        too_large = body + b" " * 40000
        assert client.post("/api/kite/postback", content=too_large).status_code == 413
        assert client.post("/api/kite/postback", content=iter([too_large[:50], too_large[50:]])).status_code == 413
        assert client.post("/api/kite/postback", content=body, headers={"Content-Length": "50000"}).status_code == 413
        nonfinite = json.dumps({**notification(settings), "price": float("nan")})
        assert client.post("/api/kite/postback", content=nonfinite).status_code == 400
        assert app.state.engine.requests == 0 and receipts(app) == []


def test_public_postback_does_not_relax_other_host_origin_or_auth_guards(settings):
    app = create_app(settings, NotificationEngine)
    with TestClient(app, base_url=settings.public_url) as client:
        body = notification(settings)
        assert client.post("/api/kite/postback", json=body, headers={"Host": "evil.example.com"}).status_code == 400
        assert client.post("/api/login", json={"username": "admin", "password": "test-password-for-postbacks"}).status_code == 403
        assert client.post("/api/trading/start").status_code == 403
        assert client.post("/api/trading/start", headers={"Origin": settings.public_url}).status_code == 401
        assert client.put("/api/kite/postback", json=body).status_code == 403
        assert client.post("/api/kite/postback/", json=body).status_code == 403
        assert client.get("/api/state").status_code == 401
        assert app.state.engine.requests == 0


def test_unconfigured_postback_is_unavailable(settings):
    app = create_app(replace(settings, kite_api_secret=""), NotificationEngine)
    with TestClient(app, base_url=settings.public_url) as client:
        assert client.post("/api/kite/postback", json=notification(settings)).status_code == 503
        assert app.state.engine.requests == 0


def test_receipt_cache_expires_old_entries_and_is_bounded(settings):
    app = create_app(settings, NotificationEngine)
    with TestClient(app, base_url=settings.public_url) as client:
        from time import time
        now = time()
        app.state.store.set("kite_postback_receipts", [{"signature": str(i), "received_at": now} for i in range(2048)] +
                            [{"signature": "expired", "received_at": now - 86401}])
        assert client.post("/api/kite/postback", json=notification(settings)).status_code == 200
        cached = app.state.store.get("kite_postback_receipts")
        assert len(cached) == 2048 and all(item["signature"] not in {"0", "expired"} for item in cached)


def test_engine_notification_only_sets_reconciliation_event_until_shutdown():
    engine = TradingEngine.__new__(TradingEngine)
    engine._shutdown = False
    engine._reconcile_requested = asyncio.Event()
    engine.request_reconciliation()
    assert engine._reconcile_requested.is_set()
    engine._reconcile_requested.clear()
    engine._shutdown = True
    engine.request_reconciliation()
    assert not engine._reconcile_requested.is_set()
