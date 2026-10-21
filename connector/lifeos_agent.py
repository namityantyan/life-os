"""Life OS orchestration around the proven strategy agents.

The three strategy agents (rule_a_agent / donchian_agent / donchian_v6_agent, coordinated by
auto_strategies) are the previous Windows connector's code, unchanged in their decision, ordering,
protection, reconciliation and journal logic. This module only replaces what talked to the old server:

  * `PermissionGate` — the Life OS permissions (heartbeat every 5 s, GET /permissions before every
    entry/add) become the agents' "lease". New entries/adds need ALL of: fresh permissions (≤ 30 s,
    bounded by the server lease expiry), the lease held by this terminal, the rule in enabled_rules,
    no server R-limit block, trading hours, a valid year config (改良4・6), a valid common lot (A・改良4),
    and a server clock within 5 s of ours. Protection / trailing / time exits never depend on it.
  * `TradeReporter` — turns the agents' durable journal events into /trades payloads (shared/fx.ts)
    and removes them only after HTTP 200. Retrying a report never touches MT5.
  * `SignalReporter`, `CandleFeeder`, heartbeat/quotes — reporting only.
"""
from __future__ import annotations

import logging
import math
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Mapping, Optional

import auto_strategies
import donchian_engine
import donchian_v6_engine
import rule_a_engine
from donchian_agent import DonchianAgent
from donchian_v6_agent import DonchianV6Agent
from mt5_adapter import MT5Adapter, logical_to_pair
from mt5_common import ConnectorError, field_value, iso_utc, parse_utc, utc_now
from rule_a_agent import RuleAAgent, RuleAError, _same_price

LOG = logging.getLogger("lifeos.fx")
UTC = timezone.utc

RULE_KEY = {rule_a_engine.RULE_ID: "rule_a", donchian_engine.RULE_ID: "donchian4", donchian_v6_engine.RULE_ID: "donchian6"}
RULE_LABEL = {"rule_a": "ルールA改良版", "donchian4": "ドンチャン改良4", "donchian6": "ドンチャン改良6"}
STATE_FILES = {"rule_a": "rule-a.json", "donchian4": "donchian.json", "donchian6": "donchian-v6.json"}
SIDE = {"long": "BUY", "short": "SELL"}
PERMISSIONS_REFRESH_SEC = 5.0
PERMISSIONS_MAX_AGE_SEC = 30.0
MAX_CLOCK_SKEW_SEC = 5.0
D6_MAX_RISK_USD = 60.0
JUDGE_BAR_SEC = {"rule_a": 3600, "donchian4": 14400, "donchian6": 14400}  # H1 / H4 judgment bars

# Check labels (as emitted by the engines) that make up the "準備" (setup) stage per rule.
SETUP_LABELS = {
    "rule_a": ("D1 trend alignment", "H4 trend alignment", "H1 trend alignment", "H1 pullback to SMA16",
               "H1 close vs D1 SMA10", "D1/H4 freshness"),
    "donchian4": ("Closed history", "D1/H4 trend alignment", "H1 pullback to SMA16", "D1/H1 freshness",
                  "H1 continuity", "Annual preset"),
}
SETUP_LABELS["donchian6"] = SETUP_LABELS["donchian4"]


def _now_utc(clock: Callable[[], datetime]) -> datetime:
    return clock().astimezone(UTC)


# ======================================================================= permissions
class PermissionGate:
    """Holds the latest server permissions and decides whether NEW exposure is allowed."""

    def __init__(self, client: Any, clock: Callable[[], datetime] = utc_now, *, monotonic: Callable[[], float] = time.monotonic):
        self.client = client
        self.clock = clock
        self.monotonic = monotonic
        self.perms: Optional[dict] = None
        self.deadline_mono = 0.0
        self.received_mono = -1e12
        self.attempt_mono = -1e12
        self.reason = "permissions_not_received"

    # ---- updates --------------------------------------------------------------------
    def update(self, perms: Mapping[str, Any], started_mono: float) -> bool:
        """Accept a permissions object fetched by a request that STARTED at `started_mono`."""
        try:
            server_time = parse_utc(perms.get("server_time"))
            lease = perms.get("lease") or {}
            expires = parse_utc(lease.get("expires_at"))
            if server_time is None:
                raise ValueError("server_time")
            life = PERMISSIONS_MAX_AGE_SEC
            if expires is not None:
                life = max(0.0, min(life, (expires - server_time).total_seconds()))
            elif lease.get("held_by_you"):
                raise ValueError("lease without expiry")
            skew = abs((_now_utc(self.clock) - server_time).total_seconds())
        except Exception:
            self.invalidate("permissions_invalid")
            return False
        self.perms = dict(perms)
        self.received_mono = started_mono
        self.deadline_mono = started_mono + life if lease.get("held_by_you") else started_mono
        self.reason = "server_clock_skew" if skew > MAX_CLOCK_SKEW_SEC else "ok"
        return True

    def invalidate(self, reason: str) -> None:
        self.perms = None
        self.deadline_mono = 0.0
        self.reason = reason

    def refresh(self, force: bool = False) -> bool:
        """GET /permissions when forced (before every entry/add) or when the cache is older than 5 s."""
        if not force and self.monotonic() - max(self.received_mono, self.attempt_mono) < PERMISSIONS_REFRESH_SEC:
            return self.fresh()
        started = self.monotonic()
        self.attempt_mono = started
        try:
            perms = self.client.permissions()
        except Exception as exc:  # network / HTTP error → the cached lease simply runs out
            LOG.warning("permissions refresh failed: %s", type(exc).__name__)
            if self.monotonic() >= self.deadline_mono:
                self.reason = "permissions_expired"
            return False
        return self.update(perms, started) and self.fresh()

    # ---- decisions ------------------------------------------------------------------
    def fresh(self) -> bool:
        return self.perms is not None and self.monotonic() < self.deadline_mono and self.reason == "ok"

    def common_lot(self) -> Optional[float]:
        return None if self.perms is None else self.perms.get("common_lot")

    def risk_usd_donchian6(self) -> float:
        try:
            value = float((self.perms or {}).get("risk_usd_donchian6", D6_MAX_RISK_USD))
        except (TypeError, ValueError):
            return 0.0
        # The frozen preset is 60 USD; a lower server setting is honoured, a higher one never.
        return max(0.0, min(D6_MAX_RISK_USD, value)) if math.isfinite(value) else 0.0

    def block_reason(self, rule: str, now: datetime) -> Optional[str]:
        """None when a NEW entry/add for `rule` may be sent now; otherwise a short reason."""
        p = self.perms
        if p is None:
            return self.reason if self.reason != "ok" else "permissions_not_received"
        if self.reason != "ok":
            return self.reason
        if self.monotonic() >= self.deadline_mono:
            return "permissions_expired"
        if not (p.get("lease") or {}).get("held_by_you"):
            return "lease_not_held"
        if rule not in (p.get("enabled_rules") or []):
            return "rule_disabled"
        if (p.get("r_limit_block") or {}).get("blocked"):
            return "server_r_limit"
        if rule in ("donchian4", "donchian6"):
            until = parse_utc(f"{p.get('year_config_valid_until', '')}T00:00:00Z")
            if not p.get("year_config_valid") or until is None or now >= until:
                return "year_config_expired"
        hours = p.get("trading_hours") or {}
        try:
            start, end = int(hours.get("start_utc", 6)), int(hours.get("end_utc", 20))
        except (TypeError, ValueError):
            return "trading_hours_invalid"
        if hours.get("weekdays_only", True) and now.weekday() >= 5:
            return "outside_trading_hours"
        if not (start <= now.hour < end):
            return "outside_trading_hours"
        if rule in ("rule_a", "donchian4"):
            try:
                rule_a_engine.normalize_base_volume(p.get("common_lot"))
            except ValueError:
                return "common_lot_invalid"
        return None


# ======================================================================= agents
class LifeOSAgentMixin:
    """Replaces the old server sync of RuleAAgent with the Life OS permission gate + reporters."""
    rule_key = ""
    gate: Optional[PermissionGate] = None
    reporter: Optional["TradeReporter"] = None

    def attach(self, gate: PermissionGate, reporter: Optional["TradeReporter"]) -> None:
        self.gate = gate
        self.reporter = reporter
        # Non-None so _send_deal force-refreshes permissions and re-validates the lot before every entry/add.
        self.sync_client = gate

    def _gate_block(self) -> Optional[str]:
        if self.gate is None:
            return "permissions_not_received"
        return self.gate.block_reason(self.rule_key, self._now())

    def _lease_active(self) -> bool:  # used by the agents ONLY for initial entries and adds
        return self.enabled_local is True and self._gate_block() is None

    def _apply_execution(self) -> None:
        if self.rule_key == "donchian6":
            self._execution = self.core.execution_settings()
            return
        try:
            self._execution = self.core.execution_settings(self.gate.common_lot(), 0)
        except (ValueError, TypeError):
            pass  # the gate blocks new exposure with common_lot_invalid; the previous lot is never "fixed up"

    def _sync(self, state: Mapping[str, Any], now: datetime, *, force: bool = False) -> bool:
        if not force and self.reporter is not None:
            try:
                self.reporter.flush(self, state)
            except Exception as exc:  # reporting never blocks protection
                LOG.warning("trade report failed: %s", type(exc).__name__)
        if not force and not self._sync_due():
            return False  # as before: status/reason is refreshed every 5 s, the gate itself is always current
        self._last_sync_mono = time.monotonic()
        if self.gate is None:
            self._last_reason = "permissions_not_received"
            return False
        ok = self.gate.refresh(force=force)
        if self.gate.perms is not None:
            self._apply_execution()
        block = self._gate_block()
        self._last_reason = "lease_active" if block is None else block
        return ok

    def _modify_position(self, state, basket, position, levels, now):
        before_sl, before_tp = field_value(position, "sl", 0), field_value(position, "tp", 0)
        ok = super()._modify_position(state, basket, position, levels, now)
        if ok and not (_same_price(before_sl, levels["stop"]) and _same_price(before_tp, levels["target"])):
            self._emit(state, event_type="sltp_modified", now=now, basket=basket, symbol=basket["symbol"],
                       side=basket["side"], ticket=str(field_value(position, "ticket", "")),
                       volume=float(field_value(position, "volume", 0) or 0),
                       price=float(field_value(position, "price_open", 0) or 0),
                       sl=float(levels["stop"]), tp=float(levels["target"]),
                       reason="trailing" if basket.get("trail_active") else "protection",
                       group_ticket=basket.get("group_ticket"))
        return ok


class LifeOSRuleAAgent(LifeOSAgentMixin, RuleAAgent):
    rule_key = "rule_a"


class LifeOSDonchian4Agent(LifeOSAgentMixin, DonchianAgent):
    rule_key = "donchian4"


class LifeOSDonchian6Agent(LifeOSAgentMixin, DonchianV6Agent):
    rule_key = "donchian6"

    def _risk_budget_usd(self) -> float:
        return D6_MAX_RISK_USD if self.gate is None else self.gate.risk_usd_donchian6()


class LifeOSStrategies(auto_strategies.AutoStrategies):
    """Same coordinator as the previous connector (separate journals, combined R, peer-verified exposure),
    always running all three agents; the SERVER decides which may open new exposure."""

    def __init__(self, mt5: Any, config: Any, *, clock: Callable[[], datetime] = utc_now):
        self.version = 2
        self.agents = [LifeOSRuleAAgent(mt5, config, clock=clock), LifeOSDonchian4Agent(mt5, config, clock=clock),
                       LifeOSDonchian6Agent(mt5, config, clock=clock)]
        for agent in self.agents:
            agent.coordinator = self
        if len({a.journal.path for a in self.agents}) != len(self.agents):
            raise RuleAError("strategies must have separate journals")
        self._symbols = {}
        shared = self.agents[0]._rates
        for agent in self.agents:
            agent._rates = shared

    def by_rule(self, rule: str) -> Any:
        return next(a for a in self.agents if a.rule_key == rule)


def agent_config(state_dir: Path, *, server: str, login: str, time_basis: str, symbol_map: Mapping[str, str]) -> SimpleNamespace:
    return SimpleNamespace(expected_server=server, expected_login=login, time_basis=time_basis,
                           symbol_map=dict(symbol_map),
                           rule_a_state_path=state_dir / STATE_FILES["rule_a"],
                           donchian_state_path=state_dir / STATE_FILES["donchian4"],
                           donchian_v6_state_path=state_dir / STATE_FILES["donchian6"],
                           enable_rule_a=True, enable_donchian=True, enable_donchian_v6=True,
                           close_endpoint=None, close_token=None)


# ======================================================================= reporting
def trade_payloads(rule: str, event: Mapping[str, Any]) -> Optional[list[dict]]:
    """Journal event → TradeEventPayload list (shared/fx.ts). None = not a reportable trade event."""
    kind = event.get("type")
    symbol, side = str(event.get("symbol", "")), SIDE.get(str(event.get("side", "")))
    if side is None or "_" not in symbol:
        return None
    pair = logical_to_pair(symbol)
    base = {"rule": rule, "pair": pair, "side": side}
    group = event.get("group_ticket")
    out: list[dict] = []

    def num(value: Any) -> Optional[float]:
        try:
            v = float(value)
        except (TypeError, ValueError):
            return None
        return v if math.isfinite(v) else None

    if kind in ("basket_open", "add_filled"):
        for leg in event.get("legs") or []:
            price = num(leg.get("price")) or num(event.get("price"))
            if not leg.get("ticket") or price is None:
                continue
            out.append({**base, "event": "open" if kind == "basket_open" else "add", "ticket": str(leg["ticket"]),
                        "price": price, "lots": num(leg.get("volume")) or 0.0,
                        "sl": num(event.get("sl")), "tp": num(event.get("tp")), "at": str(event.get("at")),
                        "group_ticket": str(group) if group and kind == "add_filled" else None,
                        "note": str(event.get("reason") or "")[:200] or None})
    elif kind == "basket_closed":
        for leg in event.get("legs") or []:
            price = num(leg.get("price")) or num(event.get("price")) or num(leg.get("entry_price"))
            if not leg.get("ticket") or price is None:
                continue
            out.append({**base, "event": "close", "ticket": str(leg["ticket"]), "price": price,
                        "lots": num(leg.get("volume")) or 0.0, "sl": None, "tp": None,
                        "pnl_usd": num(leg.get("pnl_usd")), "r_multiple": num(leg.get("r_multiple")),
                        "at": str(leg.get("at") or event.get("at")),
                        "group_ticket": str(group) if group else None, "note": str(event.get("reason") or "")[:200] or None})
    elif kind == "sltp_modified":
        price = num(event.get("price"))
        if event.get("ticket") and price is not None:
            out.append({**base, "event": "modify", "ticket": str(event["ticket"]), "price": price,
                        "lots": num(event.get("volume")) or 0.0, "sl": num(event.get("sl")), "tp": num(event.get("tp")),
                        "at": str(event.get("at")), "note": str(event.get("reason") or "")[:200] or None})
    else:
        return None
    return out


class TradeReporter:
    """Posts journal events to /trades. Events leave the journal only after the server accepted them."""

    def __init__(self, client: Any):
        self.client = client
        self.failed_until = 0.0

    def flush(self, agent: Any, state: dict) -> int:
        events = list(state.get("events") or [])
        if not events or time.monotonic() < self.failed_until:
            return 0
        payloads: list[dict] = []
        done: set[str] = set()
        for event in events:
            built = trade_payloads(agent.rule_key, event)
            if built is None:
                # Not a trade event (e.g. protection_failure, or a pre-Life-OS event without leg tickets):
                # the stop reason itself stays in the journal's quarantine; the event is just logged.
                LOG.info("%s journal event %s not reported", agent.rule_key, event.get("type"))
            else:
                payloads.extend(built)
            done.add(str(event.get("event_id")))
        if payloads:
            try:
                self.client.trades(payloads)
            except Exception:
                self.failed_until = time.monotonic() + 10
                raise
        state["events"] = [e for e in state.get("events", []) if str(e.get("event_id")) not in done]
        agent.journal.save(state)
        return len(payloads)


def signal_stage(rule: str, result: Mapping[str, Any]) -> tuple[str, Optional[str]]:
    direction = result.get("direction")
    side = SIDE.get(str(direction))
    if result.get("state") == "ready" and side:  # engines report "ready" only with a complete entry signal
        return "entry", side
    checks = {c.get("label"): bool(c.get("passed")) for c in result.get("checks") or []}
    if side and all(checks.get(label) for label in SETUP_LABELS[rule]):
        return "setup", side
    return "none", side


def signal_payload(rule: str, result: Mapping[str, Any]) -> Optional[dict]:
    symbol, as_of = result.get("symbol"), result.get("as_of")
    if not symbol or not as_of:
        return None
    stage, side = signal_stage(rule, result)
    indicators: dict[str, Any] = {"state": str(result.get("state", "")), "direction": str(result.get("direction", ""))}
    for key, value in (result.get("indicators") or {}).items():
        if isinstance(value, bool) or value is None or isinstance(value, str):
            indicators[str(key)] = value
        elif isinstance(value, (int, float)) and math.isfinite(value):
            indicators[str(key)] = float(value)
    for check in result.get("checks") or []:
        indicators[f"ok:{check.get('label')}"] = bool(check.get("passed"))
    closed = parse_utc(as_of)
    if closed is None:
        return None
    # The server's bar_time is the judgment bar's OPEN (MT5 convention; staleness = open + bar width).
    # The engines report the decision bar's CLOSE as `as_of`, so shift by the judgment timeframe.
    opened = closed - timedelta(seconds=JUDGE_BAR_SEC[rule])
    indicators["decision_close_at"] = iso_utc(closed)
    return {"pair": logical_to_pair(str(symbol)), "rule": rule, "side": side, "stage": stage,
            "bar_time": iso_utc(opened), "indicators": indicators}


class SignalReporter:
    def __init__(self, client: Any):
        self.client = client
        self.sent: dict[tuple[str, str], tuple[str, str, Optional[str]]] = {}

    def collect(self, strategies: LifeOSStrategies) -> list[dict]:
        out = []
        for agent in strategies.agents:
            for result in list(agent._checks or []):
                payload = signal_payload(agent.rule_key, result)
                if payload is None:
                    continue
                key = (payload["rule"], payload["pair"])
                sig = (payload["bar_time"], payload["stage"], payload["side"])
                if self.sent.get(key) != sig:
                    out.append(payload)
        return out

    def flush(self, strategies: LifeOSStrategies) -> int:
        items = self.collect(strategies)
        if items:
            self.client.signals(items)
            for p in items:
                self.sent[(p["rule"], p["pair"])] = (p["bar_time"], p["stage"], p["side"])
        return len(items)


class CandleFeeder:
    """Shares closed bars with the server: M5 (30 days), H1 (long history for D1 SMA90 on the chart),
    H4 (UTC 4-hour groups built from H1 exactly like the engines), D1 (the broker's daily bars).
    Newest chunk first; at most `budget` POSTs per call; afterwards only newly closed bars."""
    HISTORY = {"M5": 30 * 24 * 12, "H1": 12020, "D1": 500}
    CHUNK = 2000

    def __init__(self, client: Any, adapter: MT5Adapter, clock: Callable[[], datetime] = utc_now):
        self.client, self.adapter, self.clock = client, adapter, clock
        self.sent_to: dict[tuple[str, str], int] = {}
        self.queue: list[tuple[str, str, list[dict]]] = []
        self.loaded: set[str] = set()
        self.last_poll = 0.0

    def _initial(self, logical: str) -> None:
        try:
            self._initial_load(logical)
        except Exception as exc:  # a broken series must not trigger a re-download every second
            LOG.warning("%s candle history unavailable: %s", logical, exc)
        self.loaded.add(logical)

    def _initial_load(self, logical: str) -> None:
        pair = logical_to_pair(logical)
        h1 = self.adapter.rates(logical, "H1", self.HISTORY["H1"])
        frames = {"M5": self.adapter.rates(logical, "M5", self.HISTORY["M5"]), "H1": h1,
                  "H4": self._h4(h1), "D1": self.adapter.rates(logical, "D1", self.HISTORY["D1"])}
        for tf, bars in frames.items():
            if not bars:
                continue
            for end in range(len(bars), 0, -self.CHUNK):
                self.queue.append((pair, tf, bars[max(0, end - self.CHUNK):end]))
            self.sent_to[(pair, tf)] = bars[-1]["t"]

    def _h4(self, h1: list[dict]) -> list[dict]:
        if not h1:
            return []
        rows = [{"open_time": datetime.fromtimestamp(b["t"], UTC), "open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"]} for b in h1]
        try:
            frames = rule_a_engine.build_frames(rows, self.clock())
        except ValueError as exc:
            LOG.info("H4 aggregation skipped: %s", exc)
            return []
        return [{"t": int(r["open_time"].timestamp()), "o": r["open"], "h": r["high"], "l": r["low"], "c": r["close"]} for r in frames["H4"]]

    def _incremental(self, logical: str) -> None:
        pair = logical_to_pair(logical)
        recent = {"M5": self.adapter.rates(logical, "M5", 3), "H1": self.adapter.rates(logical, "H1", 12),
                  "D1": self.adapter.rates(logical, "D1", 2)}
        recent["H4"] = self._h4(self.adapter.rates(logical, "H1", 12))
        for tf, bars in recent.items():
            new = [b for b in bars if b["t"] > self.sent_to.get((pair, tf), 0)]
            if new:
                self.queue.append((pair, tf, new))
                self.sent_to[(pair, tf)] = new[-1]["t"]

    def step(self, budget: int = 4) -> int:
        if not self.adapter.connected:
            return 0
        for logical in self.adapter.symbols:
            if logical not in self.loaded:
                self._initial(logical)
                break  # one large download per call keeps the loop responsive
        else:
            if time.monotonic() - self.last_poll >= 5:
                self.last_poll = time.monotonic()
                for logical in self.adapter.symbols:
                    try:
                        self._incremental(logical)
                    except Exception as exc:
                        LOG.info("%s candle update: %s", logical, exc)
        posted = 0
        while self.queue and posted < budget:
            pair, tf, bars = self.queue[0]
            self.client.candles(pair, tf, bars)
            self.queue.pop(0)
            posted += 1
        return posted

    @property
    def done(self) -> bool:
        return not self.queue and set(self.adapter.symbols) <= self.loaded


# ======================================================================= orchestrator
class Orchestrator:
    """One process: MT5 connection, the three agents, heartbeat/permissions, reporting."""
    HEARTBEAT_SEC = 5.0
    QUOTES_SEC = 5.0
    RECONNECT_SEC = 10.0

    def __init__(self, cfg: Any, client: Any, adapter: MT5Adapter, *, trade: bool, clock: Callable[[], datetime] = utc_now):
        self.cfg, self.client, self.adapter, self.trade = cfg, client, adapter, trade
        self.clock = clock
        self.gate = PermissionGate(client, clock)
        self.trades = TradeReporter(client)
        self.signals = SignalReporter(client)
        self.candles = CandleFeeder(client, adapter, clock)
        self.strategies: Optional[LifeOSStrategies] = None
        self.global_reasons: list[str] = []
        self._last_hb = -1e12
        self._last_quotes = -1e12
        self._last_connect = -1e12

    # ---- MT5 / agents ------------------------------------------------------------
    def ensure_connected(self) -> bool:
        if self.adapter.connected:
            return True
        if time.monotonic() - self._last_connect < self.RECONNECT_SEC:
            return False
        self._last_connect = time.monotonic()
        try:
            self.adapter.connect()
        except ConnectorError as exc:
            self._set_reason("mt5", str(exc))
            LOG.warning("%s", exc)
            return False
        except Exception as exc:
            self._set_reason("mt5", "MT5に接続できません")
            LOG.warning("MT5 connect failed: %s", type(exc).__name__)
            return False
        self._set_reason("mt5", None)
        self._check_time_basis()
        if self.strategies is None:
            config = agent_config(self.cfg.state_dir, server=self.adapter.pinned_server, login=self.adapter.pinned_login,
                                  time_basis=self.adapter.time_basis, symbol_map=self.adapter.symbols)
            self.strategies = LifeOSStrategies(self.adapter.mt5, config, clock=self.clock)
            for agent in self.strategies.agents:
                agent.attach(self.gate, self.trades if self.trade else None)
        self.strategies.symbols = dict(self.adapter.symbols)
        return True

    def _check_time_basis(self) -> None:
        """Flag (never auto-correct) a TIME_BASIS that contradicts live tick stamps; a wrong basis fails closed."""
        try:
            offset = self.adapter.tick_offset_seconds()
        except Exception:
            offset = None
        text = None
        if offset is not None:
            if self.adapter.time_basis == "utc" and 6300 <= offset <= 11700:
                text = "MT5の時刻がXMサーバー時刻に見えます。TIME_BASIS=xm_europe を確認してください（新規は止まります）"
            elif self.adapter.time_basis == "xm_europe" and abs(offset) < 900:
                text = "MT5の時刻がUTCに見えます。TIME_BASIS=utc を確認してください（新規は止まります）"
        self._set_reason("time", text)

    def _set_reason(self, key: str, text: Optional[str]) -> None:
        self.global_reasons = [r for r in self.global_reasons if not r.startswith(f"[{key}]")]
        if text:
            self.global_reasons.append(f"[{key}] {text}")

    def run_strategies(self) -> None:
        assert self.strategies is not None
        if self.trade:
            self.strategies.run_once()
        else:
            self.evaluate_read_only()

    def evaluate_read_only(self) -> None:
        """--once: evaluate the closed bars for every pair WITHOUT any journal write or MT5 order call."""
        assert self.strategies is not None
        now = _now_utc(self.clock)
        first = self.strategies.agents[0]
        for logical in rule_a_engine.PAIRS:
            try:
                first._market_pair(logical, now, force_full=True)
            except Exception as exc:
                LOG.info("%s history: %s", logical, exc)
        for agent in self.strategies.agents:
            checks = []
            for logical in rule_a_engine.PAIRS:
                if logical not in agent._rates:
                    continue
                try:
                    result = agent._evaluation(logical, now)
                except Exception as exc:
                    LOG.info("%s %s evaluation: %s", agent.rule_key, logical, exc)
                    continue
                checks.append({k: result.get(k) for k in ("symbol", "state", "direction", "as_of", "trend", "checks", "indicators", "signal")})
            agent._checks = checks

    # ---- state for the server ------------------------------------------------------
    def stop_reasons(self) -> list[str]:
        reasons = list(self.global_reasons)
        if self.gate.reason not in ("ok", "permissions_not_received"):
            reasons.append(f"[server] {self.gate.reason}")
        if self.strategies is not None:
            for agent in self.strategies.agents:
                label = RULE_LABEL[agent.rule_key]
                try:
                    state = agent.journal.load()
                except Exception:
                    reasons.append(f"{label}: 台帳を安全に読めないため停止中")
                    continue
                if state.get("quarantine"):
                    reasons.append(f"{label}: 停止中（{state['quarantine']}）")
                if agent._unresolved_intents(state):
                    reasons.append(f"{label}: 結果未確認の注文をMT5の保有・約定と照合中（新規・追加は停止）")
                if agent._last_status == "blocked" and not state.get("quarantine"):
                    reasons.append(f"{label}: 一時停止（{agent._last_reason}）")
        return reasons[:50]

    def managed_positions(self) -> list[dict]:
        if self.strategies is None or not self.adapter.connected:
            return []
        try:
            live = {str(field_value(p, "ticket", "")): p for p in self.adapter.positions()}
        except Exception:
            live = {}
        out = []
        for agent in self.strategies.agents:
            try:
                basket = agent.journal.load().get("basket")
            except Exception:
                continue
            if not isinstance(basket, Mapping) or basket.get("side") not in SIDE:
                continue
            for ticket, leg in (basket.get("legs") or {}).items():
                p = live.get(str(ticket))
                if p is None or int(field_value(p, "magic", -1)) != agent.magic:
                    continue
                opened = leg.get("opened_at") or basket.get("opened_at")
                if not opened:
                    continue
                sl, tp = float(field_value(p, "sl", 0) or 0), float(field_value(p, "tp", 0) or 0)
                pnl = field_value(p, "profit")
                out.append({"ticket": str(ticket), "rule": agent.rule_key, "pair": logical_to_pair(str(basket["symbol"])),
                            "side": SIDE[basket["side"]], "lots": float(field_value(p, "volume", 0) or 0),
                            "open_price": float(field_value(p, "price_open", 0) or 0), "sl": sl or None, "tp": tp or None,
                            "open_at": str(opened), "pnl_usd": float(pnl) if pnl is not None else None})
        return out

    def heartbeat(self) -> None:
        summary = {"account": "", "equity": None}
        if self.adapter.connected:
            try:
                summary = self.adapter.account_summary()
            except Exception:
                pass
        state = {"account": summary.get("account", ""), "equity": summary.get("equity"),
                 "positions": self.managed_positions(), "mt5_connected": bool(self.adapter.connected),
                 "stop_reasons": self.stop_reasons()}
        started = time.monotonic()
        code, body = self.client.heartbeat(state)
        if code == 200 and isinstance(body.get("permissions"), Mapping):
            self.gate.update(body["permissions"], started)
        elif code == 409:
            self.gate.invalidate("lease_held_by_another_terminal")
            LOG.warning("lease held by another terminal (%s): new entries paused, protection continues",
                        (body.get("lease") or {}).get("holder"))
        else:
            LOG.warning("heartbeat HTTP %s", code)

    # ---- loop ----------------------------------------------------------------------
    def _healthy(self) -> bool:
        if not self.adapter.connected:
            return False
        try:
            terminal = self.adapter.mt5.terminal_info()
            ok = terminal is not None and bool(field_value(terminal, "connected", False))
        except Exception:
            ok = False
        if not ok:
            LOG.warning("MT5 terminal disconnected; reconnecting")
            self.adapter.close()
            self._set_reason("mt5", "MT5がブローカーのサーバーへ接続されていません")
        return ok

    def cycle(self) -> None:
        connected = self._healthy() or self.ensure_connected()
        if connected:
            try:
                self.run_strategies()
            except Exception as exc:  # e.g. terminal died; agents themselves fail closed per strategy
                LOG.warning("strategy cycle error: %s", exc)
        now_m = time.monotonic()
        report_ok = True
        if now_m - self._last_hb >= self.HEARTBEAT_SEC:
            self._last_hb = now_m
            try:
                self.heartbeat()
            except Exception as exc:
                report_ok = False
                LOG.warning("heartbeat failed: %s", type(exc).__name__)
        if not report_ok or not connected:
            return
        try:
            if now_m - self._last_quotes >= self.QUOTES_SEC:
                self._last_quotes = now_m
                quotes = self.adapter.quotes()
                if quotes:
                    self.client.quotes(quotes)
            if self.strategies is not None:
                self.signals.flush(self.strategies)
            self.candles.step()
        except ConnectorError as exc:
            LOG.warning("%s", exc)
        except Exception as exc:
            LOG.warning("report failed: %s", type(exc).__name__)

    def run(self, *, once: bool = False, interval: float = 1.0, max_cycles: Optional[int] = None) -> None:
        cycles = 0
        while True:
            started = time.monotonic()
            try:
                self.cycle()
            except Exception:
                LOG.exception("cycle error")
            cycles += 1
            if once or (max_cycles is not None and cycles >= max_cycles):
                return
            time.sleep(max(0.2, interval - (time.monotonic() - started)))

    def run_once_report(self, *, max_candle_posts: int = 400) -> dict:
        """--once: one read-only cycle plus the full candle backfill. Never calls order_send."""
        assert not self.trade
        self._last_connect = -1e12
        self.cycle()
        posts = 0
        while self.adapter.connected and not self.candles.done and posts < max_candle_posts:
            n = self.candles.step(budget=8)
            posts += n
            if n == 0 and self.candles.done:
                break
        signals = sum(len(a._checks or []) for a in (self.strategies.agents if self.strategies else []))
        return {"mt5_connected": self.adapter.connected, "symbols": dict(self.adapter.symbols),
                "candle_posts": posts, "evaluated": signals, "stop_reasons": self.stop_reasons(),
                "lease": (self.gate.perms or {}).get("lease"), "enabled_rules": (self.gate.perms or {}).get("enabled_rules")}


def clear_stop(strategies: LifeOSStrategies, rule: str, adapter: MT5Adapter, clock: Callable[[], datetime] = utc_now) -> str:
    """Clear ONE rule's journal quarantine after verifying it against MT5 (user-invoked, local only).

    Refused unless: no order intent is unresolved, no pending order carries the rule's magic, and the MT5
    positions with that magic are exactly the journal's basket legs (same ticket, identifier and volume) —
    or there are none and no basket. The journal itself (risk ledger, events, intents) is never deleted."""
    agent = strategies.by_rule(rule)
    state = agent.journal.load()
    reason = state.get("quarantine")
    if not reason:
        return f"{RULE_LABEL[rule]}: 停止理由はありません"
    if agent._unresolved_intents(state):
        raise ConnectorError(f"{RULE_LABEL[rule]}: 結果未確認の注文が残っているため解除できません（MT5の約定履歴を確認してください）")
    if any(int(field_value(o, "magic", -1)) == agent.magic for o in agent._orders()):
        raise ConnectorError(f"{RULE_LABEL[rule]}: このルールの未約定注文がMT5に残っているため解除できません")
    own = {str(field_value(p, "ticket", "")): p for p in adapter.positions() if int(field_value(p, "magic", -1)) == agent.magic}
    legs = ((state.get("basket") or {}).get("legs") or {}) if isinstance(state.get("basket"), Mapping) else {}
    if set(own) != {str(t) for t in legs}:
        raise ConnectorError(f"{RULE_LABEL[rule]}: MT5の保有と台帳が一致しないため解除できません")
    for ticket, leg in legs.items():
        p = own[str(ticket)]
        if (str(field_value(p, "identifier", "")) != str(leg.get("identifier"))
                or abs(float(field_value(p, "volume", 0) or 0) - float(leg.get("volume", 0) or 0)) > 1e-8):
            raise ConnectorError(f"{RULE_LABEL[rule]}: MT5の保有と台帳が一致しないため解除できません")
    state["quarantine"] = None
    state.setdefault("cleared_stops", []).append({"reason": str(reason), "at": iso_utc(_now_utc(clock))})
    agent.journal.save(state)
    return f"{RULE_LABEL[rule]}: 停止理由「{reason}」を解除しました（台帳は保持）"
