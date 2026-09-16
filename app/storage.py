"""Thread-safe SQLite state and durable append-only application audit history."""
import json
import re
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


SENSITIVE = re.compile(r"password|secret|token|authorization|cookie|checksum|api_key", re.I)


class Store:
    def __init__(self, path: Path, secrets=()):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.secrets = {str(value) for value in secrets if value and len(str(value)) > 5}
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=15)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
                kind TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (
                digest TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
                mode TEXT NOT NULL, equity REAL NOT NULL);
        """)

    def add_secret(self, value):
        if value:
            with self.lock:
                self.secrets.add(str(value))

    def redact(self, value):
        if isinstance(value, dict):
            return {str(k): "[redacted]" if SENSITIVE.search(str(k)) else self.redact(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.redact(v) for v in value]
        if isinstance(value, str):
            for secret in tuple(self.secrets):
                value = value.replace(secret, "[redacted]")
            return re.sub(r"(?i)(request_token|access_token|api_secret|password|authorization|checksum)=([^&\s]+)", r"\1=[redacted]", value)
        return value

    def get(self, key, default=None):
        with self.lock:
            row = self.db.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key, value):
        encoded = json.dumps(value, default=str, allow_nan=False)
        with self.lock, self.db:
            self.db.execute("INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, encoded))

    def delete(self, key):
        with self.lock, self.db:
            self.db.execute("DELETE FROM kv WHERE key=?", (key,))

    def event(self, kind, message, data=None, level="info"):
        with self.lock, self.db:
            cursor = self.db.execute("INSERT INTO events(timestamp,kind,level,message,data) VALUES(?,?,?,?,?)", (
                datetime.now(timezone.utc).isoformat(), kind, level, self.redact(str(message)),
                json.dumps(self.redact(data or {}), default=str, allow_nan=False)))
            return cursor.lastrowid

    def events(self, after=0, limit=200):
        with self.lock:
            rows = self.db.execute("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?", (after, min(max(limit, 1), 2000))).fetchall()
        return [{**dict(r), "data": json.loads(r["data"])} for r in rows]

    def latest_events(self, limit=100):
        with self.lock:
            rows = self.db.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (min(limit, 2000),)).fetchall()
        return [{**dict(r), "data": json.loads(r["data"])} for r in reversed(rows)]

    def new_session(self, digest, csrf, expires):
        import time
        with self.lock, self.db:
            self.db.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
            self.db.execute("INSERT INTO sessions VALUES(?,?,?)", (digest, csrf, expires))

    def session(self, digest):
        import time
        with self.lock:
            row = self.db.execute("SELECT * FROM sessions WHERE digest=? AND expires>?", (digest, time.time())).fetchone()
        return dict(row) if row else None

    def drop_session(self, digest):
        with self.lock, self.db:
            self.db.execute("DELETE FROM sessions WHERE digest=?", (digest,))

    def revoke_sessions(self):
        with self.lock, self.db:
            self.db.execute("DELETE FROM sessions")
            self.db.execute("DELETE FROM kv WHERE key LIKE 'oauth:%'")

    def sample(self, mode, equity):
        with self.lock, self.db:
            self.db.execute("INSERT INTO samples(timestamp,mode,equity) VALUES(?,?,?)", (datetime.now(timezone.utc).isoformat(), mode, equity))
            self.db.execute("DELETE FROM samples WHERE id < (SELECT COALESCE(MAX(id),0)-10000 FROM samples)")

    def samples(self, mode):
        with self.lock:
            rows = self.db.execute("SELECT timestamp,equity FROM samples WHERE mode=? ORDER BY id DESC LIMIT 180", (mode,)).fetchall()
        return [dict(r) for r in reversed(rows)]

    def close(self):
        with self.lock:
            self.db.close()
