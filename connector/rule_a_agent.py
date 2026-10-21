"""Fail-closed local MT5 runner for the improved Rule A basket.

The connector owns activation, account pinning, and the shared instance lock.
This module never opens MT5 itself and never retries an uncertain order_send.
"""
from __future__ import annotations

import json
import math
import os
import ssl
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

try:
    from .mt5_common import account_reference, field_value, iso_utc, utc_now
    from .mt5_time import history_query_bounds, source_to_utc, validate_time_basis
    from . import rule_a_engine as core
except ImportError:  # Windows bundle is imported as flat modules.
    from mt5_common import account_reference, field_value, iso_utc, utc_now
    from mt5_time import history_query_bounds, source_to_utc, validate_time_basis
    import rule_a_engine as core

UTC = timezone.utc
MAGIC = 26061801
BASE_VOLUME = 0.30
MAX_VOLUME = 1.20
MAX_ADDS = 3
MAX_TICK_AGE = 10.0
MAX_SIGNAL_AGE = 30.0
LEASE_REFRESH_SECONDS = 5.0
LEASE_MAX_SECONDS = 30.0
MAX_SYNC_BYTES = 128 * 1024
MAX_SYNC_EVENTS = 100
H1_HISTORY_COUNT = 12020
M5_HISTORY_COUNT = 300
STATE_VERSION = 1


class RuleAError(RuntimeError):
    """Safe operational error; never contains credentials or order payloads."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _dt(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(UTC)


def _num(value: Any, label: str, *, positive: bool = False) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise RuleAError(f"{label} is unavailable") from None
    if not math.isfinite(result) or (positive and result <= 0):
        raise RuleAError(f"{label} is invalid")
    return result


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    data = json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"), allow_nan=False).encode("utf-8")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            fd = -1
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        if os.name != "nt":
            dirfd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
    finally:
        if fd >= 0:
            os.close(fd)


class RuleAJournal:
    """Atomic per-account state and write-ahead order intent log."""
    def __init__(self, path: Path, account_ref: str, *, strategy_id: str = core.RULE_ID):
        self.path = Path(path)
        self.account_ref = str(account_ref)
        self.strategy_id = strategy_id

    def load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": STATE_VERSION, "strategy_id": self.strategy_id, "account_ref": self.account_ref,
                    "instance_id": str(uuid.uuid4()), "basket": None,
                    "intents": {}, "events": [], "processed_h1": {}, "processed_m5": {},
                    "risk_ledger": [], "quarantine": None}
        except (OSError, json.JSONDecodeError):
            raise RuleAError("Rule A journal cannot be read safely") from None
        if (not isinstance(raw, Mapping) or raw.get("version") != STATE_VERSION
                or raw.get("account_ref") != self.account_ref
                or raw.get("strategy_id", core.RULE_ID) != self.strategy_id
                or not isinstance(raw.get("intents"), Mapping)
                or not isinstance(raw.get("events"), list)
                or not isinstance(raw.get("processed_h1"), Mapping)
                or not isinstance(raw.get("processed_m5"), Mapping)):
            raise RuleAError("Rule A journal is invalid or belongs to another account")
        state = dict(raw)
        state.setdefault("basket", None)
        state.setdefault("instance_id", str(uuid.uuid4()))
        state.setdefault("quarantine", None)
        state.setdefault("risk_ledger", [])
        return state

    def save(self, state: Mapping[str, Any]) -> None:
        if state.get("account_ref") != self.account_ref or state.get("strategy_id", core.RULE_ID) != self.strategy_id:
            raise RuleAError("Rule A journal account mismatch")
        _atomic_json(self.path, state)


class RuleASyncClient:
    """Minimal authenticated sync client using the active close credential."""
    def __init__(self, endpoint: str, token: str, *, timeout: float = 2.0, opener: Any = None, path: str = "/fx/mt5/rule-a/sync"):
        parsed = urlsplit(str(endpoint or ""))
        if (parsed.scheme != "https" or parsed.hostname != "dashboard.nami-tool.com"
                or parsed.port not in {None, 443} or parsed.path.rstrip("/") != "/fx/mt5/close"
                or parsed.query or parsed.fragment or parsed.username or parsed.password):
            raise RuleAError("Rule A sync requires the configured active close endpoint")
        if not isinstance(token, str) or not 32 <= len(token) <= 512 or any(c.isspace() for c in token):
            raise RuleAError("Rule A sync credential is unavailable")
        if path not in {"/fx/mt5/rule-a/sync", "/fx/mt5/donchian/sync", "/fx/mt5/donchian-v6/sync"}:
            raise RuleAError("unsupported strategy sync path")
        self.endpoint = urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))
        self._token = token
        self.timeout = min(max(float(timeout), 0.1), 2.0)
        self._opener = opener or build_opener(_NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))

    def post(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")
        request = Request(self.endpoint, data=body, method="POST", headers={
            "Authorization": f"Bearer {self._token}", "Content-Type": "application/json",
            "Accept": "application/json", "User-Agent": "life-dashboard-rule-a-mt5/1.0"})
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                if response.status != 200:
                    raise RuleAError("Rule A sync was not accepted")
                raw = response.read(MAX_SYNC_BYTES + 1)
        except HTTPError as exc:
            raise RuleAError(f"Rule A sync failed (HTTP {exc.code})") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise RuleAError("Rule A sync is unavailable") from exc
        if len(raw) > MAX_SYNC_BYTES:
            raise RuleAError("Rule A sync response is too large")
        try:
            result = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuleAError("Rule A sync response is invalid") from exc
        if not isinstance(result, Mapping) or result.get("ok") is not True:
            raise RuleAError("Rule A sync response was not accepted")
        return dict(result)


class RuleAAgent:
    """One-second local Rule A runner; all remote control is a lease only."""
    core = core
    magic = MAGIC
    max_adds = MAX_ADDS
    local_flag = "enable_rule_a"
    state_field = "rule_a_state_path"
    sync_path = "/fx/mt5/rule-a/sync"
    comment_prefix = "ra"

    def __init__(self, mt5: Any, config: Any, *, clock: Callable[[], datetime] = utc_now,
                 sync_client: Any = None):
        self.mt5 = mt5
        # A process lease must not be cloned with the persistent risk journal.
        self.instance_id = str(uuid.uuid4())
        self.config = config
        self.clock = clock
        self.expected_server = str(getattr(config, "expected_server", ""))
        self.expected_login = str(getattr(config, "expected_login", ""))
        if not self.expected_server or not self.expected_login.isdecimal():
            raise RuleAError("Rule A pinned MT5 account is invalid")
        self.account_ref = account_reference(self.expected_server, self.expected_login)
        self.enabled_local = bool(getattr(config, self.local_flag, False))
        self.time_basis = validate_time_basis(getattr(config, "time_basis", "utc"))
        self.symbol_map = dict(getattr(config, "symbol_map", {}) or {})
        state_path = getattr(config, self.state_field, None)
        if not state_path:
            raise RuleAError("Rule A journal path is not configured")
        self.journal = RuleAJournal(Path(state_path), self.account_ref, strategy_id=self.core.RULE_ID)
        self.sync_client = sync_client
        if self.sync_client is None and getattr(config, "close_endpoint", None) and getattr(config, "close_token", None):
            self.sync_client = RuleASyncClient(config.close_endpoint, config.close_token, timeout=2.0, path=self.sync_path)
        self.symbols: dict[str, str] = dict(self.symbol_map)
        self._rates: dict[str, dict[str, list[dict[str, Any]]]] = {}
        self._evaluation_cache: dict[str, tuple[str, int, dict[str, Any]]] = {}
        self._lease: dict[str, Any] | None = None
        self._execution = self.core.execution_settings()
        self._lease_deadline_mono: float | None = None
        self._last_sync_mono = -1e12
        self._last_status = "starting"
        self._last_reason = "waiting_for_first_cycle"
        self._checks: list[dict[str, Any]] = []
        self._startup_history = False
        self._market_cursor = 0
        self._risk_history_checked = False
        self._fresh_journal = not self.journal.path.exists()
        self.coordinator = None

    # ---- MT5 observations and validation ---------------------------------
    def _now(self) -> datetime:
        now = self.clock()
        if now.tzinfo is None or now.utcoffset() is None:
            raise RuleAError("UTC clock returned a naive timestamp")
        return now.astimezone(UTC)

    def _account(self) -> tuple[Any, Any]:
        terminal, account = self.mt5.terminal_info(), self.mt5.account_info()
        if not terminal or not account or not bool(field_value(terminal, "connected", False)):
            raise RuleAError("MT5 is not connected")
        server, login = str(field_value(account, "server", "")), str(field_value(account, "login", ""))
        if server != self.expected_server or login != self.expected_login:
            raise RuleAError("MT5 account differs from the pinned account")
        if str(field_value(account, "currency", "")).upper() != "USD":
            raise RuleAError("Rule A requires a USD account")
        hedge = getattr(self.mt5, "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING", None)
        if hedge is None or field_value(account, "margin_mode") != hedge:
            raise RuleAError("Rule A requires a hedging account")
        return terminal, account

    def _trade_allowed(self) -> bool:
        terminal, account = self._account()
        return bool(field_value(terminal, "trade_allowed", False)
                    and not field_value(terminal, "tradeapi_disabled", False)
                    and field_value(account, "trade_allowed", False)
                    and field_value(account, "trade_expert", True))

    def _rates_for(self, logical: str, timeframe: str, count: int, now: datetime) -> list[dict[str, Any]]:
        broker = self.symbols[logical]
        spec = {"H1": ("TIMEFRAME_H1", 3600), "M5": ("TIMEFRAME_M5", 300)}[timeframe]
        raw = self.mt5.copy_rates_from_pos(broker, getattr(self.mt5, spec[0]), 1, count + 20)
        if raw is None and timeframe == 'H1' and count > 4096:
            # Some terminals cannot supply the optional long warmup. Preserve
            # the same >=120-day / >=100 complete-D1 acceptance checks below.
            raw = self.mt5.copy_rates_from_pos(broker, getattr(self.mt5, spec[0]), 1, 4096)
        if raw is None:
            last_error = getattr(self.mt5, 'last_error', lambda: (None,))()
            code = last_error[0] if isinstance(last_error, (tuple,list)) and last_error and isinstance(last_error[0],int) else 'unknown'
            raise RuleAError(f"{logical} {timeframe} history is unavailable (MT5 {code})")
        indexed: dict[datetime, dict[str, Any]] = {}
        for item in raw:
            opened = int(field_value(item, "time", 0))
            if opened <= 0:
                continue
            try:
                open_utc = source_to_utc(opened, self.time_basis)
                close_utc = source_to_utc(opened + spec[1], self.time_basis)
            except Exception as exc:
                raise RuleAError(f"{logical} {timeframe} time cannot be normalized") from exc
            if close_utc - open_utc != timedelta(seconds=spec[1]) or close_utc > now:
                continue
            values = {key: _num(field_value(item, key), f"{timeframe} {key}", positive=True)
                      for key in ("open", "high", "low", "close")}
            if values["high"] < max(values["open"], values["close"], values["low"]):
                raise RuleAError(f"{logical} {timeframe} OHLC is invalid")
            if values["low"] > min(values["open"], values["close"], values["high"]):
                raise RuleAError(f"{logical} {timeframe} OHLC is invalid")
            indexed[open_utc] = {"open_time": open_utc, "close_time": close_utc, **values}
        return [indexed[t] for t in sorted(indexed)][-count:]

    def _market_pair(self, logical: str, now: datetime, *, force_full: bool = False) -> None:
        if not self.symbols:
            raise RuleAError("MT5 symbols have not been resolved by the connector")
        if logical not in self.symbols:
            raise RuleAError(f"{logical} is missing from MT5 symbol mapping")
        cached = self._rates.get(logical)
        if cached is None or force_full:
            h1 = self._rates_for(logical, "H1", H1_HISTORY_COUNT, now)
            m5 = self._rates_for(logical, "M5", M5_HISTORY_COUNT, now)
        else:
            fresh_h1 = self._rates_for(logical, "H1", 3, now)
            fresh_m5 = self._rates_for(logical, "M5", 3, now)
            h1 = _merge_bars(cached["H1"], fresh_h1)
            m5 = _merge_bars(cached["M5"], fresh_m5)
        if len(h1) < 120 * 24:
            raise RuleAError(f"{logical} needs at least 120 days of H1 history")
        if len(m5) < 20:
            raise RuleAError(f"{logical} needs at least 20 closed M5 bars")
        if cached is None or force_full:
            frames = self.core.build_frames(h1, now)
            if len(frames["D1"]) < 100 or len(frames["H4"]) < 90:
                raise RuleAError(f"{logical} needs at least 100 closed D1 and 90 closed H4 bars")
        self._rates[logical] = {"H1": h1, "M5": m5}

    def _evaluation(self, logical: str, now: datetime) -> dict[str, Any]:
        h1 = self._rates[logical]["H1"]
        latest = iso_utc(h1[-1]["close_time"]) if h1 else ""
        cached = self._evaluation_cache.get(logical)
        if cached and cached[0] == latest and cached[1] == len(h1):
            return cached[2]
        frames = self.core.build_frames(h1, now)
        if len(frames["D1"]) < 100 or len(frames["H4"]) < 90:
            raise RuleAError(f"{logical} needs at least 100 closed D1 and 90 closed H4 bars")
        result = self.core.evaluate_entry(logical, frames, now)
        self._evaluation_cache[logical] = (latest, len(h1), result)
        return result

    def _market(self, now: datetime, state: Mapping[str, Any]) -> None:
        """Maintain the active basket's feed first and warm one other pair per tick."""
        basket = state.get("basket")
        active_symbol = basket.get("symbol") if isinstance(basket, Mapping) else None
        if active_symbol in self.symbols:
            self._market_pair(active_symbol, now)
        if len(self.symbols) < len(self.core.PAIRS):
            raise RuleAError("MT5 symbol map does not contain all seven Rule A pairs")
        if not self._rates:
            if active_symbol not in self.symbols:
                self._market_pair(self.core.PAIRS[self._market_cursor % len(self.core.PAIRS)], now)
                self._market_cursor += 1
            return
        # A single large first download per one-second loop keeps exit handling responsive.
        for offset in range(len(self.core.PAIRS)):
            pair = self.core.PAIRS[(self._market_cursor + offset) % len(self.core.PAIRS)]
            if pair == active_symbol:
                continue
            self._market_pair(pair, now)
            self._market_cursor = (self._market_cursor + offset + 1) % len(self.core.PAIRS)
            return
        if active_symbol:
            self._market_pair(active_symbol, now)
        self._startup_history = len(self._rates) == len(self.core.PAIRS)

    def _positions(self) -> list[Any]:
        result = self.mt5.positions_get()
        if result is None:
            raise RuleAError("MT5 positions are unavailable")
        return list(result)

    def _orders(self) -> list[Any]:
        getter = getattr(self.mt5, "orders_get", None)
        if not callable(getter):
            raise RuleAError("MT5 pending-order state is unavailable")
        result = getter()
        if result is None:
            raise RuleAError("MT5 pending-order state is unavailable")
        return list(result)

    def _quotes(self, logical: str, now: datetime) -> dict[str, Any]:
        broker = self.symbols[logical]
        tick = self.mt5.symbol_info_tick(broker)
        if tick is None:
            raise RuleAError(f"{logical} quote is unavailable")
        ms = field_value(tick, "time_msc")
        rawtime = float(ms) / 1000 if ms is not None else float(field_value(tick, "time", 0))
        try:
            quote_time = source_to_utc(rawtime, self.time_basis)
        except Exception as exc:
            raise RuleAError(f"{logical} quote time is invalid") from exc
        # Sample local time after the terminal returns the tick so ordinary
        # IPC latency cannot make a just-arrived quote appear future-dated.
        observed_now = self._now()
        age = (observed_now - quote_time).total_seconds()
        bid, ask = _num(field_value(tick, "bid"), "bid", positive=True), _num(field_value(tick, "ask"), "ask", positive=True)
        if ask < bid or not 0 <= age <= MAX_TICK_AGE:
            raise RuleAError(f"{logical} quote is stale or invalid")
        return {"bid": bid, "ask": ask, "time": quote_time, "raw": tick,
                "symbol": logical}

    # ---- Lease and status sync -------------------------------------------
    def _lease_active(self) -> bool:
        return (self._lease is not None and self._lease_deadline_mono is not None
                and time.monotonic() < self._lease_deadline_mono
                and self.enabled_local is True
                and self._lease.get("enabled") is True
                and self._lease.get("account_ref") == self.account_ref)

    def _sync_due(self) -> bool:
        return time.monotonic() - self._last_sync_mono >= LEASE_REFRESH_SECONDS

    def _chart_history_batch(self):
        # Read the runner's existing observed feed. No extra MT5 calls, orders or journal edits.
        if self.core.RULE_ID!='rule_a_improved_v1':return None
        cursor=getattr(self,'_chart_sent',{})
        for pair in self.core.PAIRS:
            rows=self._rates.get(pair,{}).get('H1',[]);progress=cursor.get(pair,{})
            # Backfill newest-to-oldest, so a partly received series has no artificial middle gap.
            newer=[r for r in rows if progress and iso_utc(_dt(r['open_time']))>progress['latest']]
            older=[r for r in rows if not progress or iso_utc(_dt(r['open_time']))<progress['oldest']]
            selected=newer[:512] if newer else older[-512:]
            if selected:
                return {'symbol':pair,'bars':[{**{k:float(r[k]) for k in ('open','high','low','close')},
                  'open_time':iso_utc(_dt(r['open_time'])),'close_time':iso_utc(_dt(r['close_time']))} for r in selected]}
        return None

    def _sync(self, state: Mapping[str, Any], now: datetime, *, force: bool = False) -> bool:
        if not force and not self._sync_due():
            return False
        self._last_sync_mono = time.monotonic()
        if self.sync_client is None:
            self._lease = None
            self._lease_deadline_mono = None
            self._last_reason = "active_sync_credential_unavailable"
            return False
        payload = {
            "schema_version": 1, "strategy_id": self.core.RULE_ID,
            "account_ref": self.account_ref, "instance_id": self.instance_id,
            "checked_at": iso_utc(now),
            "status": {"state": self._last_status, "reason": self._last_reason,
                       "basket": _public_basket(state.get("basket")),
                       "risk": self._risk_status(state, now),
                       "enabled_local": self.enabled_local, "version": 1,
                       "execution": dict(self._execution),
                       **({"coordination": self.coordinator.version} if self.coordinator is not None else {})},
            "checks": self._checks[:7],
            "events": list(state.get("events", []))[-MAX_SYNC_EVENTS:],
        }
        try:chart_batch=self._chart_history_batch()
        except Exception:chart_batch=None
        if chart_batch is not None:payload['chart_history']=chart_batch
        sync_started = time.monotonic()
        try:
            response = self.sync_client.post(payload)
            config = response.get("config")
            if (not isinstance(config, Mapping)
                    or config.get("account_ref") != self.account_ref
                    or config.get("strategy_id") != self.core.RULE_ID
                    or type(config.get("enabled")) is not bool):
                raise RuleAError("Rule A sync config does not match this account/strategy")
            if response.get("ok") is not True or _plain(config.get("rule")) != _plain(self.core.RULE_CONFIG):
                raise RuleAError("Rule A server configuration differs from this runner")
            execution = config.get('execution')
            try:
                if not isinstance(execution, Mapping):
                    raise ValueError('missing execution settings')
                normalized = self.core.execution_settings(execution.get('base_volume'), execution.get('revision'))
                if dict(execution) != normalized or type(execution.get('schema_version')) is not int or type(execution.get('max_adds')) is not int or type(execution.get('revision')) is not int:
                    raise ValueError('invalid execution settings')
            except (ValueError, TypeError):
                self._lease, self._lease_deadline_mono = None, None
                raise RuleAError('Rule A execution settings are invalid') from None
            server_time, expiry = _dt(response.get("server_time")), _dt(config.get("lease_expires_at"))
            if server_time is None or expiry is None or expiry <= server_time:
                raise RuleAError("Rule A sync lease is invalid")
            if abs((self._now() - server_time).total_seconds()) > 5:
                self._lease = None
                self._lease_deadline_mono = None
                raise RuleAError("Rule A server clock differs from the local UTC clock")
            duration = (expiry - server_time).total_seconds()
            if duration > LEASE_MAX_SECONDS:
                raise RuleAError("Rule A sync lease exceeds the 30-second limit")
            deadline = sync_started + duration
            if time.monotonic() >= deadline:
                raise RuleAError("Rule A sync lease expired before the response arrived")
            self._lease = dict(config)
            if chart_batch is not None and response.get('chart_history_accepted') is True:
                if not hasattr(self,'_chart_sent'):self._chart_sent={}
                prior=self._chart_sent.get(chart_batch['symbol'],{})
                first,last=chart_batch['bars'][0]['open_time'],chart_batch['bars'][-1]['open_time']
                self._chart_sent[chart_batch['symbol']]={'oldest':min(prior.get('oldest',first),first),'latest':max(prior.get('latest',last),last)}
            self._execution = normalized
            # Start the local lease clock before the request. Network latency
            # consumes lease time conservatively and cannot extend server expiry.
            self._lease_deadline_mono = deadline
            accepted = response.get("accepted_event_ids", [])
            if not isinstance(accepted, list):
                raise RuleAError("Rule A event acknowledgement is invalid")
            accepted_ids = {str(x) for x in accepted}
            if accepted_ids:
                state["events"] = [e for e in state.get("events", [])
                                   if str(e.get("event_id")) not in accepted_ids]
                self.journal.save(state)
            self._last_reason = "lease_active" if config.get("enabled") else "server_paused"
            return True
        except Exception:
            # A still-live, previously granted lease may be used until its exact
            # monotonic deadline. Once it expires, it is never revived from cache.
            if not self._lease_active():
                self._lease = None
                self._lease_deadline_mono = None
            self._last_reason = "sync_unavailable"
            return False

    def _initial_volume(self, logical, side, quote, levels):
        return self._base_volume()

    def _validate_volume(self, state, kind, volume):
        expected = self._base_volume() if kind == 'initial' else self._basket_base_volume(state.get('basket') or {})
        if not math.isclose(volume, expected, rel_tol=0, abs_tol=1e-8):
            raise RuleAError('lot settings changed before order submission')

    def _validate_request_risk(self, logical, side, request):
        pass

    def _base_volume(self) -> float:
        return self.core.normalize_base_volume(self._execution['base_volume'])

    def _basket_base_volume(self, basket: Mapping[str, Any]) -> float:
        # Pre-settings journals were always exactly .30, including on recovery.
        return self.core.normalize_base_volume(basket.get('base_volume', BASE_VOLUME))

    def _risk_status(self, state: Mapping[str, Any], now: datetime) -> dict[str, Any]:
        events = list(state.get("risk_ledger", []))
        if self.coordinator is not None:
            try:
                events = self.coordinator.risk_events(self, state)
            except Exception:
                return {"can_trade": False, "reason": "peer_journal_unavailable"}
        try:
            return self.core.portfolio_limits(events, now)
        except Exception:
            return {"can_trade": False, "reason": "risk_ledger_invalid"}

    def _emit(self, state: dict[str, Any], *, event_type: str, now: datetime,
              basket: Mapping[str, Any] | None = None, **values: Any) -> None:
        event = {"event_id": str(uuid.uuid4()), "basket_id": str((basket or {}).get("id", "")),
                 "type": event_type, "at": iso_utc(now), **values}
        # Restrict events to JSON-safe scalar and short sequence values.
        state.setdefault("events", []).append(event)
        state["events"] = state["events"][-1000:]
        if event_type == "basket_closed" and event.get("realized_r") is not None:
            state.setdefault("risk_ledger", []).append({"time": event["at"],
                                                         "realized_r": float(event["realized_r"]),
                                                         "basket_id": event["basket_id"]})
        self.journal.save(state)

    def _new_intent(self, state: dict[str, Any], *, kind: str, symbol: str, side: str,
                    volume: float, now: datetime, request: Mapping[str, Any],
                    basket_id: str | None = None, intent_id: str | None = None,
                    comment: str | None = None, strategy: Mapping[str, Any] | None = None,
                    position_ticket: str | None = None) -> dict[str, Any]:
        intent_id = intent_id or str(uuid.uuid4())
        comment = comment or self.comment_prefix + intent_id.replace("-", "")[:24]
        intent = {"intent_id": intent_id, "comment": comment, "kind": kind,
                  "basket_id": basket_id, "symbol": symbol, "side": side,
                  "volume": volume, "created_at": iso_utc(now), "status": "prepared",
                  "request": dict(request), "result": None,
                  "strategy": dict(strategy or {})}
        if position_ticket is not None:
            intent["position_ticket"] = str(position_ticket)
        state.setdefault("intents", {})[intent_id] = intent
        self.journal.save(state)  # write-ahead durability before order_send
        return intent

    def _save_intent_result(self, state: dict[str, Any], intent: dict[str, Any],
                            status: str, result: Mapping[str, Any]) -> None:
        intent["status"] = status
        intent["result"] = dict(result)
        self.journal.save(state)

    def _definite_no_fill(self, retcode: Any, executed_volume: float) -> bool:
        if executed_volume != 0:
            return False
        names = ("TRADE_RETCODE_REQUOTE", "TRADE_RETCODE_REJECT", "TRADE_RETCODE_INVALID",
                 "TRADE_RETCODE_INVALID_VOLUME", "TRADE_RETCODE_INVALID_PRICE",
                 "TRADE_RETCODE_INVALID_STOPS", "TRADE_RETCODE_TRADE_DISABLED",
                 "TRADE_RETCODE_MARKET_CLOSED", "TRADE_RETCODE_NO_MONEY",
                 "TRADE_RETCODE_PRICE_CHANGED", "TRADE_RETCODE_PRICE_OFF",
                 "TRADE_RETCODE_INVALID_FILL")
        return any(hasattr(self.mt5, name) and retcode == getattr(self.mt5, name) for name in names)

    def _unresolved_intents(self, state: Mapping[str, Any]) -> list[Mapping[str, Any]]:
        return [v for v in state.get("intents", {}).values()
                if v.get("status") in {"prepared", "unknown", "partial", "quarantined"}]

    # ---- Trading preflight and helpers -----------------------------------
    def _symbol_info(self, logical: str) -> Any:
        info = self.mt5.symbol_info(self.symbols[logical])
        if info is None:
            raise RuleAError(f"{logical} symbol information is unavailable")
        if field_value(info, "trade_mode") == getattr(self.mt5, "SYMBOL_TRADE_MODE_DISABLED", -999):
            raise RuleAError(f"{logical} trading is disabled")
        return info

    def _exact_volume(self, logical: str, volume: float) -> None:
        info = self._symbol_info(logical)
        minimum = _num(field_value(info, "volume_min"), "minimum volume", positive=True)
        maximum = _num(field_value(info, "volume_max"), "maximum volume", positive=True)
        step = _num(field_value(info, "volume_step"), "volume step", positive=True)
        if volume < minimum - 1e-9 or volume > maximum + 1e-9:
            raise RuleAError("broker limits do not allow the configured lots")
        units = (volume - minimum) / step
        if not math.isclose(units, round(units), rel_tol=0, abs_tol=1e-8):
            raise RuleAError("broker volume step does not allow the configured lots")

    def _filling(self, info: Any) -> int:
        mode = int(field_value(info, "filling_mode", 0))
        ioc_flag = int(getattr(self.mt5, "SYMBOL_FILLING_IOC", 2))
        fok_flag = int(getattr(self.mt5, "SYMBOL_FILLING_FOK", 1))
        if mode & fok_flag:
            return getattr(self.mt5, "ORDER_FILLING_FOK")
        if mode & ioc_flag:
            return getattr(self.mt5, "ORDER_FILLING_IOC")
        raise RuleAError("broker does not offer fill-or-kill or immediate-or-cancel")

    def _round_price(self, logical: str, side: str, level: float, *, sl: bool) -> float:
        info = self._symbol_info(logical)
        tick = _num(field_value(info, "trade_tick_size", field_value(info, "point")), "tick size", positive=True)
        quotient = level / tick
        long_stop = (side == "long" and sl) or (side == "short" and not sl)
        # Stops round away from market; targets round away from entry.
        rounded = math.floor(quotient + 1e-10) * tick if long_stop else math.ceil(quotient - 1e-10) * tick
        digits = int(field_value(info, "digits", 5))
        return round(rounded, digits)

    def _levels(self, basket: Mapping[str, Any]) -> dict[str, float]:
        levels = self.core.basket_levels(basket["side"], float(basket["average_price"]),
                                    float(basket["initial_risk_distance"]), basket["symbol"])
        sl = self._round_price(basket["symbol"], basket["side"], levels["stop"], sl=True)
        tp = self._round_price(basket["symbol"], basket["side"], levels["target"], sl=False)
        return {"stop": sl, "target": tp}

    def _check_margin_and_order(self, request: Mapping[str, Any], logical: str) -> None:
        if (request.get("action") == getattr(self.mt5, "TRADE_ACTION_DEAL", object())
                and "position" not in request):
            account = self.mt5.account_info()
            margin = self.mt5.order_calc_margin(request["type"], request["symbol"],
                                                float(request["volume"]), float(request["price"]))
            required = _num(margin, "required margin", positive=True)
            free = _num(field_value(account, "margin_free"), "free margin", positive=True)
            if required > free:
                raise RuleAError("actual free margin is insufficient")
        check = self.mt5.order_check(dict(request))
        if check is None or field_value(check, "retcode") != 0:
            raise RuleAError("MT5 order_check rejected the request")
        self._account()  # Account identity, USD and hedging mode must still match.

    def _deal_request(self, logical: str, side: str, volume: float, quote: Mapping[str, Any],
                      levels: Mapping[str, float], comment: str) -> dict[str, Any]:
        self._exact_volume(logical, volume)
        info = self._symbol_info(logical)
        buy = side == "long"
        price = float(quote["ask"] if buy else quote["bid"])
        stop_level = float(field_value(info, "trade_stops_level", 0)) * float(field_value(info, "point", 0))
        min_price = float(quote["bid"] if buy else quote["ask"])
        sl, tp = float(levels["stop"]), float(levels["target"])
        valid = ((sl < min_price - stop_level and tp > price + stop_level) if buy
                 else (sl > min_price + stop_level and tp < price - stop_level))
        if not valid:
            raise RuleAError("broker minimum stop distance rejects the protected entry")
        return {"action": getattr(self.mt5, "TRADE_ACTION_DEAL"), "symbol": self.symbols[logical],
                "volume": volume,
                "type": getattr(self.mt5, "ORDER_TYPE_BUY") if buy else getattr(self.mt5, "ORDER_TYPE_SELL"),
                "price": price, "sl": sl, "tp": tp, "deviation": 0, "magic": self.magic,
                "comment": comment, "type_time": getattr(self.mt5, "ORDER_TIME_GTC"),
                "type_filling": self._filling(info)}

    def _send_deal(self, state: dict[str, Any], *, kind: str, logical: str, side: str,
                   volume: float, quote: Mapping[str, Any], levels: Mapping[str, float],
                   now: datetime, strategy: Mapping[str, Any], basket_id: str | None = None) -> tuple[str, list[Any]]:
        self._account()
        if kind in {"initial", "add"} and any(
                int(field_value(order, "magic", -1)) == self.magic for order in self._orders()):
            raise RuleAError("outstanding Rule A order blocks new exposure")
        if not self._trade_allowed():
            raise RuleAError("MT5 automatic trading is disabled")
        if kind in {'initial', 'add'} and self.sync_client is not None:
            if not self._sync(state, self._now(), force=True) or not self._lease_active():
                raise RuleAError('latest execution settings could not be confirmed')
            self._validate_volume(state, kind, volume)
        intent_id = str(uuid.uuid4())
        comment = self.comment_prefix + intent_id.replace("-", "")[:24]
        request = self._deal_request(logical, side, volume, quote, levels, comment)
        self._check_margin_and_order(request, logical)
        if kind in {"initial", "add"} and not self._lease_active():
            raise RuleAError("entry/add blocked because the server lease is not active")
        # Fresh quote/time and lease check directly before the durable intent.
        quote2 = self._quotes(logical, self._now())
        current_price = float(quote2["ask"] if side == "long" else quote2["bid"])
        if abs(current_price - float(request["price"])) > 2 * self.core.pip_size(logical):
            raise RuleAError("quote moved more than 2 pips after order_check")
        if current_price != float(request["price"]):
            request = dict(request)
            request["price"] = current_price
            self._check_margin_and_order(request, logical)
        if kind in {"initial", "add"} and not self._lease_active():
            raise RuleAError("entry/add blocked because the server lease expired")
        if kind == "initial" and self._initial_blocked(self._positions()):
            raise RuleAError("account position appeared before initial order submission")
        if kind in {"initial", "add"} and any(
                int(field_value(order, "magic", -1)) == self.magic for order in self._orders()):
            raise RuleAError("outstanding Rule A order appeared before submission")
        if kind in {"initial", "add"}:
            if self.coordinator is not None and not self.coordinator.can_open(self):
                raise RuleAError("peer strategy state blocks new exposure")
            if not self._risk_status(state, self._now()).get("can_trade"):
                raise RuleAError("portfolio loss limit blocks new exposure")
            if self._foreign_positions(self._positions(), state):
                raise RuleAError("manual or foreign exposure blocks new exposure")
        self._validate_request_risk(logical, side, request)
        intent = self._new_intent(state, kind=kind, symbol=logical, side=side, volume=volume,
                                  now=now, request=request, basket_id=basket_id,
                                  intent_id=intent_id, comment=comment, strategy=strategy)
        try:
            response = self.mt5.order_send(request)
        except Exception:
            response = None
        if response is None:
            self._save_intent_result(state, intent, "unknown", {"retcode": None, "status": "unknown"})
            return "unknown", []
        retcode = field_value(response, "retcode")
        executed = float(field_value(response, "volume", 0) or 0)
        deal = str(field_value(response, "deal", "") or "")
        done_codes = {getattr(self.mt5, "TRADE_RETCODE_DONE", -1), getattr(self.mt5, "TRADE_RETCODE_DONE_PARTIAL", -2)}
        definite_names = ("TRADE_RETCODE_REQUOTE", "TRADE_RETCODE_REJECT", "TRADE_RETCODE_INVALID",
                          "TRADE_RETCODE_INVALID_VOLUME", "TRADE_RETCODE_INVALID_PRICE", "TRADE_RETCODE_INVALID_STOPS",
                          "TRADE_RETCODE_TRADE_DISABLED", "TRADE_RETCODE_MARKET_CLOSED", "TRADE_RETCODE_NO_MONEY",
                          "TRADE_RETCODE_PRICE_CHANGED", "TRADE_RETCODE_PRICE_OFF", "TRADE_RETCODE_INVALID_FILL")
        definite = {getattr(self.mt5, n) for n in definite_names if hasattr(self.mt5, n)}
        if retcode in done_codes and deal and executed > 0:
            outcome = "succeeded" if math.isclose(executed, volume, rel_tol=0, abs_tol=1e-8) else "partial"
        elif retcode in definite:
            outcome = "failed"
        else:
            outcome = "unknown"
        result = {"status": outcome, "retcode": retcode if isinstance(retcode, (int, str)) else None,
                  "deal_id": deal[:32] if deal.isdecimal() else None, "order_id": str(field_value(response, "order", ""))[:32],
                  "executed_volume": executed if math.isfinite(executed) else None}
        self._save_intent_result(state, intent, outcome, result)
        if outcome in {"succeeded", "partial", "unknown"}:
            try:
                positions = self._positions()
                deals = self._intent_deals(intent, self._now())
                matches = self._intent_positions(intent, positions, deals)
            except Exception:
                positions, matches = [], []
            if matches:
                partial = outcome != "succeeded" or not math.isclose(
                    sum(float(field_value(p, "volume", 0)) for p in matches), volume, rel_tol=0, abs_tol=1e-8)
                self._apply_filled_intent(state, intent, matches, self._now(), partial=partial)
                if isinstance(state.get("basket"), Mapping):
                    try:
                        self._manage_basket(state, self._positions(), self._now())
                    except Exception:
                        state["quarantine"] = state.get("quarantine") or "post_fill_protection_unverified"
                        self.journal.save(state)
                if not partial:
                    outcome = "succeeded"
            else:
                intent["status"] = "unknown"
                state["quarantine"] = "fill_not_reconciled_to_position"
                self.journal.save(state)
                outcome = "unknown"
        return outcome, matches if 'matches' in locals() else []


    # ---- Durable reconciliation -----------------------------------------
    def _deal_rows(self, start: datetime, end: datetime) -> list[Any]:
        try:
            query_from, query_to = history_query_bounds(start, end, self.time_basis)
        except Exception as exc:
            raise RuleAError("MT5 deal-history query window is invalid") from exc
        rows = self.mt5.history_deals_get(query_from, query_to)
        if rows is None:
            raise RuleAError("MT5 deal history is unavailable")
        return list(rows)

    def _deal_time(self, deal: Any) -> datetime:
        raw = field_value(deal, "time_msc")
        epoch = float(raw) / 1000 if raw is not None else float(field_value(deal, "time", 0))
        return source_to_utc(epoch, self.time_basis)

    def _own_deals(self, start: datetime, end: datetime) -> list[Any]:
        return [d for d in self._deal_rows(start, end)
                if int(field_value(d, "magic", -1)) == self.magic
                and start <= self._deal_time(d) <= end]

    def _check_initial_risk_ledger(self, state: dict[str, Any], now: datetime) -> None:
        if self._risk_history_checked:
            return
        if self._fresh_journal:
            month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            week_start = (now.replace(hour=0, minute=0, second=0, microsecond=0)
                          - timedelta(days=now.weekday()))
            scan_start = min(month_start, week_start)
            try:
                own = self._own_deals(scan_start, now)
            except RuleAError:
                state["quarantine"] = "missing_journal_risk_history_unavailable"
                self.journal.save(state)
                return
            if own:
                # The actual initial-risk USD denominator was lost with the
                # journal, so historical cash cannot be represented in R.
                state["quarantine"] = "missing_journal_risk_ledger_unreconstructable"
                self.journal.save(state)
            elif state.get("quarantine") == "missing_journal_risk_history_unavailable":
                state["quarantine"] = None
                self.journal.save(state)
            self._fresh_journal = False
        self._risk_history_checked = True

    def _intent_deals(self, intent: Mapping[str, Any], now: datetime) -> list[Any]:
        start = _dt(intent.get("created_at"))
        if start is None:
            return []
        try:
            rows = self._deal_rows(start - timedelta(minutes=1), now)
        except RuleAError:
            return []
        return [d for d in rows
                if int(field_value(d, "magic", -1)) == self.magic
                and str(field_value(d, "comment", "")) == str(intent.get("comment"))
                and start - timedelta(minutes=1) <= self._deal_time(d) <= now]

    def _position_identity(self, position: Any) -> tuple[str, str]:
        return (str(field_value(position, "ticket", "")),
                str(field_value(position, "identifier", "")))

    def _intent_positions(self, intent: Mapping[str, Any], positions: list[Any],
                          deals: list[Any]) -> list[Any]:
        ids = {str(field_value(d, "position_id", "")) for d in deals}
        ticket_ids = {str(field_value(d, "ticket", "")) for d in deals}
        comment = str(intent.get("comment", ""))
        requested_ticket = str(intent.get("position_ticket", ""))
        result = []
        for p in positions:
            ticket, identifier = self._position_identity(p)
            if (int(field_value(p, "magic", -1)) == self.magic and
                    (ticket == requested_ticket
                     or str(field_value(p, "comment", "")) == comment
                     or identifier in ids or ticket in ids or ticket in ticket_ids)):
                result.append(p)
        return result

    def _positions_from_entry_deals(self, intent: Mapping[str, Any], deals: list[Any]) -> list[dict[str, Any]]:
        """Rebuild a fill identity from authoritative own entry deals if the
        broker already closed the position before positions_get observed it."""
        entries = [d for d in deals
                   if int(field_value(d, "magic", -1)) == self.magic
                   and str(field_value(d, "comment", "")) == str(intent.get("comment", ""))
                   and field_value(d, "entry") == getattr(self.mt5, "DEAL_ENTRY_IN", object())
                   and str(field_value(d, "position_id", "")) not in {"", "0"}]
        groups: dict[str, list[Any]] = {}
        for deal in entries:
            groups.setdefault(str(field_value(deal, "position_id")), []).append(deal)
        result = []
        for identifier, rows in groups.items():
            volume = sum(float(field_value(row, "volume", 0)) for row in rows)
            if volume <= 0:
                continue
            avg = sum(float(field_value(row, "volume", 0)) * float(field_value(row, "price", 0))
                      for row in rows) / volume
            first = min(rows, key=self._deal_time)
            raw_time = field_value(first, "time_msc")
            raw_time = float(raw_time) / 1000 if raw_time is not None else float(field_value(first, "time", 0))
            request = intent.get("request", {})
            result.append({"ticket": str(field_value(first, "position_id", identifier)),
                           "identifier": identifier, "magic": self.magic,
                           "symbol": self.symbols.get(str(intent.get("symbol")), str(intent.get("symbol"))),
                           "volume": volume, "price_open": avg, "time": raw_time,
                           "sl": float(request.get("sl", 0) or 0),
                           "tp": float(request.get("tp", 0) or 0),
                           "comment": str(intent.get("comment", ""))})
        return result

    def _resolve_position_legs(self, state: Mapping[str, Any], basket: Mapping[str, Any],
                               positions: list[Any]) -> list[Any]:
        known = {str(k) for k in basket.get("legs", {})}
        known_ids = {str(v.get("identifier")) for v in basket.get("legs", {}).values()}
        own = [p for p in positions if int(field_value(p, "magic", -1)) == self.magic]
        untracked = [p for p in own if self._position_identity(p)[0] not in known
                     and self._position_identity(p)[1] not in known_ids]
        if untracked:
            raise RuleAError("untracked Rule A magic position quarantines this account")
        return [p for p in own if self._position_identity(p)[0] in known
                or self._position_identity(p)[1] in known_ids]

    def _reconcile(self, state: dict[str, Any], positions: list[Any], now: datetime) -> None:
        intents = state.get("intents", {})
        for intent in intents.values():
            if intent.get("status") not in {"prepared", "unknown", "partial", "quarantined"} \
                    and not (intent.get("kind") in {"initial", "add"}
                             and intent.get("status") == "succeeded" and not intent.get("applied")):
                continue
            deals = self._intent_deals(intent, now)
            matches = self._intent_positions(intent, positions, deals)
            intent["last_reconciled_at"] = iso_utc(now)
            if intent.get("kind") in {"initial", "add"} and matches:
                filled = sum(float(field_value(x, "volume", 0)) for x in matches)
                partial = not math.isclose(filled, float(intent["volume"]), rel_tol=0, abs_tol=1e-8)
                intent["status"] = "partial" if partial else "succeeded"
                intent["matched_tickets"] = [self._position_identity(x)[0] for x in matches]
                intent["matched_identifiers"] = [self._position_identity(x)[1] for x in matches]
                self._apply_filled_intent(state, intent, matches, now, partial=partial)
            elif intent.get("kind") in {"initial", "add"} and deals:
                reconstructed = self._positions_from_entry_deals(intent, deals)
                if reconstructed:
                    filled = sum(float(p["volume"]) for p in reconstructed)
                    partial = not math.isclose(filled, float(intent["volume"]), rel_tol=0, abs_tol=1e-8)
                    intent["status"] = "partial" if partial else "succeeded"
                    intent["matched_tickets"] = [self._position_identity(p)[0] for p in reconstructed]
                    intent["matched_identifiers"] = [self._position_identity(p)[1] for p in reconstructed]
                    self._apply_filled_intent(state, intent, reconstructed, now, partial=partial)
                else:
                    intent["status"] = "quarantined"
                    state["quarantine"] = "filled_deal_without_reconcilable_position"
            elif intent.get("kind") in {"sltp", "close"}:
                # Check broker-native position state before any possible reattempt.
                if intent.get("kind") == "sltp" and matches:
                    req = intent.get("request", {})
                    if all(_same_price(field_value(p, "sl", 0), req.get("sl"))
                           and _same_price(field_value(p, "tp", 0), req.get("tp")) for p in matches):
                        intent["status"] = "succeeded"
                        intent["result"] = {"retcode": "reconciled"}
                    else:
                        intent["status"] = "quarantined"
                elif intent.get("kind") == "close" and not matches and deals:
                    intent["status"] = "succeeded"
                    intent["result"] = {"retcode": "reconciled"}
                else:
                    intent["status"] = "unknown"
            else:
                intent["status"] = "unknown"
        if any(v.get("status") == "quarantined" for v in intents.values()):
            state["quarantine"] = state.get("quarantine") or "unresolved_order_intent"
        self.journal.save(state)

    def _adopt_intent_exposure(self, state: dict[str, Any], intent: Mapping[str, Any],
                               positions: list[Any], now: datetime) -> None:
        meta = intent.get("strategy", {})
        raw_stop = meta.get("raw_stop")
        symbol, side = str(intent.get("symbol")), str(intent.get("side"))
        if symbol not in self.core.PAIRS or side not in {"long", "short"} or raw_stop is None:
            state["quarantine"] = "initial_intent_missing_strategy_metadata"
            return
        volume = sum(float(field_value(p, "volume", 0)) for p in positions)
        avg = sum(float(field_value(p, "volume", 0)) * float(field_value(p, "price_open", 0))
                  for p in positions) / volume if volume else 0.0
        risk = abs(avg - float(raw_stop)) * float(meta.get("stop_scale", 0.5))
        if volume <= 0 or risk <= 0:
            state["quarantine"] = "initial_intent_exposure_invalid"
            return
        unrounded_stop = avg - risk if side == "long" else avg + risk
        actual_stop = self._round_price(symbol, side, unrounded_stop, sl=True)
        if (side == "long" and actual_stop >= avg) or (side == "short" and actual_stop <= avg):
            state["quarantine"] = "initial_stop_rounding_invalid"
            return
        order_type = getattr(self.mt5, "ORDER_TYPE_BUY") if side == "long" else getattr(self.mt5, "ORDER_TYPE_SELL")
        stop_cash = abs(_num(self.mt5.order_calc_profit(order_type, self.symbols[symbol], volume,
                                                        avg, actual_stop), "initial stop cash risk"))
        cost_distance = 1.2 * self.core.pip_size(symbol)
        cost_price = avg - cost_distance if side == "long" else avg + cost_distance
        cost_cash = abs(_num(self.mt5.order_calc_profit(order_type, self.symbols[symbol], volume,
                                                        avg, cost_price), "initial cost allowance"))
        risk_usd = stop_cash + cost_cash
        if risk_usd <= 0:
            state["quarantine"] = "initial_usd_risk_unavailable"
            return
        state["basket"] = {"id": intent.get("basket_id") or intent["intent_id"], "symbol": symbol,
                           "base_volume": self.core.normalize_base_volume(intent['volume']),
                           "side": side, "opened_at": intent["created_at"], "entry_price": avg,
            "average_price": avg, "initial_risk_distance": abs(avg - actual_stop),
                           "initial_risk_usd": risk_usd, "adds": 0, "trail_active": False,
                           "legs": {self._position_identity(p)[0]: _leg_from_position(p, intent["comment"], self.time_basis)
                                    for p in positions}, "deadline": iso_utc(self.core.exit_deadline(intent["created_at"]))}

    def _apply_filled_intent(self, state: dict[str, Any], intent: dict[str, Any],
                             positions: list[Any], now: datetime, *, partial: bool) -> None:
        if intent.get("applied"):
            return
        kind, strategy = intent.get("kind"), intent.get("strategy", {})
        if kind == "initial":
            self._adopt_intent_exposure(state, intent, positions, now)
            basket = state.get("basket")
            if not isinstance(basket, dict):
                return
            basket["id"] = intent.get("basket_id") or intent["intent_id"]
            basket["raw_stop"] = float(strategy["raw_stop"])
            # _adopt_intent_exposure used the actual rounded native stop and
            # includes the strategy's 1.2-pip cost allowance in USD R.
            intent["applied"] = True
            filled_volume = sum(float(field_value(p, "volume", 0)) for p in positions)
            # Life OS: per-leg identity for the server's ticket-keyed trade history.
            legs = _event_legs(positions)
            basket["group_ticket"] = legs[0]["ticket"] if legs else None
            self._emit(state, event_type="basket_open", now=now, basket=basket,
                       symbol=basket["symbol"], side=basket["side"], volume=filled_volume,
                       price=basket["average_price"], sl=self._levels(basket)["stop"],
                       tp=self._levels(basket)["target"], reason="automatic_entry",
                       legs=legs, group_ticket=basket["group_ticket"])
        elif kind == "add":
            basket = state.get("basket")
            if not isinstance(basket, dict):
                state["quarantine"] = "add_fill_without_known_basket"
                return
            fill_volume = sum(float(field_value(p, "volume", 0)) for p in positions)
            fill_price = (sum(float(field_value(p, "volume", 0)) * float(field_value(p, "price_open", 0))
                              for p in positions) / fill_volume) if fill_volume else 0.0
            for p in positions:
                ticket = str(field_value(p, "ticket", ""))
                basket.setdefault("legs", {})[ticket] = _leg_from_position(p, intent["comment"], self.time_basis)
            total = sum(float(v["volume"]) for v in basket["legs"].values())
            basket["average_price"] = sum(float(v["volume"]) * float(v["entry_price"])
                                           for v in basket["legs"].values()) / total
            basket["adds"] = min(self.max_adds, int(basket.get("adds", 0)) + 1)
            basket["trail_active"] = False
            basket.pop("active_stop", None)
            intent["applied"] = True
            levels = self._levels(basket)
            self._emit(state, event_type="add_filled", now=now, basket=basket,
                       symbol=basket["symbol"], side=basket["side"], volume=fill_volume,
                       price=fill_price, sl=levels["stop"], tp=levels["target"],
                       reason=f"automatic_add_{basket['adds']}",
                       legs=_event_legs(positions), group_ticket=basket.get("group_ticket"))
        if partial:
            intent["status"] = "quarantined"
            state["quarantine"] = "partial_or_unexpected_fill"
        self.journal.save(state)

    def _modify_position(self, state: dict[str, Any], basket: Mapping[str, Any],
                         position: Any, levels: Mapping[str, float], now: datetime) -> bool:
        ticket = str(field_value(position, "ticket", ""))
        if int(field_value(position, "magic", -1)) != self.magic or ticket not in basket.get("legs", {}):
            return False
        if (_same_price(field_value(position, "sl", 0), levels["stop"])
                and _same_price(field_value(position, "tp", 0), levels["target"])):
            return True
        for pending in state.get("intents", {}).values():
            if pending.get("kind") == "sltp" and pending.get("position_ticket") == ticket \
                    and pending.get("status") in {"prepared", "unknown", "partial", "quarantined"}:
                req = pending.get("request", {})
                if (_same_price(field_value(position, "sl", 0), req.get("sl"))
                        and _same_price(field_value(position, "tp", 0), req.get("tp"))):
                    pending["status"] = "succeeded"
                    self.journal.save(state)
                    return True
                return False
        request = {"action": getattr(self.mt5, "TRADE_ACTION_SLTP"),
                   "symbol": self.symbols[basket["symbol"]], "position": int(ticket),
                   "sl": float(levels["stop"]), "tp": float(levels["target"]),
                   "magic": self.magic, "comment": self.comment_prefix + "-protect"}
        check = self.mt5.order_check(dict(request))
        if check is None or field_value(check, "retcode") != 0 or not self._trade_allowed():
            return False
        intent_id = str(uuid.uuid4())
        intent = self._new_intent(state, kind="sltp", symbol=basket["symbol"], side=basket["side"],
                                  volume=float(field_value(position, "volume", 0)), now=now,
                                  request=request, basket_id=str(basket["id"]), intent_id=intent_id,
                                  comment=self.comment_prefix + intent_id.replace("-", "")[:24], position_ticket=ticket)
        try:
            response = self.mt5.order_send(request)
        except Exception:
            response = None
        if response is not None and field_value(response, "retcode") == getattr(self.mt5, "TRADE_RETCODE_DONE", -1):
            intent["status"] = "succeeded"
            intent["result"] = {"retcode": int(field_value(response, "retcode"))}
            self.journal.save(state)
            refreshed = self._positions()
            current = next((p for p in refreshed if str(field_value(p, "ticket", "")) == ticket), None)
            return bool(current and _same_price(field_value(current, "sl", 0), levels["stop"])
                        and _same_price(field_value(current, "tp", 0), levels["target"]))
        intent["status"] = "unknown"
        intent["result"] = {"retcode": field_value(response, "retcode") if response else None}
        self.journal.save(state)
        return False

    def _close_managed(self, state: dict[str, Any], basket: Mapping[str, Any],
                       positions: list[Any], now: datetime, reason: str) -> bool:
        all_closed = True
        for position in positions:
            ticket = str(field_value(position, "ticket", ""))
            leg = basket.get("legs", {}).get(ticket)
            if (not leg or int(field_value(position, "magic", -1)) != self.magic
                    or str(field_value(position, "identifier", "")) != str(leg.get("identifier"))):
                continue
            related = [pending for pending in state.get("intents", {}).values()
                       if pending.get("kind") == "close" and pending.get("position_ticket") == ticket]
            if any(pending.get("status") in {"prepared", "unknown", "partial", "quarantined"}
                   for pending in related):
                all_closed = False
                continue
            retry_after = max((_dt(pending.get("retry_after")) for pending in related
                               if pending.get("status") == "failed" and _dt(pending.get("retry_after"))),
                              default=None)
            if retry_after is not None and now < retry_after:
                all_closed = False
                continue
            try:
                quote = self._quotes(basket["symbol"], now)
                side = basket["side"]
                close_price = quote["bid"] if side == "long" else quote["ask"]
                info = self._symbol_info(basket["symbol"])
                volume = _num(field_value(position, "volume"), "position volume", positive=True)
                request = {"action": getattr(self.mt5, "TRADE_ACTION_DEAL"),
                           "symbol": self.symbols[basket["symbol"]], "volume": volume,
                           "type": getattr(self.mt5, "ORDER_TYPE_SELL") if side == "long" else getattr(self.mt5, "ORDER_TYPE_BUY"),
                           "position": int(ticket), "price": close_price, "deviation": 0,
                           "magic": self.magic, "comment": self.comment_prefix + "-close", "type_time": getattr(self.mt5, "ORDER_TIME_GTC"),
                           "type_filling": self._filling(info)}
                check = self.mt5.order_check(request)
                if check is None or field_value(check, "retcode") != 0 or not self._trade_allowed():
                    all_closed = False
                    continue
                intent_id = str(uuid.uuid4())
                comment = self.comment_prefix + intent_id.replace("-", "")[:24]
                request["comment"] = comment
                intent = self._new_intent(state, kind="close", symbol=basket["symbol"], side=side,
                                          volume=volume, now=now, request=request, basket_id=str(basket["id"]),
                                          intent_id=intent_id, comment=comment,
                                          position_ticket=ticket)
                try:
                    response = self.mt5.order_send(request)
                except Exception:
                    response = None
                if response is None:
                    self._save_intent_result(state, intent, "unknown", {"retcode": None})
                    all_closed = False
                    continue
                retcode = field_value(response, "retcode")
                executed = float(field_value(response, "volume", 0) or 0)
                if retcode == getattr(self.mt5, "TRADE_RETCODE_DONE", -1) \
                        and math.isclose(executed, volume, rel_tol=0, abs_tol=1e-8):
                    status = "succeeded"
                elif executed > 0:
                    status = "partial"
                elif self._definite_no_fill(retcode, executed):
                    status = "failed"
                    intent["retry_after"] = iso_utc(now + timedelta(seconds=5))
                else:
                    status = "unknown"
                self._save_intent_result(state, intent, status,
                                         {"retcode": retcode, "executed_volume": executed})
                if status != "succeeded":
                    all_closed = False
            except Exception:
                all_closed = False
        if not all_closed:
            state["quarantine"] = state.get("quarantine") or f"close_unconfirmed:{reason}"
            self.journal.save(state)
        elif str(state.get("quarantine", "")).startswith("close_unconfirmed:"):
            state["quarantine"] = None
            self.journal.save(state)
        return all_closed

    def _manage_basket(self, state: dict[str, Any], positions: list[Any], now: datetime) -> None:
        basket = state.get("basket")
        if not isinstance(basket, dict):
            return
        matched = self._resolve_position_legs(state, basket, positions)
        if not matched:
            self._finalize_basket(state, basket, now)
            return
        if len(matched) != len(basket.get("legs", {})):
            self._close_managed(state, basket, matched, now, "leg_missing")
            state["quarantine"] = state.get("quarantine") or "managed_leg_missing"
            self.journal.save(state)
            return
        deadline = _dt(basket.get("deadline"))
        if deadline is None:
            state["quarantine"] = "basket_deadline_invalid"
            self.journal.save(state)
            return
        if now >= deadline:
            self._close_managed(state, basket, matched, now, "time_exit")
            return
        total = sum(float(field_value(p, "volume", 0)) for p in matched)
        if not 0 < total <= self._basket_base_volume(basket) * (self.max_adds + 1) + 1e-8:
            state["quarantine"] = "managed_volume_outside_limit"
            self.journal.save(state)
            return
        basket["average_price"] = sum(float(field_value(p, "volume", 0)) * float(field_value(p, "price_open", 0))
                                      for p in matched) / total
        levels = self._levels(basket)
        quote = self._quotes(basket["symbol"], now)
        trail = self._trailing(basket, quote, now)
        basket["trail_active"] = bool(trail["active"])
        if trail.get("level") is not None:
            candidate = self._round_price(basket["symbol"], basket["side"], float(trail["level"]), sl=True)
            active_stop = (max(levels["stop"], candidate) if basket["side"] == "long"
                           else min(levels["stop"], candidate))
            previous = basket.get("active_stop")
            if previous is not None:
                active_stop = (max(active_stop, float(previous)) if basket["side"] == "long"
                               else min(active_stop, float(previous)))
            basket["active_stop"] = active_stop
            levels["stop"] = active_stop
        self.journal.save(state)
        if getattr(self, 'trail_touch_close', False) and basket.get('trail_active'):
            executable = quote['bid'] if basket['side']=='long' else quote['ask']
            if (executable<=levels['stop'] if basket['side']=='long' else executable>=levels['stop']):
                self._close_managed(state,basket,matched,now,'trailing_exit')
                return
        for position in matched:
            if not self._modify_position(state, basket, position, levels, now):
                self._emit(state, event_type="protection_failure", now=now, basket=basket,
                           symbol=basket["symbol"], side=basket["side"], reason="native_sltp_update_failed")
                self._close_managed(state, basket, matched, now, "protection_failure")
                state["quarantine"] = "native_sltp_update_failed"
                self.journal.save(state)
                return
        for p in matched:
            ticket = str(field_value(p, "ticket", ""))
            if ticket in basket["legs"]:
                basket["legs"][ticket].update({"sl": levels["stop"], "tp": levels["target"]})
        self.journal.save(state)

    def _trailing(self, basket, quote, now):
        return self.core.trailing_level(basket["side"], self._rates[basket["symbol"]]["M5"],
                                    basket["average_price"], quote, active=bool(basket.get("trail_active")),
                                    symbol=basket["symbol"], previous_level=basket.get("active_stop"),
                                    decision_time=now)

    def _initial_blocked(self, positions):
        if self.coordinator is None:
            return bool(positions)
        return self.coordinator.initial_blocked(self, positions)

    def _foreign_positions(self, positions, state):
        legs=(state.get('basket') or {}).get('legs',{})
        own=set()
        for p in positions:
            ticket=str(field_value(p,'ticket',''));leg=legs.get(ticket)
            if leg and int(field_value(p,'magic',-1))==self.magic and str(field_value(p,'identifier',''))==str(leg.get('identifier')):
                own.add(ticket)
        others = [p for p in positions if str(field_value(p, "ticket", "")) not in own]
        if self.coordinator is None:
            return bool(others)
        return any(not self.coordinator.known_peer_position(self, p) for p in others)

    def _finalize_basket(self, state: dict[str, Any], basket: Mapping[str, Any], now: datetime) -> bool:
        opened = _dt(basket.get("opened_at"))
        risk_usd = float(basket.get("initial_risk_usd", 0) or 0)
        if opened is None or risk_usd <= 0:
            state["quarantine"] = "closed_basket_risk_ledger_invalid"
            self.journal.save(state)
            return False
        try:
            deals = self._deal_rows(opened - timedelta(minutes=1), now)
        except RuleAError:
            state["quarantine"] = "closed_basket_deal_history_unavailable"
            self.journal.save(state)
            return False
        legs = basket.get("legs", {})
        by_identifier: dict[str, list[Any]] = {}
        known_ids = {str(leg.get("identifier")) for leg in basket.get("legs", {}).values()}
        for d in deals:
            posid = str(field_value(d, "position_id", ""))
            if posid in known_ids:
                by_identifier.setdefault(posid, []).append(d)
        net = 0.0
        complete = True
        latest_exit: datetime | None = None
        weighted_close = 0.0
        close_volume = 0.0
        leg_results: list[dict[str, Any]] = []  # Life OS: per-leg close for ticket-keyed history
        for leg_ticket, leg in legs.items():
            leg_net = 0.0
            leg_px = 0.0
            leg_vol = 0.0
            leg_exit: datetime | None = None
            ident = str(leg.get("identifier"))
            ds = by_identifier.get(ident, [])
            exits = [d for d in ds if field_value(d, "entry") in {
                getattr(self.mt5, "DEAL_ENTRY_OUT", object()),
                getattr(self.mt5, "DEAL_ENTRY_OUT_BY", object()),
                getattr(self.mt5, "DEAL_ENTRY_INOUT", object())}]
            volume_out = sum(float(field_value(d, "volume", 0)) for d in exits)
            if volume_out + 1e-8 < float(leg.get("volume", 0)):
                complete = False
            for d in exits:
                dt = self._deal_time(d)
                if latest_exit is None or dt > latest_exit:
                    latest_exit = dt
                if leg_exit is None or dt > leg_exit:
                    leg_exit = dt
                price = float(field_value(d, "price", 0) or 0)
                vol = float(field_value(d, "volume", 0) or 0)
                if price > 0 and vol > 0:
                    weighted_close += price * vol
                    close_volume += vol
                    leg_px += price * vol
                    leg_vol += vol
            for d in ds:
                amount = sum(float(field_value(d, k, 0) or 0) for k in ("profit", "commission", "swap", "fee"))
                net += amount
                leg_net += amount
            leg_results.append({"ticket": str(leg.get("ticket") or leg_ticket), "volume": float(leg.get("volume", 0) or 0),
                                "entry_price": leg.get("entry_price"), "opened_at": leg.get("opened_at"),
                                "pnl_usd": leg_net, "price": leg_px / leg_vol if leg_vol else None,
                                "at": iso_utc(leg_exit) if leg_exit else None})
        if not complete:
            state["quarantine"] = "closed_basket_deal_history_incomplete"
            self.journal.save(state)
            return False
        realized_r = net / risk_usd
        exit_time = latest_exit or now
        for leg_result in leg_results:
            # Leg R values sum exactly to the basket R (same initial-risk denominator).
            leg_result["r_multiple"] = leg_result["pnl_usd"] / risk_usd
            leg_result["at"] = leg_result["at"] or iso_utc(exit_time)
        event_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"rule-a-basket-close:{basket.get('id')}"))
        existing_event = next((event for event in state.get("events", [])
                               if event.get("type") == "basket_closed"
                               and event.get("basket_id") == str(basket.get("id"))), None)
        if existing_event is None:
            state.setdefault("events", []).append({
                "event_id": event_id, "basket_id": str(basket.get("id", "")),
                "type": "basket_closed", "at": iso_utc(exit_time),
                "symbol": basket["symbol"], "side": basket["side"],
                "volume": sum(float(v.get("volume", 0)) for v in legs.values()),
                "pnl_usd": net, "realized_r": realized_r,
                "price": weighted_close / close_volume if close_volume else None,
                "reason": "broker_or_local_exit", "legs": leg_results,
                "group_ticket": basket.get("group_ticket")})
        if not any(event.get("basket_id") == str(basket.get("id"))
                   for event in state.setdefault("risk_ledger", [])):
            state["risk_ledger"].append({"time": iso_utc(exit_time),
                                         "realized_r": realized_r,
                                         "basket_id": str(basket.get("id", ""))})
        for intent in state.get("intents", {}).values():
            if intent.get("basket_id") == basket.get("id") and intent.get("kind") in {"close", "sltp"}:
                intent["status"] = "succeeded"
                intent["result"] = {"retcode": "basket_closed_reconciled"}
        state["basket"] = None
        self.journal.save(state)
        return True

    def _entry_cycle(self, state: dict[str, Any], positions: list[Any], now: datetime) -> None:
        evaluations = []
        checks = []
        for logical in self.core.PAIRS:
            if logical not in self._rates:
                continue
            result = self._evaluation(logical, now)
            evaluations.append((logical, result))
            checks.append({k: result.get(k) for k in ("symbol", "state", "direction", "as_of", "trend", "checks", "indicators")})
        self._checks = checks[:7]
        if state.get("basket") is not None or state.get("quarantine"):
            return
        if self._initial_blocked(positions):
            self._last_reason = "account_position_blocks_initial_entry"
            return
        if self._unresolved_intents(state):
            self._last_reason = "unresolved_intent_blocks_initial_entry"
            return
        risk = self._risk_status(state, now)
        if not risk.get("can_trade"):
            self._last_reason = "portfolio_loss_limit"
            return
        candidates = []
        for logical, result in evaluations:
            asof = _dt(result.get("as_of"))
            if asof is None:
                continue
            bucket = iso_utc(asof)
            if state.get("last_initial_bucket") == bucket:
                continue
            if result.get("state") != "ready" or not isinstance(result.get("signal"), Mapping):
                continue
            if (now - asof).total_seconds() > MAX_SIGNAL_AGE:
                self._last_reason = "entry_signal_late_no_catchup"
                continue
            signal = result["signal"]
            if not self.enabled_local or not self._lease_active():
                self._last_reason = "local_disabled_or_lease_expired"
                return
            try:
                quote = self._quotes(logical, now)
                lag = (quote["time"] - asof).total_seconds()
                if not 0 <= lag <= MAX_SIGNAL_AGE:
                    self._last_reason = "entry_next_m5_quote_late"
                    continue
                fill = quote["ask"] if signal["direction"] == "long" else quote["bid"]
                levels = self.core.plan_entry(signal, fill)
                rounded = {"stop": self._round_price(logical, signal["direction"], levels["stop"], sl=True),
                           "target": self._round_price(logical, signal["direction"], levels["target"], sl=False)}
                # Consume the timestamp globally before preflight/send so a
                # restart or a later pair cannot replay this H1 decision.
                state["last_initial_bucket"] = bucket
                state["processed_h1"] = {pair: bucket for pair in self.core.PAIRS}
                self.journal.save(state)
                self._send_deal(state, kind="initial", logical=logical, side=signal["direction"],
                                volume=self._initial_volume(logical, signal["direction"], quote, rounded), quote=quote, levels=rounded, now=now,
                                strategy={"raw_stop": signal["raw_stop"], "atr14_h1": signal["atr14_h1"],
                                          "decision_close": signal["decision_close"], "signal_as_of": signal["as_of"],
                                          "stop_scale": self.core.RULE_CONFIG["stop_scale"]})
                self._last_status, self._last_reason = "basket_opening", "automatic_initial_entry"
                return
            except Exception as exc:
                if result.get("state") == "ready":
                    state["last_initial_bucket"] = bucket
                    state["processed_h1"] = {pair: bucket for pair in self.core.PAIRS}
                    self.journal.save(state)
                self._last_reason = _safe_reason(exc)
                return
        self._checks = checks[:7]
        self._last_status = "watching"
        if self._last_reason in {"starting", "waiting_for_first_cycle", "lease_active"}:
            self._last_reason = "no_ready_signal"

    def _add_cycle(self, state: dict[str, Any], now: datetime) -> None:
        basket = state.get("basket")
        if not isinstance(basket, Mapping) or basket.get("symbol") not in self._rates:
            return
        deadline = _dt(basket.get("deadline"))
        if deadline is None or now >= deadline:
            self._last_reason = "basket_deadline_has_priority_over_add"
            return
        if state.get("quarantine") or self._unresolved_intents(state):
            self._last_reason = "quarantined_basket_blocks_add"
            return
        if int(basket.get("adds", 0)) >= self.max_adds:
            return
        if not self.enabled_local or not self._lease_active():
            self._last_reason = "add_blocked_by_expired_lease"
            return
        if not self._risk_status(state, now).get("can_trade"):
            self._last_reason = "portfolio_loss_limit"
            return
        logical = str(basket["symbol"])
        m5 = self._rates[logical]["M5"]
        if not m5:
            return
        closed = m5[-1]
        close_time = closed["close_time"]
        key = iso_utc(close_time)
        if state["processed_m5"].get(logical) == key:
            return
        # One add evaluation per closed M5 bucket, even after an interruption.
        state["processed_m5"][logical] = key
        self.journal.save(state)
        if (now - close_time).total_seconds() > MAX_SIGNAL_AGE:
            self._last_reason = "add_signal_late_no_catchup"
            return
        try:
            if not self.core.add_condition(basket["side"], m5, now, symbol=logical):
                return
            all_positions = self._positions()
            current_positions = self._resolve_position_legs(state, basket, all_positions)
            if self._foreign_positions(all_positions, state):
                self._last_reason = "manual_or_foreign_position_blocks_add"
                return
            volume_now = sum(float(field_value(p, "volume", 0)) for p in current_positions)
            base_volume = self._basket_base_volume(basket)
            if volume_now + base_volume > base_volume * (self.max_adds + 1) + 1e-8:
                self._last_reason = "max_basket_volume_reached"
                return
            quote = self._quotes(logical, now)
            lag = (quote["time"] - close_time).total_seconds()
            if not 0 <= lag <= MAX_SIGNAL_AGE:
                self._last_reason = "add_next_m5_quote_late"
                return
            px = quote["ask"] if basket["side"] == "long" else quote["bid"]
            projected = (float(basket["average_price"]) * volume_now + px * base_volume) / (volume_now + base_volume)
            levels = self.core.basket_levels(basket["side"], projected,
                                        float(basket["initial_risk_distance"]), logical)
            rounded = {"stop": self._round_price(logical, basket["side"], levels["stop"], sl=True),
                       "target": self._round_price(logical, basket["side"], levels["target"], sl=False)}
            self._send_deal(state, kind="add", logical=logical, side=basket["side"], volume=base_volume,
                            quote=quote, levels=rounded, now=now,
                            strategy={"add_index": int(basket.get("adds", 0)) + 1,
                                      "decision_time": iso_utc(close_time)}, basket_id=str(basket["id"]))
            self._last_status, self._last_reason = "basket_adding", f"automatic_add_{int(basket.get('adds', 0)) + 1}"
        except Exception as exc:
            self._last_reason = _safe_reason(exc)

    def _status_snapshot(self, state: Mapping[str, Any], now: datetime) -> None:
        basket = state.get("basket")
        if state.get("quarantine"):
            self._last_status, self._last_reason = "blocked", str(state["quarantine"])
        elif basket:
            self._last_status = "managing"
        elif not self.enabled_local:
            self._last_status, self._last_reason = "disabled", "local_rule_a_disabled"
        elif not self._lease_active():
            self._last_status, self._last_reason = "paused", "server_lease_inactive"

    def run_once(self) -> dict[str, Any]:
        """Run one bounded market/action cycle; exceptions become fail-closed status."""
        now = self._now()
        try:
            state = self.journal.load()
        except Exception as exc:
            self._last_status, self._last_reason = "blocked", _safe_reason(exc)
            return {"strategy_id": self.core.RULE_ID, "state": "blocked",
                    "reason": self._last_reason, "account_ref": self.account_ref,
                    "enabled_local": self.enabled_local, "lease_active": False,
                    "basket": None, "risk": {"can_trade": False,
                                               "reason": "journal_unavailable"},
                    "checked_at": iso_utc(now), "checks": list(self._checks[:7])}
        try:
            self._account()
            self._check_initial_risk_ledger(state, now)
            positions = self._positions()
            try:
                pending = self._orders()
            except RuleAError:
                pending = []
                state["quarantine"] = state.get("quarantine") or "pending_order_state_unavailable"
                self.journal.save(state)
            if any(int(field_value(order, "magic", -1)) == self.magic for order in pending):
                state["quarantine"] = state.get("quarantine") or "unresolved_rule_a_pending_order"
                self.journal.save(state)
            self._reconcile(state, positions, now)
            basket = state.get("basket")
            # Time exits run before HTTP sync or long history warmup. Native
            # broker SL/TP remains active regardless of server lease/network.
            if isinstance(basket, Mapping) and _dt(basket.get("deadline")) and now >= _dt(basket["deadline"]):
                self._close_managed(state, basket, positions, now, "time_exit")
            try:
                self._market(now, state)
            except Exception as exc:
                self._last_reason = _safe_reason(exc)
            if isinstance(state.get("basket"), Mapping):
                try:
                    positions = self._positions()
                    self._manage_basket(state, positions, now)
                except Exception as exc:
                    state["quarantine"] = state.get("quarantine") or _safe_reason(exc)
                    self.journal.save(state)
                self._add_cycle(state, now)
            self._sync(state, now)
            positions = self._positions()
            if state.get("basket") is None:
                unknown_magic = [p for p in positions if int(field_value(p, "magic", -1)) == self.magic]
                if unknown_magic and not state.get("quarantine"):
                    state["quarantine"] = "untracked_rule_a_magic_position"
                    self.journal.save(state)
            self._entry_cycle(state, positions, now)
            self._status_snapshot(state, now)
            # Send action-generated events/status on next bounded sync cycle.
            self._sync(state, now, force=False)
            return self.status(state=state, now=now)
        except Exception as exc:
            self._last_status, self._last_reason = "blocked", _safe_reason(exc)
            try:
                self._sync(state, now)
            except Exception:
                pass
            return self.status(state=state, now=now)

    def status(self, *, state: Mapping[str, Any] | None = None, now: datetime | None = None) -> dict[str, Any]:
        current = now or self.clock().astimezone(UTC)
        state = state or self.journal.load()
        return {"strategy_id": self.core.RULE_ID, "state": self._last_status,
                "reason": self._last_reason, "account_ref": self.account_ref,
                "enabled_local": self.enabled_local, "lease_active": self._lease_active(),
                "basket": _public_basket(state.get("basket")),
                "risk": self._risk_status(state, current),
                "checked_at": iso_utc(current), "checks": list(self._checks[:7])}


def _merge_bars(old: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = {row["open_time"]: row for row in old}
    rows.update({row["open_time"]: row for row in new})
    return [rows[k] for k in sorted(rows)][-H1_HISTORY_COUNT:]


def _same_price(actual: Any, expected: Any) -> bool:
    try:
        expected = float(expected)
        actual = float(actual or 0)
    except (TypeError, ValueError):
        return False
    return math.isfinite(actual) and math.isfinite(expected) and math.isclose(actual, expected, rel_tol=0, abs_tol=1e-8)


def _leg_from_position(position: Any, comment: str, time_basis: str = "utc") -> dict[str, Any]:
    return {"ticket": str(field_value(position, "ticket", "")),
            "identifier": str(field_value(position, "identifier", "")),
            "symbol": str(field_value(position, "symbol", "")),
            "volume": float(field_value(position, "volume", 0)),
            "entry_price": float(field_value(position, "price_open", 0)),
            "opened_at": iso_utc(source_to_utc(float(field_value(position, "time", 0)), time_basis)),
            "sl": float(field_value(position, "sl", 0) or 0),
            "tp": float(field_value(position, "tp", 0) or 0), "comment": comment}


def _event_legs(positions: list[Any]) -> list[dict[str, Any]]:
    """Life OS addition: ticket / volume / fill price of each filled position, for trade events."""
    return [{"ticket": str(field_value(p, "ticket", "")),
             "volume": float(field_value(p, "volume", 0) or 0),
             "price": float(field_value(p, "price_open", 0) or 0),
             "sl": float(field_value(p, "sl", 0) or 0) or None,
             "tp": float(field_value(p, "tp", 0) or 0) or None} for p in positions]


def _public_basket(basket: Any) -> dict[str, Any] | None:
    if not isinstance(basket, Mapping):
        return None
    volume = sum(float(leg.get("volume", 0)) for leg in basket.get("legs", {}).values())
    result = {key: basket.get(key) for key in ("id", "symbol", "side", "opened_at", "average_price",
                                               "initial_risk_distance", "initial_risk_usd", "adds",
                                               "trail_active", "deadline")}
    result.update({"add_count": int(basket.get("adds", 0)), "total_volume": volume,
                   "base_volume": core.normalize_base_volume(basket.get('base_volume', BASE_VOLUME)),
                   "volume": volume})
    return result


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [_plain(v) for v in value]
    return value


def _safe_reason(exc: BaseException) -> str:
    text = str(exc).replace("\n", " ").strip()
    if not text:
        return type(exc).__name__
    return text[:180]


__all__ = ["MAGIC", "BASE_VOLUME", "MAX_VOLUME", "MAX_ADDS", "RuleAAgent",
           "RuleAError", "RuleAJournal", "RuleASyncClient"]



