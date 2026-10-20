#!/usr/bin/env python3
"""Life OS FX connector — Windows / MT5 side (SKELETON).

Responsibilities (see README.md and docs/SPEC.md §11):
  * heartbeat every 5 s → holds the 30-second single-terminal lease, receives permissions
  * sends closed-bar judgments (signals), trade events, candles and quotes to the server
  * runs the three rule engines against MT5 (判断・注文・保護・時間決済 are ALL done here)

The server never places orders. This file contains the sync loop, config handling and the
formula-level stubs (SL/TP, lot sizing, holding deadline). Every MT5 call is a TODO.
`--check` and `--once` never trade.
"""
from __future__ import annotations

import argparse
import configparser
import json
import logging
import math
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

try:
    import requests
except ImportError:  # pragma: no cover
    print("pip install requests", file=sys.stderr)
    raise

LOG = logging.getLogger("lifeos.fx")
JST = timezone(timedelta(hours=9))
UTC = timezone.utc

PAIRS = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/USD", "GBP/USD", "AUD/USD"]
RULES = {"rule_a": "ルールA改良版", "donchian4": "ドンチャン改良4", "donchian6": "ドンチャン改良6"}
MAGIC = {"rule_a": 26061801, "donchian4": 26101804, "donchian6": 26101906}
SL_MULTIPLIER = {"rule_a": 0.5, "donchian4": 1.0, "donchian6": 1.0}
COST_PIPS = 1.2  # 手数料0.2 + 追加費用1.0
HEARTBEAT_SEC = 5
LEASE_SEC = 30
EXECUTION_WINDOW_SEC = 30  # 確定後30秒を超えた判定は追わない


def pip_size(pair: str) -> float:
    return 0.01 if pair.endswith("/JPY") else 0.0001


# ----------------------------------------------------------------- config
@dataclass
class Config:
    base_url: str
    token: str
    terminal_id: str
    mt5_path: str = ""
    mt5_login: str = ""
    mt5_server: str = ""
    state_dir: Path = field(default_factory=lambda: Path("state"))
    version: str = "0.1.0-skeleton"

    @classmethod
    def load(cls, ini: Optional[Path] = None) -> "Config":
        cp = configparser.ConfigParser()
        ini = ini or Path("lifeos_connector.ini")
        if ini.exists():
            cp.read(ini, encoding="utf-8")
        sec = cp["lifeos"] if cp.has_section("lifeos") else {}

        def get(key: str, default: str = "") -> str:
            return os.environ.get(key) or sec.get(key.lower(), default)  # type: ignore[union-attr]

        base = get("LIFEOS_BASE_URL").rstrip("/")
        token = get("FX_CONNECTOR_TOKEN")
        term = get("TERMINAL_ID") or os.environ.get("COMPUTERNAME", "windows")
        if not base or not token:
            raise SystemExit("LIFEOS_BASE_URL と FX_CONNECTOR_TOKEN を設定してください（環境変数または lifeos_connector.ini）")
        return cls(base_url=base, token=token, terminal_id=term, mt5_path=get("MT5_PATH"), mt5_login=get("MT5_LOGIN"), mt5_server=get("MT5_SERVER"))


# ----------------------------------------------------------------- server client
class LifeOSClient:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {cfg.token}", "Content-Type": "application/json", "User-Agent": f"lifeos-fx-connector/{cfg.version}"})
        self.base = f"{cfg.base_url}/api/integrations/fx"

    def _post(self, path: str, body: Any) -> requests.Response:
        return self.s.post(f"{self.base}{path}", data=json.dumps(body), timeout=10)

    def heartbeat(self, state: dict) -> tuple[int, dict]:
        r = self._post("/heartbeat", {**state, "terminal_id": self.cfg.terminal_id, "version": self.cfg.version})
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, {}

    def permissions(self) -> dict:
        r = self.s.get(f"{self.base}/permissions", params={"terminal_id": self.cfg.terminal_id}, timeout=10)
        r.raise_for_status()
        return r.json()

    def signals(self, items: list[dict]) -> None:
        self._post("/signals", items).raise_for_status()

    def trades(self, items: list[dict]) -> dict:
        r = self._post("/trades", items)
        r.raise_for_status()
        return r.json()

    def candles(self, pair: str, timeframe: str, bars: list[dict]) -> None:
        for i in range(0, len(bars), 2000):
            self._post("/candles", {"pair": pair, "timeframe": timeframe, "bars": bars[i : i + 2000]}).raise_for_status()

    def quotes(self, items: list[dict]) -> None:
        self._post("/quotes", items).raise_for_status()


# ----------------------------------------------------------------- MT5 adapter (TODO)
class MT5Adapter:
    """Thin wrapper around the MetaTrader5 package. Every method is a TODO — no real calls yet."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.connected = False

    def connect(self) -> bool:
        # TODO: import MetaTrader5 as mt5; mt5.initialize(path=self.cfg.mt5_path, login=..., server=...)
        LOG.warning("MT5Adapter.connect: TODO (no MetaTrader5 call made)")
        self.connected = False
        return self.connected

    def account(self) -> dict:
        # TODO: mt5.account_info() → {"account": str(login), "equity": float, "currency": "USD"}
        return {"account": "", "equity": None, "currency": None}

    def rates(self, pair: str, timeframe: str, count: int) -> list[dict]:
        # TODO: mt5.copy_rates_from_pos(symbol, TF, 0, count); drop the last (forming) bar; map to {t,o,h,l,c} with t = UTC unix seconds.
        # NOTE: broker server time is not UTC — convert using the server's UTC offset. If None is returned, retry once with 4096.
        return []

    def tick(self, pair: str) -> Optional[dict]:
        # TODO: mt5.symbol_info_tick(symbol) → {"pair": pair, "bid": .., "ask": .., "at": iso}
        return None

    def positions(self) -> list[dict]:
        # TODO: mt5.positions_get(); keep only our magics; map to ConnectorPosition
        return []

    def order_send(self, req: dict) -> dict:
        raise NotImplementedError("TODO: mt5.order_send — never call before the ledger has recorded the intent")

    def order_calc_profit(self, action: str, pair: str, lots: float, price_open: float, price_close: float) -> Optional[float]:
        # TODO: mt5.order_calc_profit(...) in account currency (USD)
        return None

    def symbol_limits(self, pair: str) -> dict:
        # TODO: mt5.symbol_info(symbol) → volume_min / volume_max / volume_step
        return {"volume_min": 0.01, "volume_max": 50.0, "volume_step": 0.01}


# ----------------------------------------------------------------- formulas (mirrored from worker/modules/fx/logic.ts)
def sl_tp(side: str, *, last5: list[dict], atr14: float, close_h1: float, multiplier: float, entry: Optional[float], pip: float) -> dict:
    """SL origin (buy) = min(min(low5) − 0.1·ATR, close − 0.5·ATR); SL距離 = multiplier × |entry − origin|; TP距離 = 3×SL距離 + 4×1.2 pips."""
    entry = close_h1 if entry is None else entry
    if side == "BUY":
        origin = min(min(b["l"] for b in last5) - 0.1 * atr14, close_h1 - 0.5 * atr14)
        sl_d = multiplier * (entry - origin)
        tp_d = 3 * sl_d + 4 * COST_PIPS * pip
        return {"origin": origin, "sl": entry - sl_d, "tp": entry + tp_d, "sl_distance": sl_d, "tp_distance": tp_d}
    origin = max(max(b["h"] for b in last5) + 0.1 * atr14, close_h1 + 0.5 * atr14)
    sl_d = multiplier * (origin - entry)
    tp_d = 3 * sl_d + 4 * COST_PIPS * pip
    return {"origin": origin, "sl": entry + sl_d, "tp": entry - tp_d, "sl_distance": sl_d, "tp_distance": tp_d}


def lot_for_donchian6(risk_usd: float, sl_pips: float, pip_value_usd: float, cost_usd: Optional[float] = None, *, step: float = 0.01, vmin: float = 0.01, vmax: float = 50.0) -> Optional[float]:
    """Round DOWN so that SL loss + cost ≤ risk_usd. None → do not order."""
    if sl_pips <= 0 or pip_value_usd <= 0 or risk_usd <= 0:
        return None
    cost = COST_PIPS * pip_value_usd if cost_usd is None else cost_usd
    per_lot = sl_pips * pip_value_usd + cost
    lots = math.floor(risk_usd / per_lot / step + 1e-9) * step
    lots = round(min(lots, vmax), 2)
    if lots < vmin or lots * per_lot > risk_usd + 1e-9:
        return None
    return lots


def next_jst_0500(t: datetime) -> datetime:
    j = t.astimezone(JST)
    c = j.replace(hour=5, minute=0, second=0, microsecond=0)
    if c <= j:
        c += timedelta(days=1)
    return c.astimezone(UTC)


def next_saturday_jst_0500(t: datetime) -> datetime:
    c = next_jst_0500(t)
    while c.astimezone(JST).weekday() != 5:
        c += timedelta(days=1)
    return c


def holding_deadline(rule: str, open_at: datetime) -> datetime:
    if rule == "rule_a":
        return min(open_at + timedelta(hours=18), next_jst_0500(open_at))
    return min(open_at + timedelta(hours=48), next_saturday_jst_0500(open_at))


def realized_r_block(closed: list[dict], now: datetime, limits: dict) -> dict:
    """Sum realized R per UTC day / Monday-start week / month across the 3 ledgers."""
    day = now.strftime("%Y-%m-%d"); month = now.strftime("%Y-%m")
    week = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
    d = w = m = 0.0
    for t in closed:
        if t.get("r_multiple") is None or not t.get("close_at"):
            continue
        c = datetime.fromisoformat(t["close_at"].replace("Z", "+00:00")).astimezone(UTC)
        if c.strftime("%Y-%m-%d") == day: d += t["r_multiple"]
        if (c - timedelta(days=c.weekday())).strftime("%Y-%m-%d") == week: w += t["r_multiple"]
        if c.strftime("%Y-%m") == month: m += t["r_multiple"]
    blocked = d <= limits.get("day", -2) or w <= limits.get("week", -3) or m <= limits.get("month", -2)
    return {"blocked": blocked, "day_r": d, "week_r": w, "month_r": m}


# ----------------------------------------------------------------- ledgers
class Ledger:
    """Per-rule journal. Intents are written BEFORE order_send; unknown results are never resent."""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict = {"intents": [], "legs": [], "closed": [], "stop_reasons": [], "start_lot": None}
        if path.exists():
            self.data = json.loads(path.read_text(encoding="utf-8"))

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)  # atomic on Windows/NTFS

    def stop(self, reason: str) -> None:
        if reason not in self.data["stop_reasons"]:
            self.data["stop_reasons"].append(reason)
            self.save()


# ----------------------------------------------------------------- rule engines (stubs)
class RuleEngine:
    rule = ""
    judge_tf = "H1"

    def __init__(self, mt5: MT5Adapter, ledger: Ledger):
        self.mt5 = mt5
        self.ledger = ledger

    def evaluate(self, pair: str, now: datetime) -> Optional[dict]:
        """Return a signal payload for the last CLOSED judgment bar, or None when history is insufficient.
        TODO: compute SMA10/90 on D1/H4/H1, slopes, SMA16±0.35ATR14 touch on the previous 8 H1, ADX14, breakouts…"""
        return None

    def manage(self, permissions: dict, now: datetime) -> list[dict]:
        """Protect / trail / time-close OWN legs only. Returns trade events to report. TODO."""
        return []

    def allowed_to_enter(self, permissions: dict, now: datetime) -> bool:
        if self.rule not in permissions.get("enabled_rules", []):
            return False
        if permissions.get("r_limit_block", {}).get("blocked"):
            return False
        if not permissions.get("lease", {}).get("held_by_you"):
            return False
        if self.ledger.data["stop_reasons"]:
            return False
        th = permissions.get("trading_hours", {})
        if th.get("weekdays_only", True) and now.weekday() >= 5:
            return False
        if not (th.get("start_utc", 6) <= now.hour < th.get("end_utc", 20)):
            return False
        return True


class RuleAEngine(RuleEngine):
    rule = "rule_a"; judge_tf = "H1"; trail_trigger_pips = 100; max_adds = 3
    # TODO: adds when a closed M5 closes ≥10 pips beyond M5 SMA20 against the position; trailing M5 SMA20±10 pips after +100 pips.


class Donchian4Engine(RuleEngine):
    rule = "donchian4"; judge_tf = "H4"; trail_trigger_pips = 60; trail_distance_pips = 50
    # TODO: D1 slope 15 bars, H4 slope 3 bars, H4 close strictly beyond previous 24 H4 high/low, UTC06–20 weekdays, H1 continuity, spread/ATR checks.


class Donchian6Engine(Donchian4Engine):
    rule = "donchian6"; trail_distance_pips = 30
    # TODO: + close strictly above daily R1 (buy) / below S1 (sell) using JST06:00-bucketed days built from observed H1; lot from risk_usd_donchian6.

    @staticmethod
    def pivots(d1: dict) -> dict:
        p = (d1["h"] + d1["l"] + d1["c"]) / 3
        return {"P": p, "R1": 2 * p - d1["l"], "S1": 2 * p - d1["h"]}


# ----------------------------------------------------------------- main loop
class Connector:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.client = LifeOSClient(cfg)
        self.mt5 = MT5Adapter(cfg)
        self.ledgers = {r: Ledger(cfg.state_dir / f"{name}.json") for r, name in (("rule_a", "rule-a"), ("donchian4", "donchian-v4"), ("donchian6", "donchian-v6"))}
        self.engines = [RuleAEngine(self.mt5, self.ledgers["rule_a"]), Donchian4Engine(self.mt5, self.ledgers["donchian4"]), Donchian6Engine(self.mt5, self.ledgers["donchian6"])]
        self.permissions: dict = {}
        self.lease_ok_until = 0.0

    def state(self) -> dict:
        acc = self.mt5.account()
        reasons = sorted({r for l in self.ledgers.values() for r in l.data["stop_reasons"]})
        return {"account": acc.get("account", ""), "equity": acc.get("equity"), "positions": self.mt5.positions(), "mt5_connected": self.mt5.connected, "stop_reasons": reasons}

    def sync(self) -> bool:
        """One heartbeat. Returns True when we hold the lease."""
        try:
            code, body = self.client.heartbeat(self.state())
        except requests.RequestException as e:
            LOG.warning("heartbeat failed: %s", e)
            return time.monotonic() < self.lease_ok_until
        if code == 409:
            LOG.warning("lease held by another terminal: %s — new entries paused", body.get("lease"))
            return False
        if code != 200:
            LOG.warning("heartbeat HTTP %s: %s", code, body)
            return time.monotonic() < self.lease_ok_until
        self.permissions = body.get("permissions", {})
        self.lease_ok_until = time.monotonic() + LEASE_SEC
        return bool(self.permissions.get("lease", {}).get("held_by_you"))

    def cycle(self, trade: bool) -> None:
        now = datetime.now(UTC)
        has_lease = self.sync()
        # quotes
        ticks = [t for t in (self.mt5.tick(p) for p in PAIRS) if t]
        if ticks:
            self.client.quotes(ticks)
        # TODO: on each new closed bar, push candles (M5/H1/H4/D1) and evaluate rules → signals
        signals = [s for eng in self.engines for s in (eng.evaluate(p, now) for p in PAIRS) if s]
        if signals:
            self.client.signals(signals)
        # manage own legs regardless of permissions (protection continues while paused)
        events = [e for eng in self.engines for e in eng.manage(self.permissions, now)]
        if events:
            self.client.trades(events)
        if not trade or not has_lease:
            return
        # TODO: for signals with stage == "entry": if engine.allowed_to_enter(...) and the bar closed < 30 s ago,
        #   write the intent to the ledger, then order_send with the first available Ask/Bid, then report {event:"open"}.
        #   Never resend an order whose result is unknown; stop the rule and report via stop_reasons instead.

    def run(self, once: bool = False, trade: bool = True) -> None:
        self.mt5.connect()
        while True:
            try:
                self.cycle(trade=trade)
            except Exception:  # keep the loop alive; protection must continue
                LOG.exception("cycle error")
            if once:
                return
            time.sleep(HEARTBEAT_SEC)


def main() -> None:
    ap = argparse.ArgumentParser(description="Life OS FX connector (skeleton)")
    ap.add_argument("--check", action="store_true", help="connection check only (no trading)")
    ap.add_argument("--once", action="store_true", help="single sync cycle (no trading)")
    ap.add_argument("--ini", type=Path, default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = Config.load(args.ini)
    if args.check:
        c = LifeOSClient(cfg)
        code, body = c.heartbeat({"account": "", "equity": None, "positions": [], "mt5_connected": False})
        print(json.dumps({"status": code, "lease": body.get("permissions", {}).get("lease"), "enabled_rules": body.get("permissions", {}).get("enabled_rules")}, ensure_ascii=False, indent=1))
        return
    Connector(cfg).run(once=args.once, trade=not args.once)


if __name__ == "__main__":
    main()
