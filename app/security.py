import hashlib
import hmac
import time
from pathlib import Path

from starlette.responses import JSONResponse


class BodyLimitMiddleware:
    """Enforce actual bytes received, including chunked requests without a length."""
    def __init__(self, app, max_body_size=32768):
        self.app, self.max_body_size = app, max_body_size

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH", "DELETE"}:
            return await self.app(scope, receive, send)
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            part = message.get("body", b"")
            size += len(part)
            if size > self.max_body_size:
                return await JSONResponse({"detail": "Request too large"}, status_code=413)(scope, receive, send)
            chunks.append(part)
            if not message.get("more_body", False):
                break
        replayed = False
        async def bounded_receive():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()
        return await self.app(scope, bounded_receive, send)


def digest_token(value: str, secret: str):
    return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()


class LoginLimiter:
    """Persist limits across restarts. Bound both the requesting IP and the account."""
    def __init__(self, store):
        self.store = store

    def keys(self, ip):
        return ["login_global", "login_ip:" + hashlib.sha256(ip.encode()).hexdigest()]

    def check(self, ip):
        now = time.time()
        return all(len([t for t in self.store.get(k, []) if t > now - 900]) < (30 if k == "login_global" else 5) for k in self.keys(ip))

    def failure(self, ip):
        now = time.time()
        for key in self.keys(ip):
            self.store.set(key, [t for t in self.store.get(key, []) if t > now - 900] + [now])


class ProcessLock:
    """Hold an OS lock so a second uvicorn worker cannot become a second trader."""
    def __init__(self, path: Path):
        self.path = path
        self.file = None

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = self.path.open("a+b")
        self.file.seek(0)
        self.file.write(b"0")
        self.file.flush()
        self.file.seek(0)
        try:
            import os
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            self.file = None
            raise RuntimeError("Another trading server is using DATA_DIR; run exactly one worker") from None

    def release(self):
        if self.file:
            self.file.close()
            self.file = None
