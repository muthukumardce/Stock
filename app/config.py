"""Configuration is server-side only; never serialize Settings to the browser."""
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse
import math
import os

from cryptography.fernet import Fernet
from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    app_env: str = "development"
    public_url: str = "http://localhost:3000"
    admin_username: str = "admin"
    admin_password_hash: str = ""
    session_secret: str = ""
    token_encryption_key: str = ""
    kite_api_key: str = ""
    kite_api_secret: str = ""
    kite_user_id: str = ""
    trading_mode: str = "paper"
    live_trading_enabled: bool = False
    paper_capital: float = 100000.0
    live_capital: float = 0.0
    max_position_pct: float = 0.10
    risk_per_trade_pct: float = 0.0025
    daily_loss_pct: float = 0.01
    max_positions: int = 5
    entry_cutoff: str = "14:45"
    exit_time: str = "15:10"
    data_dir: Path = Path("data")
    max_spread_pct: float = 0.003
    min_daily_turnover: float = 10000000
    analytics_workers: int = 0
    analytics_reserve_cpus: int = 4
    analytics_batch_size: int = 32

    @property
    def capital(self):
        return self.live_capital if self.trading_mode == "live" else self.paper_capital

    @property
    def secure_cookies(self):
        return self.public_url.startswith("https://")

    @property
    def configured(self):
        return bool(self.kite_api_key and self.kite_api_secret and self.kite_user_id)

    def validate(self):
        url = urlparse(self.public_url)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
            raise ValueError("PUBLIC_URL must be an origin, for example https://trade.example.com")
        if self.app_env == "production" and url.scheme != "https":
            raise ValueError("Production PUBLIC_URL must use HTTPS")
        if len(self.session_secret) < 32 or not self.admin_password_hash.startswith("$argon2"):
            raise ValueError("Configure secure credentials first: python -m app.cli init")
        if not self.admin_username or len(self.admin_username) > 128:
            raise ValueError("ADMIN_USERNAME must contain 1–128 characters")
        Fernet(self.token_encryption_key.encode())
        if self.trading_mode not in ("paper", "live"):
            raise ValueError("TRADING_MODE must be paper or live")
        for name in ("paper_capital", "live_capital", "max_position_pct", "risk_per_trade_pct", "daily_loss_pct", "max_spread_pct", "min_daily_turnover"):
            if not math.isfinite(getattr(self, name)):
                raise ValueError(f"{name} must be finite")
        if self.paper_capital <= 0 or self.live_capital < 0:
            raise ValueError("Capital must be positive (LIVE_CAPITAL may be zero while disabled)")
        if not (0 < self.risk_per_trade_pct <= self.max_position_pct <= 1) or not (0 < self.daily_loss_pct <= 1):
            raise ValueError("Invalid risk percentages")
        if not 1 <= self.max_positions <= 50 or not 0 < self.max_spread_pct < 1 or self.min_daily_turnover < 0:
            raise ValueError("Invalid position, spread or turnover limit")
        if not 0 <= self.analytics_workers <= 1024 or not 0 <= self.analytics_reserve_cpus <= 1024 or not 1 <= self.analytics_batch_size <= 1000:
            raise ValueError("Invalid analytics worker, CPU reserve or batch size setting")
        from datetime import time
        if not time(9, 15) < time.fromisoformat(self.entry_cutoff) < time.fromisoformat(self.exit_time) < time(15, 30):
            raise ValueError("Require 09:15 < ENTRY_CUTOFF < EXIT_TIME < 15:30 in IST")
        return self

    @classmethod
    def from_env(cls):
        load_dotenv()
        values = {}
        defaults = cls()
        for name in cls.__dataclass_fields__:
            value = os.getenv(name.upper())
            if value is None:
                continue
            base = getattr(defaults, name)
            if isinstance(base, bool):
                if value.lower() not in ("true", "false"):
                    raise ValueError(f"{name.upper()} must be true or false")
                values[name] = value.lower() == "true"
            elif isinstance(base, Path):
                values[name] = Path(value)
            elif isinstance(base, int):
                values[name] = int(value)
            elif isinstance(base, float):
                values[name] = float(value)
            else:
                values[name] = value.rstrip("/") if name == "public_url" else value
        return cls(**values).validate()
