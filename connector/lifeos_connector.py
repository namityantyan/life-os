#!/usr/bin/env python3
"""Life OS FX connector — Windows / MT5 side (entry point).

What runs here (docs/SPEC.md §11): the three live rules ルールA改良版・ドンチャン改良4・ドンチャン改良6 decide on
CLOSED bars, order, add (A only, max 3), set SL/TP, trail, time-exit and reconcile against MT5 — all on this PC.
The Life OS server never orders; it serves permissions/settings and stores status, signals, trades, candles,
quotes and notifications.

  python lifeos_connector.py --check       connection check (server + MT5). Never trades.
  python lifeos_connector.py --once        one read-only cycle: heartbeat, quotes, candles, signals. Never trades.
  python lifeos_connector.py               run loop (1 s). New entries/adds only within server permissions.
  python lifeos_connector.py --clear-stop rule_a   clear one rule's stop after verifying journal == MT5.

Modules: mt5_adapter.py (MetaTrader5 access), lifeos_agent.py (orchestration), rule_a_agent.py /
donchian_agent.py / donchian_v6_agent.py / auto_strategies.py (order logic from the previous connector),
rule_a_engine.py / donchian_engine.py / donchian_v6_engine.py / mt5_time.py (unchanged rule engines).
"""
from __future__ import annotations

import argparse
import configparser
import json
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:
    import requests
except ImportError:  # pragma: no cover
    print("requests がありません。install.bat を実行してください", file=sys.stderr)
    raise

from mt5_adapter import MT5Adapter, MT5Settings  # noqa: E402
from mt5_common import LOGICAL_SYMBOLS, ConnectorError  # noqa: E402
from mt5_time import MT5TimeError, validate_time_basis  # noqa: E402

VERSION = "1.0.1"
LOG = logging.getLogger("lifeos.fx")
PAIRS = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/USD", "GBP/USD", "AUD/USD"]
RULES = {"rule_a": "ルールA改良版", "donchian4": "ドンチャン改良4", "donchian6": "ドンチャン改良6"}
MAGIC = {"rule_a": 26061801, "donchian4": 26101804, "donchian6": 26101906}  # same as the previous connector
HTTP_TIMEOUT = 5


# ----------------------------------------------------------------- config
def parse_symbol_map(text: str) -> dict[str, str]:
    """`USD_JPY:USDJPY#,EUR_JPY:EURJPY#` (also accepts USD/JPY=USDJPY#)."""
    out: dict[str, str] = {}
    for part in filter(None, (p.strip() for p in (text or "").split(","))):
        m = re.fullmatch(r"([A-Za-z]{3})[_/]?([A-Za-z]{3})\s*[:=]\s*([A-Za-z0-9._#-]{1,64})", part)
        if not m:
            raise SystemExit(f"SYMBOL_MAP の書式が正しくありません: {part}")
        logical = f"{m.group(1).upper()}_{m.group(2).upper()}"
        if logical not in LOGICAL_SYMBOLS:
            # Pairs outside the 7 traded ones (e.g. carried over from the old connector) are ignored, not fatal.
            logging.getLogger("lifeos").warning("SYMBOL_MAP の %s は対象外の通貨ペアなので無視します", logical)
            continue
        out[logical] = m.group(3)
    return out


@dataclass
class Config:
    base_url: str
    token: str
    terminal_id: str
    mt5_path: str = ""
    mt5_login: str = ""
    mt5_server: str = ""
    time_basis: str = "utc"
    symbol_map: dict = field(default_factory=dict)
    state_dir: Path = field(default_factory=lambda: HERE / "state")
    version: str = VERSION

    @classmethod
    def load(cls, ini: Optional[Path] = None) -> "Config":
        """lifeos_connector.ini (from the download zip; replaced on every update) then
        lifeos_connector.local.ini (your own settings; never in the zip) — later values win; env vars win over both."""
        cp = configparser.ConfigParser(interpolation=None, inline_comment_prefixes=(";",))
        ini = ini or (HERE / "lifeos_connector.ini")
        local = ini.with_name(ini.stem + ".local.ini")
        cp.read([f for f in (ini, local) if f.exists()], encoding="utf-8-sig")
        sec = cp["lifeos"] if cp.has_section("lifeos") else {}

        def get(key: str, default: str = "") -> str:
            return (os.environ.get(key) or sec.get(key.lower(), default) or "").strip()  # type: ignore[union-attr]

        base = get("LIFEOS_BASE_URL").rstrip("/")
        token = get("FX_CONNECTOR_TOKEN")
        term = get("TERMINAL_ID") or os.environ.get("COMPUTERNAME", "windows")
        if not base or not token:
            raise SystemExit("LIFEOS_BASE_URL と FX_CONNECTOR_TOKEN を設定してください（環境変数または lifeos_connector.ini）")
        login = get("MT5_LOGIN")
        if login and not login.isdecimal():
            raise SystemExit("MT5_LOGIN は口座番号（数字）で指定してください")
        try:
            basis = validate_time_basis(get("TIME_BASIS", "utc") or "utc")
        except MT5TimeError as exc:
            raise SystemExit(str(exc))
        state = Path(get("STATE_DIR") or "state")
        if not state.is_absolute():
            state = (ini.parent if ini.exists() else HERE) / state
        return cls(base_url=base, token=token, terminal_id=term, mt5_path=get("MT5_PATH"), mt5_login=login,
                   mt5_server=get("MT5_SERVER"), time_basis=basis, symbol_map=parse_symbol_map(get("SYMBOL_MAP")),
                   state_dir=state)


# ----------------------------------------------------------------- server client
class LifeOSClient:
    """HTTP client for /api/integrations/fx/*. Reporting only — nothing here can place an order."""

    def __init__(self, cfg: Config, session: Any = None):
        self.cfg = cfg
        self.s = session or requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {cfg.token}", "Content-Type": "application/json",
                               "User-Agent": f"lifeos-fx-connector/{cfg.version}"})
        self.base = f"{cfg.base_url}/api/integrations/fx"

    def _post(self, path: str, body: Any) -> Any:
        r = self.s.post(f"{self.base}{path}", data=json.dumps(body, ensure_ascii=False, allow_nan=False), timeout=HTTP_TIMEOUT)
        return r

    def heartbeat(self, state: dict) -> tuple[int, dict]:
        r = self._post("/heartbeat", {**state, "terminal_id": self.cfg.terminal_id, "lease_holder": self.cfg.terminal_id,
                                      "version": self.cfg.version})
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, {}

    def permissions(self) -> dict:
        r = self.s.get(f"{self.base}/permissions", params={"terminal_id": self.cfg.terminal_id}, timeout=HTTP_TIMEOUT)
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
            self._post("/candles", {"pair": pair, "timeframe": timeframe, "bars": bars[i:i + 2000]}).raise_for_status()

    def quotes(self, items: list[dict]) -> None:
        self._post("/quotes", items).raise_for_status()


# ----------------------------------------------------------------- single instance
class InstanceLock:
    """One trading connector per state/ folder (two copies would both think they hold the lease)."""

    def __init__(self, state_dir: Path):
        state_dir.mkdir(parents=True, exist_ok=True)
        self.path = state_dir / "connector.lock"
        self.handle: Any = None

    def acquire(self) -> None:
        handle = open(self.path, "a+")
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            raise SystemExit("このフォルダーのコネクターは既に起動しています（run.bat の画面を確認してください）")
        self.handle = handle

    def release(self) -> None:
        if self.handle is not None:
            try:
                self.handle.close()
            finally:
                self.handle = None


# ----------------------------------------------------------------- wiring
def is_local(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".localhost")


def make_adapter(cfg: Config, *, read_only: bool, fake: bool = False) -> MT5Adapter:
    settings = MT5Settings(terminal_path=cfg.mt5_path, expected_login=cfg.mt5_login, expected_server=cfg.mt5_server,
                           time_basis="utc" if fake else cfg.time_basis, symbol_map=cfg.symbol_map)
    module = None
    if fake:
        from fake_mt5 import FakeMT5
        module = FakeMT5()
    return MT5Adapter(settings, mt5_module=module, read_only=read_only)


def check(cfg: Config, fake: bool = False) -> dict:
    """Connection check: server heartbeat + MT5 identity/symbols/time basis. No agent is created; never trades."""
    out: dict[str, Any] = {"version": cfg.version, "terminal_id": cfg.terminal_id, "server": cfg.base_url}
    client = LifeOSClient(cfg)
    adapter = make_adapter(cfg, read_only=True, fake=fake)
    try:
        adapter.connect()
        out["mt5"] = {"connected": True, "account": adapter.account_summary(), "symbols": adapter.symbols,
                      "time_basis": adapter.time_basis}
        offset = adapter.tick_offset_seconds()
        if offset is not None:
            out["mt5"]["tick_minus_local_utc_sec"] = round(offset, 1)
            hint = "utc" if abs(offset) < 900 else "xm_europe" if 6300 <= offset <= 11700 else "不明（Windowsの時計を確認）"
            out["mt5"]["time_basis_hint"] = hint
            if hint in ("utc", "xm_europe") and hint != adapter.time_basis:
                out["mt5"]["warning"] = f"TIME_BASIS={adapter.time_basis} ですが、ティック時刻は {hint} に見えます。ini を確認してください（違っていると新規は止まります）。"
    except ConnectorError as exc:
        out["mt5"] = {"connected": False, "error": str(exc)}
    except Exception as exc:
        out["mt5"] = {"connected": False, "error": f"{type(exc).__name__}: {exc}"}
    hb = {"account": (out.get("mt5", {}).get("account") or {}).get("account", ""),
          "equity": (out.get("mt5", {}).get("account") or {}).get("equity"),
          "positions": [], "mt5_connected": bool(out["mt5"].get("connected")), "stop_reasons": []}
    try:
        code, body = client.heartbeat(hb)
        perms = body.get("permissions", {}) if isinstance(body, dict) else {}
        out["status"] = code
        out["lease"] = perms.get("lease") or body.get("lease")
        out["enabled_rules"] = perms.get("enabled_rules")
        out["common_lot"] = perms.get("common_lot")
        out["year_config_valid"] = perms.get("year_config_valid")
    except requests.RequestException as exc:
        out["status"] = None
        out["error"] = f"サーバーに接続できません: {type(exc).__name__}"
    adapter.close()
    return out


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=f"Life OS FX connector {VERSION}")
    ap.add_argument("--check", action="store_true", help="connection check only (never trades)")
    ap.add_argument("--once", action="store_true", help="one read-only sync cycle (never trades)")
    ap.add_argument("--clear-stop", choices=sorted(RULES), help="clear one rule's stop after verifying journal == MT5")
    ap.add_argument("--ini", type=Path, default=None)
    ap.add_argument("--fake-mt5", action="store_true", help="development only: synthetic MT5 (local server URLs only)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = Config.load(args.ini)
    if args.fake_mt5 and not is_local(cfg.base_url):
        raise SystemExit("--fake-mt5 はローカルの開発サーバー（localhost）にだけ使えます")
    if args.check:
        print(json.dumps(check(cfg, fake=args.fake_mt5), ensure_ascii=False, indent=1))
        return 0

    from lifeos_agent import Orchestrator, clear_stop  # imported late so --check works with a partial install

    if args.clear_stop:
        lock = InstanceLock(cfg.state_dir)
        lock.acquire()  # refuses while run.bat is running: journals have a single writer
        adapter = make_adapter(cfg, read_only=True, fake=args.fake_mt5)
        orch = Orchestrator(cfg, LifeOSClient(cfg), adapter, trade=False)
        if not orch.ensure_connected() or orch.strategies is None:
            print("MT5に接続できないため確認できません", file=sys.stderr)
            return 1
        try:
            print(clear_stop(orch.strategies, args.clear_stop, adapter))
        except ConnectorError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        finally:
            adapter.close()
            lock.release()
        return 0

    if args.once:
        adapter = make_adapter(cfg, read_only=True, fake=args.fake_mt5)
        orch = Orchestrator(cfg, LifeOSClient(cfg), adapter, trade=False)
        print(json.dumps(orch.run_once_report(), ensure_ascii=False, indent=1, default=str))
        adapter.close()
        return 0

    lock = InstanceLock(cfg.state_dir)
    lock.acquire()
    adapter = make_adapter(cfg, read_only=False, fake=args.fake_mt5)
    orch = Orchestrator(cfg, LifeOSClient(cfg), adapter, trade=True)
    LOG.info("Life OS FX connector %s started (terminal %s). New entries follow the server permissions.", VERSION, cfg.terminal_id)
    try:
        orch.run()
    except KeyboardInterrupt:
        LOG.info("stopped")
    finally:
        adapter.close()
        lock.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
