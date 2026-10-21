"""MT5 access for the Life OS connector.

`MT5Adapter` wraps the official `MetaTrader5` package (imported lazily, so this file also imports on macOS/Linux
for tests). It owns the terminal connection, account pinning and broker-symbol mapping, and hands the raw
module-like API (`adapter.mt5`) to the strategy agents, exactly as the previous Windows connector did.

`FakeMT5` (see fake_mt5.py) implements the same module-level API for tests and local smoke runs.

Rules kept from the previous connector (windows_mt5/connector.py MT5Reader):
  * initialize() gets only the terminal path — no password is asked for or stored; the account already
    logged into the terminal is used and must match MT5_LOGIN / MT5_SERVER when those are set.
  * broker symbols are resolved by currency_base / currency_profit (suffixes such as `USDJPY#` work);
    ambiguity stops with a message asking for SYMBOL_MAP — never a guess.
  * every MT5 timestamp goes through mt5_time.source_to_utc with the configured TIME_BASIS.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Optional

from mt5_common import ConnectorError, field_value, iso_utc, load_mt5_module, resolve_symbols, utc_now
from mt5_time import MT5TimeError, source_to_utc, validate_time_basis

UTC = timezone.utc
TF_SECONDS = {"M5": 300, "H1": 3600, "H4": 14400, "D1": 86400}
TF_CONST = {"M5": "TIMEFRAME_M5", "H1": "TIMEFRAME_H1", "H4": "TIMEFRAME_H4", "D1": "TIMEFRAME_D1"}


def logical_to_pair(logical: str) -> str:
    return logical.replace("_", "/")


def pair_to_logical(pair: str) -> str:
    return pair.replace("/", "_")


def mask_login(login: str) -> str:
    login = str(login or "")
    return ("****" + login[-4:]) if len(login) > 4 else ("****" if login else "")


@dataclass
class MT5Settings:
    terminal_path: str = ""
    expected_login: str = ""   # optional pin from the ini; blank = pin the account logged in at first connect
    expected_server: str = ""
    time_basis: str = "utc"
    symbol_map: Mapping[str, str] = field(default_factory=dict)


class NoTradeMT5:
    """Read-only proxy used by --check / --once: any order call raises before reaching MT5."""

    def __init__(self, mt5: Any):
        self._mt5 = mt5

    def __getattr__(self, name: str) -> Any:
        if name in {"order_send"}:
            def _blocked(*_a: Any, **_k: Any) -> Any:
                raise RuntimeError("read-only mode: order_send is disabled")
            return _blocked
        return getattr(self._mt5, name)


class MT5Adapter:
    def __init__(self, settings: MT5Settings, *, mt5_module: Any = None, clock: Callable[[], datetime] = utc_now,
                 read_only: bool = False):
        self.settings = settings
        self.time_basis = validate_time_basis(settings.time_basis)
        self._module = mt5_module
        self.clock = clock
        self.read_only = read_only
        self.connected = False
        self.symbols: dict[str, str] = {}
        self.pinned_server = settings.expected_server.strip()
        self.pinned_login = settings.expected_login.strip()
        self.last_error: Optional[str] = None

    # ---- connection ---------------------------------------------------------
    @property
    def mt5(self) -> Any:
        if self._module is None:
            self._module = load_mt5_module()
        return NoTradeMT5(self._module) if self.read_only else self._module

    def connect(self) -> None:
        mt5 = self.mt5
        path = self.settings.terminal_path
        ok = mt5.initialize(str(path), timeout=60000) if path else mt5.initialize(timeout=60000)
        if not ok:
            self.connected = False
            raise ConnectorError("MT5ターミナルへ接続できません（MT5_PATHとMT5の起動・ログインを確認してください）")
        try:
            self._verify_account()
            self.symbols = resolve_symbols(mt5, self.settings.symbol_map)
            for logical, broker in self.symbols.items():
                if not mt5.symbol_select(broker, True):
                    raise ConnectorError(f"{logical}をMT5の気配値表示へ追加できません")
        except Exception:
            self.connected = False
            self.symbols = {}
            try:
                mt5.shutdown()
            except Exception:
                pass
            raise
        self.connected = True
        self.last_error = None

    def close(self) -> None:
        self.connected = False
        self.symbols = {}
        try:
            if self._module is not None:
                self._module.shutdown()
        except Exception:
            pass

    def _verify_account(self) -> Any:
        mt5 = self.mt5
        terminal, account = mt5.terminal_info(), mt5.account_info()
        if terminal is None or not bool(field_value(terminal, "connected", False)):
            raise ConnectorError("MT5がブローカーのサーバーへ接続されていません")
        if account is None:
            raise ConnectorError("MT5のログイン口座を確認できません")
        server, login = str(field_value(account, "server", "")), str(field_value(account, "login", ""))
        if not server or not login.isdecimal():
            raise ConnectorError("MT5のログイン口座を確認できません")
        if self.pinned_server or self.pinned_login:
            if server != self.pinned_server or login != self.pinned_login:
                raise ConnectorError("MT5で開いている口座が lifeos_connector.ini の MT5_LOGIN / MT5_SERVER と一致しません")
        else:
            # Pin the first account seen in this process; a later switch is refused (journals are per account).
            self.pinned_server, self.pinned_login = server, login
        return account

    # ---- observations -------------------------------------------------------
    def account_summary(self) -> dict[str, Any]:
        account = self.mt5.account_info()
        if account is None:
            return {"account": "", "equity": None, "currency": None}
        equity = field_value(account, "equity")
        try:
            equity = float(equity)
            equity = equity if math.isfinite(equity) else None
        except (TypeError, ValueError):
            equity = None
        server = str(field_value(account, "server", ""))
        return {"account": f"{server} {mask_login(str(field_value(account, 'login', '')))}".strip(),
                "equity": equity, "currency": str(field_value(account, "currency", "") or "") or None}

    def _utc(self, raw: float) -> datetime:
        try:
            return source_to_utc(raw, self.time_basis)
        except MT5TimeError as exc:
            raise ConnectorError("MT5の時刻をUTCへ変換できません") from exc

    def quotes(self) -> list[dict[str, Any]]:
        out = []
        for logical, broker in self.symbols.items():
            tick = self.mt5.symbol_info_tick(broker)
            if tick is None:
                continue
            ms = field_value(tick, "time_msc")
            raw = float(ms) / 1000 if ms else float(field_value(tick, "time", 0) or 0)
            try:
                bid, ask = float(field_value(tick, "bid")), float(field_value(tick, "ask"))
            except (TypeError, ValueError):
                continue
            if raw <= 0 or not (math.isfinite(bid) and math.isfinite(ask)) or bid <= 0 or ask < bid:
                continue
            out.append({"pair": logical_to_pair(logical), "bid": bid, "ask": ask, "at": iso_utc(self._utc(raw))})
        return out

    def tick_offset_seconds(self) -> Optional[float]:
        """Raw tick time minus local UTC now (diagnostics only: ~0 → utc, ~+7200/+10800 → xm_europe)."""
        for broker in self.symbols.values():
            tick = self.mt5.symbol_info_tick(broker)
            if tick is not None:
                ms = field_value(tick, "time_msc")
                raw = float(ms) / 1000 if ms else float(field_value(tick, "time", 0) or 0)
                return raw - self.clock().timestamp()
        return None

    def rates(self, logical: str, timeframe: str, count: int, *, start_pos: int = 1) -> list[dict[str, Any]]:
        """Closed bars as CandleBar dicts ({t,o,h,l,c}, t = bar open in UTC unix seconds), oldest first.

        D1 is the broker's own daily bar (the chart's A/改良4 pivot source). Its `t` is the broker trading DATE at
        00:00 (the raw MT5 stamp), so the server's day bucket is the trading day itself."""
        broker = self.symbols[logical]
        tf = getattr(self.mt5, TF_CONST[timeframe])
        raw = self.mt5.copy_rates_from_pos(broker, tf, start_pos, count)
        if raw is None and count > 4096:
            raw = self.mt5.copy_rates_from_pos(broker, tf, start_pos, 4096)
        if raw is None:
            return []
        width = TF_SECONDS[timeframe]
        now = self.clock()
        rows: dict[int, dict[str, Any]] = {}
        for item in raw:
            opened = int(field_value(item, "time", 0) or 0)
            if opened <= 0:
                continue
            try:
                values = {k: float(field_value(item, key)) for k, key in (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close"))}
            except (TypeError, ValueError):
                continue
            if not all(math.isfinite(v) and v > 0 for v in values.values()):
                continue
            if timeframe == "D1":
                t = opened - opened % 86400
                close_utc = self._utc(opened + width)
            else:
                open_utc = self._utc(opened)
                close_utc = self._utc(opened + width)
                if close_utc - open_utc != timedelta(seconds=width):
                    continue  # bar spanning a DST switch cannot be placed exactly; never guessed
                t = int(open_utc.timestamp())
            if close_utc > now:
                continue  # forming bar
            rows[t] = {"t": t, **values}
        return [rows[k] for k in sorted(rows)]

    def positions(self) -> list[Any]:
        result = self.mt5.positions_get()
        return list(result) if result is not None else []
