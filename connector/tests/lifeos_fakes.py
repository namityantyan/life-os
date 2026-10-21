"""In-process fake of the Life OS FX connector API plus validators mirroring shared/fx.ts and the zod schemas
in worker/modules/fx/routes.ts. Every payload the connector sends through FakeServer is validated."""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

UTC = timezone.utc
RULES = {"rule_a", "donchian4", "donchian6"}
SIDES = {"BUY", "SELL"}
PAIR_RE = re.compile(r"^[A-Z]{3}/[A-Z]{3}$")


def _iso(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _num_or_null(value: Any) -> bool:
    return value is None or _num(value)


def check_position(p: dict) -> None:
    assert set(p) <= {"ticket", "rule", "pair", "side", "lots", "open_price", "sl", "tp", "open_at", "pnl_usd"}, p
    assert isinstance(p["ticket"], str) and p["ticket"], p
    assert p["rule"] in RULES and PAIR_RE.match(p["pair"]) and p["side"] in SIDES, p
    assert _num(p["lots"]) and _num(p["open_price"]) and _num_or_null(p["sl"]) and _num_or_null(p["tp"]), p
    assert _iso(p["open_at"]) and _num_or_null(p.get("pnl_usd")), p


def check_heartbeat(body: dict) -> None:
    allowed = {"terminal_id", "account", "equity", "positions", "lease_holder", "version", "mt5_connected", "stop_reasons"}
    assert set(body) <= allowed, set(body) - allowed
    assert isinstance(body["terminal_id"], str) and 1 <= len(body["terminal_id"]) <= 100
    assert isinstance(body["account"], str) and len(body["account"]) <= 100
    assert _num_or_null(body["equity"])
    assert isinstance(body["version"], str) and len(body["version"]) <= 50
    assert isinstance(body.get("mt5_connected", False), bool)
    reasons = body.get("stop_reasons", [])
    assert isinstance(reasons, list) and len(reasons) <= 50 and all(isinstance(r, str) and len(r) <= 200 for r in reasons), reasons
    for p in body["positions"]:
        check_position(p)


def check_signal(s: dict) -> None:
    assert set(s) <= {"pair", "rule", "side", "stage", "bar_time", "indicators"}, s
    assert PAIR_RE.match(s["pair"]) and s["rule"] in RULES and s["stage"] in {"none", "setup", "entry"}, s
    assert s["side"] is None or s["side"] in SIDES, s
    assert _iso(s["bar_time"]), s
    for k, v in (s.get("indicators") or {}).items():
        assert isinstance(k, str) and (v is None or isinstance(v, (str, bool)) or _num(v)), (k, v)


def check_trade(t: dict) -> None:
    allowed = {"event", "ticket", "rule", "pair", "side", "price", "lots", "sl", "tp", "pnl_usd", "r_multiple", "at", "group_ticket", "note"}
    assert set(t) <= allowed, set(t) - allowed
    assert t["event"] in {"open", "add", "close", "modify"} and isinstance(t["ticket"], str) and t["ticket"], t
    assert t["rule"] in RULES and PAIR_RE.match(t["pair"]) and t["side"] in SIDES, t
    assert _num(t["price"]) and _num(t["lots"]) and _num_or_null(t.get("sl")) and _num_or_null(t.get("tp")), t
    assert _num_or_null(t.get("pnl_usd")) and _num_or_null(t.get("r_multiple")) and _iso(t["at"]), t
    assert t.get("group_ticket") is None or isinstance(t["group_ticket"], str), t
    assert t.get("note") is None or (isinstance(t["note"], str) and len(t["note"]) <= 500), t


def check_candles(pair: str, tf: str, bars: list) -> None:
    assert PAIR_RE.match(pair) and tf in {"M5", "H1", "H4", "D1"} and 1 <= len(bars) <= 2000
    for b in bars:
        assert set(b) == {"t", "o", "h", "l", "c"} and isinstance(b["t"], int) and b["t"] > 0, b
        assert all(_num(b[k]) for k in "ohlc") and b["h"] >= max(b["o"], b["c"]) and b["l"] <= min(b["o"], b["c"]), b


def check_quote(q: dict) -> None:
    assert set(q) == {"pair", "bid", "ask", "at"} and PAIR_RE.match(q["pair"]) and _num(q["bid"]) and _num(q["ask"]) and _iso(q["at"]), q


class FakeServer:
    """Behaves like publicRoutes in worker/modules/fx/routes.ts (lease, permissions, idempotent trades)."""

    def __init__(self, clock: Callable[[], datetime], terminal_id: str = "win-test", *, enabled=(), common_lot=0.3,
                 risk_usd=60, blocked=False, year_valid=True, hours=(6, 20, True)):
        self.clock = clock
        self.terminal_id = terminal_id
        self.enabled = list(enabled)
        self.common_lot = common_lot
        self.risk_usd = risk_usd
        self.blocked = blocked
        self.year_valid = year_valid
        self.hours = hours
        self.lease_holder: str | None = None
        self.lease_expires: datetime | None = None
        self.other_holder = False       # simulate another terminal holding the lease (→ 409)
        self.down = False               # simulate the server/network being unreachable
        self.fail_trades = False
        self.heartbeats: list[dict] = []
        self.signals_rx: list[dict] = []
        self.trades_rx: list[dict] = []
        self.trade_keys: set[str] = set()
        self.candles_rx: list[tuple[str, str, int]] = []
        self.quotes_rx: list[dict] = []
        self.permission_calls = 0

    def _check_up(self) -> None:
        if self.down:
            raise ConnectionError("server unreachable")

    def perms(self) -> dict:
        now = self.clock()
        held = (not self.other_holder) and self.lease_holder == self.terminal_id and self.lease_expires is not None and self.lease_expires > now
        start, end, weekdays = self.hours
        return {"enabled_rules": [r for r in self.enabled if r == "rule_a" or self.year_valid],
                "common_lot": self.common_lot, "risk_usd_donchian6": self.risk_usd,
                "trading_hours": {"start_utc": start, "end_utc": end, "weekdays_only": weekdays},
                "r_limits": {"day": -2, "week": -3, "month": -2},
                "r_limit_block": {"blocked": self.blocked, "reason": "day" if self.blocked else None, "day_r": -2.1 if self.blocked else 0, "week_r": 0, "month_r": 0},
                "year_config_valid_until": "2027-10-01", "year_config_valid": self.year_valid,
                "lease": {"holder": self.lease_holder, "expires_at": self.lease_expires.isoformat().replace("+00:00", "Z") if self.lease_expires else None, "held_by_you": held},
                "server_time": now.isoformat().replace("+00:00", "Z")}

    # ---- client interface used by the connector --------------------------------
    def heartbeat(self, state: dict) -> tuple[int, dict]:
        self._check_up()
        body = {**state, "terminal_id": self.terminal_id, "lease_holder": self.terminal_id, "version": "1.0.0"}
        check_heartbeat(body)
        self.heartbeats.append(body)
        if self.other_holder:
            return 409, {"error": "lease held by another terminal", "lease": {"holder": "other", "held_by_you": False}}
        self.lease_holder = self.terminal_id
        self.lease_expires = self.clock() + timedelta(seconds=30)
        return 200, {"ok": True, "permissions": self.perms()}

    def permissions(self) -> dict:
        self._check_up()
        self.permission_calls += 1
        return self.perms()

    def signals(self, items: list[dict]) -> None:
        self._check_up()
        for s in items:
            check_signal(s)
        self.signals_rx.extend(items)

    def trades(self, items: list[dict]) -> dict:
        self._check_up()
        if self.fail_trades:
            raise ConnectionError("trades endpoint failing")
        stored = dup = 0
        for t in items:
            check_trade(t)
            key = f"{t['ticket']}:modify:{t['at']}" if t["event"] == "modify" else f"{t['ticket']}:{t['event']}"
            if key in self.trade_keys:
                dup += 1
                continue
            self.trade_keys.add(key)
            self.trades_rx.append(t)
            stored += 1
        return {"ok": True, "stored": stored, "duplicates": dup}

    def candles(self, pair: str, timeframe: str, bars: list[dict]) -> None:
        self._check_up()
        for i in range(0, len(bars), 2000):
            check_candles(pair, timeframe, bars[i:i + 2000])
        self.candles_rx.append((pair, timeframe, len(bars)))

    def quotes(self, items: list[dict]) -> None:
        self._check_up()
        for q in items:
            check_quote(q)
        self.quotes_rx.extend(items)
