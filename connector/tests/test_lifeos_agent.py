"""Life OS orchestration tests: FakeMT5 (synthetic broker) + FakeServer (validating fake of the Life OS API).
No real broker or network is involved."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import rule_a_engine as core
from fake_mt5 import FakeMT5
from lifeos_agent import Orchestrator, PermissionGate, clear_stop, signal_payload, trade_payloads
from mt5_adapter import MT5Adapter, MT5Settings
from mt5_common import ConnectorError, iso_utc
from tests.lifeos_fakes import FakeServer, check_heartbeat, check_signal, check_trade

UTC = timezone.utc
NOW = datetime(2026, 10, 20, 12, 0, 10, tzinfo=UTC)  # Tuesday, 10 s after the 12:00 H1/H4 close
MAGIC = {"rule_a": 26061801, "donchian4": 26101804, "donchian6": 26101906}


class Clock:
    def __init__(self, t: datetime):
        self.t = t

    def __call__(self) -> datetime:
        return self.t

    def advance(self, **kw) -> None:
        self.t += timedelta(**kw)


def _watching(pair, now):
    stamp = iso_utc(now.replace(minute=0, second=0, microsecond=0)).replace(".000Z", "Z")
    return {"symbol": pair, "state": "watching", "direction": "neutral", "as_of": stamp, "trend": {}, "checks": [], "indicators": {}, "signal": None}


def harness(tmp_path, *, enabled=(), spread=0.8, mt5=None, server=None, clock=None, real_engines=False, **server_kw):
    clock = clock or Clock(NOW)
    mt5 = mt5 or FakeMT5(clock, spread_pips=spread)
    server = server or FakeServer(clock, enabled=enabled, **server_kw)
    cfg = SimpleNamespace(state_dir=tmp_path / "state", terminal_id="win-test")
    adapter = MT5Adapter(MT5Settings(time_basis="utc"), mt5_module=mt5, clock=clock)
    orch = Orchestrator(cfg, server, adapter, trade=True, clock=clock)
    orch.HEARTBEAT_SEC = 0
    orch.QUOTES_SEC = 0
    orch.candles.step = lambda budget=4: 0  # candle sharing has its own test
    assert orch.ensure_connected()
    first = orch.strategies.agents[0]
    for logical in core.PAIRS:
        first._market_pair(logical, clock())
    if not real_engines:  # engine maths is covered by the ported engine tests; keep these tests fast
        for agent in orch.strategies.agents:
            agent._evaluation = _watching
    return SimpleNamespace(clock=clock, mt5=mt5, server=server, orch=orch, adapter=adapter)


def entries(mt5):
    return [r for r in mt5.sent if r["action"] == mt5.TRADE_ACTION_DEAL and not r.get("position")]


def closes(mt5):
    return [r for r in mt5.sent if r["action"] == mt5.TRADE_ACTION_DEAL and r.get("position")]


def force_signal(h, rule, logical="EUR_USD", *, side="long", age=5.0, stop_pips=40.0):
    """Make `rule`'s engine report a ready signal for `logical` whose decision bar closed `age` seconds ago."""
    agent = h.orch.strategies.by_rule(rule)
    as_of = h.clock() - timedelta(seconds=age)
    bid, ask = h.mt5.bid_ask(logical)
    pip = 0.01 if logical.endswith("_JPY") else 0.0001
    fill = ask if side == "long" else bid
    raw_stop = fill - stop_pips * pip if side == "long" else fill + stop_pips * pip
    stamp = iso_utc(as_of).replace(".000Z", "Z")
    ready = {"symbol": logical, "state": "ready", "direction": side, "as_of": stamp, "trend": {},
             "checks": [{"label": "forced", "passed": True, "detail": "test"}], "indicators": {"atr14_h1": 20 * pip},
             "signal": {"id": f"{rule}:{logical}:{stamp}", "symbol": logical, "direction": side, "as_of": stamp,
                        "raw_stop": raw_stop, "atr14_h1": 20 * pip, "decision_close": fill}}

    def fake(pair, now):
        if pair == logical:
            return ready
        return {"symbol": pair, "state": "watching", "direction": "neutral", "as_of": stamp, "trend": {}, "checks": [], "indicators": {}, "signal": None}

    agent._evaluation = fake
    return ready


def jump(h, t):
    """Move the clock; the (every-5-s) heartbeat that would have run meanwhile renews the lease."""
    h.clock.t = t
    if not h.server.down:
        h.orch.heartbeat()


def cycles(h, n=2):
    for _ in range(n):
        h.orch.cycle()


def journal(h, rule):
    return h.orch.strategies.by_rule(rule).journal.load()


# ------------------------------------------------------------------ permission gating
def test_default_disabled_rule_never_orders_but_reports_entry_signal(tmp_path):
    h = harness(tmp_path)  # server default: every rule disabled
    force_signal(h, "rule_a")
    cycles(h, 3)
    assert entries(h.mt5) == []
    sig = [s for s in h.server.signals_rx if s["rule"] == "rule_a" and s["pair"] == "EUR/USD"]
    assert sig and sig[-1]["stage"] == "entry" and sig[-1]["side"] == "BUY"
    assert h.orch.gate.block_reason("rule_a", NOW) == "rule_disabled"
    assert h.orch.strategies.by_rule("rule_a").status()["lease_active"] is False


def test_enabled_rule_sends_exactly_one_order_for_one_closed_bar(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    force_signal(h, "rule_a")
    cycles(h, 4)
    sent = entries(h.mt5)
    assert len(sent) == 1
    req = sent[0]
    assert req["magic"] == MAGIC["rule_a"] and req["volume"] == pytest.approx(0.3) and req["type"] == h.mt5.ORDER_TYPE_BUY
    assert req["price"] == h.mt5.bid_ask("EUR_USD")[1]  # first live Ask
    assert req["sl"] < req["price"] < req["tp"]
    # Rule A: SL distance = 0.5 × distance to the origin (40 pips → 20 pips), TP = 3R + 4.8 pips
    assert req["price"] - req["sl"] == pytest.approx(0.0020, abs=2e-5)
    assert req["tp"] - req["price"] == pytest.approx(3 * 0.0020 + 0.00048, abs=3e-5)
    opened = [t for t in h.server.trades_rx if t["event"] == "open"]
    assert len(opened) == 1 and opened[0]["rule"] == "rule_a" and opened[0]["pair"] == "EUR/USD" and opened[0]["side"] == "BUY"
    pos = h.server.heartbeats[-1]["positions"]
    assert [p["ticket"] for p in pos] == [opened[0]["ticket"]] and pos[0]["rule"] == "rule_a"
    # the forced refresh right before order_send
    assert h.server.permission_calls >= 1


def test_late_signal_over_30_seconds_is_never_chased(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    force_signal(h, "rule_a", age=31)
    cycles(h, 3)
    assert entries(h.mt5) == []
    assert h.orch.strategies.by_rule("rule_a")._last_reason == "entry_signal_late_no_catchup"


def test_lease_held_by_another_terminal_blocks_new_entries(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    h.server.other_holder = True
    force_signal(h, "rule_a")
    cycles(h, 3)
    assert entries(h.mt5) == []
    assert h.orch.gate.block_reason("rule_a", NOW) is not None


def test_unreachable_server_stops_entries_but_protection_and_time_exit_continue(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    force_signal(h, "rule_a")
    cycles(h, 3)
    assert len(entries(h.mt5)) == 1
    # Server/network goes away; the cached permission runs out (30 s).
    h.server.down = True
    h.orch.gate.deadline_mono = 0.0
    h.clock.advance(hours=1)
    force_signal(h, "rule_a", logical="GBP_USD")
    cycles(h, 2)
    assert len(entries(h.mt5)) == 1
    assert h.orch.gate.block_reason("rule_a", h.clock()) in {"permissions_expired", "permissions_invalid"}
    # Deadline: next 05:00 JST = 20:00 UTC — the managed leg is still closed by the connector.
    deadline = datetime.fromisoformat(journal(h, "rule_a")["basket"]["deadline"].replace("Z", "+00:00"))
    assert deadline == datetime(2026, 10, 20, 20, 0, 10, tzinfo=UTC) or deadline.hour == 20
    h.clock.t = deadline + timedelta(seconds=1)
    cycles(h, 2)
    assert len(closes(h.mt5)) == 1 and h.mt5.positions == []
    assert journal(h, "rule_a")["basket"] is None


def test_year_config_expiry_and_trading_hours_block_new_entries(tmp_path):
    h = harness(tmp_path, enabled=["donchian4"], spread=0.3, year_valid=False)
    force_signal(h, "donchian4")
    cycles(h, 3)
    assert entries(h.mt5) == []
    gate = h.orch.gate
    h.server.year_valid = True
    gate.refresh(force=True)
    assert gate.block_reason("donchian4", NOW) is None
    assert gate.block_reason("donchian4", datetime(2027, 10, 1, tzinfo=UTC)) == "year_config_expired"
    assert gate.block_reason("rule_a", datetime(2026, 10, 24, 12, tzinfo=UTC)) is not None  # Saturday
    assert gate.block_reason("donchian4", datetime(2026, 10, 20, 20, 0, tzinfo=UTC)) == "outside_trading_hours"
    assert gate.block_reason("donchian4", datetime(2026, 10, 20, 5, 59, tzinfo=UTC)) == "outside_trading_hours"


def test_r_limit_stop_server_block_and_local_combined_ledgers(tmp_path):
    h = harness(tmp_path, enabled=["rule_a", "donchian6"], spread=0.3, blocked=True)
    force_signal(h, "rule_a")
    cycles(h, 3)
    assert entries(h.mt5) == []
    assert h.orch.gate.block_reason("rule_a", NOW) == "server_r_limit"
    # Server not blocking, but the three local ledgers together reached −2R today (UTC).
    h.server.blocked = False
    for rule, r in (("rule_a", -1.0), ("donchian4", -1.1)):
        agent = h.orch.strategies.by_rule(rule)
        state = agent.journal.load()
        state["risk_ledger"] = [{"time": iso_utc(NOW - timedelta(hours=2)), "realized_r": r, "basket_id": rule}]
        agent.journal.save(state)
    jump(h, h.clock() + timedelta(minutes=5))
    force_signal(h, "donchian6")
    cycles(h, 3)
    assert entries(h.mt5) == []
    assert h.orch.strategies.by_rule("donchian6")._risk_status(journal(h, "donchian6"), h.clock())["can_trade"] is False


# ------------------------------------------------------------------ unknown results / reporting retries
def test_unknown_order_result_is_never_resent_and_halts_the_rule(tmp_path):
    h = harness(tmp_path, enabled=["rule_a", "donchian4"], spread=0.3)
    h.mt5.send_mode = "none"
    force_signal(h, "rule_a")
    cycles(h, 3)
    assert len(entries(h.mt5)) == 1
    state = journal(h, "rule_a")
    assert [i["status"] for i in state["intents"].values()] == ["unknown"]
    assert h.orch.strategies.by_rule("rule_a")._unresolved_intents(state)
    # A new closed-bar signal an hour later: still no second order for A, and the peer is blocked too.
    h.mt5.send_mode = "fill"
    jump(h, h.clock() + timedelta(hours=1))
    force_signal(h, "rule_a", logical="GBP_USD")
    force_signal(h, "donchian4", logical="GBP_USD")
    cycles(h, 3)
    assert len(entries(h.mt5)) == 1
    reasons = h.server.heartbeats[-1]["stop_reasons"]
    assert any("ルールA改良版" in r and "結果未確認" in r for r in reasons), reasons
    assert [i["status"] for i in journal(h, "rule_a")["intents"].values()] == ["unknown"]  # still never resent


def test_lost_reply_is_reconciled_from_mt5_positions_without_resend(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    h.mt5.send_mode = "lost_reply"
    force_signal(h, "rule_a")
    cycles(h, 3)
    assert len(entries(h.mt5)) == 1 and len(h.mt5.positions) == 1
    state = journal(h, "rule_a")
    assert state["basket"] is not None and not state["quarantine"]
    assert [t["event"] for t in h.server.trades_rx] == ["open"]


def test_failed_trade_reports_are_retried_without_resending_orders(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    h.server.fail_trades = True
    force_signal(h, "rule_a")
    cycles(h, 4)
    assert len(entries(h.mt5)) == 1
    assert any(e["type"] == "basket_open" for e in journal(h, "rule_a")["events"])  # kept for retry
    h.server.fail_trades = False
    h.orch.trades.failed_until = 0
    cycles(h, 3)
    assert len(entries(h.mt5)) == 1
    assert [t["event"] for t in h.server.trades_rx] == ["open"]
    assert not any(e["type"] == "basket_open" for e in journal(h, "rule_a")["events"])


# ------------------------------------------------------------------ Rule A adds, lots
def _next_m5_close(clock):
    ts = int(clock().timestamp())
    return ts - ts % 300 + 300


def test_rule_a_adds_max_three_and_keep_the_basket_start_lot(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    force_signal(h, "rule_a", stop_pips=200)  # 100-pip basket SL so the adds stay above it
    cycles(h, 3)
    assert len(entries(h.mt5)) == 1
    h.server.common_lot = 0.5  # changed after the basket started: adds keep 0.30
    for k in range(1, 5):
        close = _next_m5_close(h.clock)
        h.mt5.shocks.append(("EUR_USD", close - 60, -0.0015))  # M5 closes 15 pips lower → ≥10 pips below SMA20
        jump(h, datetime.fromtimestamp(close + 3, UTC))
        cycles(h, 2)
        assert journal(h, "rule_a")["basket"]["adds"] == min(k, 3)
    sent = entries(h.mt5)
    assert len(sent) == 4 and all(r["volume"] == pytest.approx(0.3) for r in sent)
    assert sum(p.volume for p in h.mt5.positions) == pytest.approx(1.2)
    adds = [t for t in h.server.trades_rx if t["event"] == "add"]
    first = next(t for t in h.server.trades_rx if t["event"] == "open")
    assert len(adds) == 3 and all(t["group_ticket"] == first["ticket"] for t in adds)
    # all legs share the basket SL/TP recentred on the average price
    legs = h.mt5.positions
    assert len({round(p.sl, 5) for p in legs}) == 1 and len({round(p.tp, 5) for p in legs}) == 1


def test_new_common_lot_applies_to_the_next_new_entry(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"], common_lot=0.12)
    force_signal(h, "rule_a")
    cycles(h, 3)
    assert entries(h.mt5)[0]["volume"] == pytest.approx(0.12)


@pytest.mark.parametrize("risk,stop_pips,expected", [(60, 50, 0.11), (40, 50, 0.07), (100, 50, 0.11), (60, 700, None)])
def test_donchian6_sizes_to_planned_loss_within_60_usd(tmp_path, risk, stop_pips, expected):
    h = harness(tmp_path, enabled=["donchian6"], spread=0.3, risk_usd=risk)
    force_signal(h, "donchian6", stop_pips=stop_pips)
    cycles(h, 3)
    sent = entries(h.mt5)
    if expected is None:
        assert sent == []  # minimum lot would exceed the budget → no order
        assert "minimum lot" in h.orch.strategies.by_rule("donchian6")._last_reason
        return
    assert len(sent) == 1 and sent[0]["volume"] == pytest.approx(expected)
    assert sent[0]["magic"] == MAGIC["donchian6"]
    agent = h.orch.strategies.by_rule("donchian6")
    loss = agent._planned_loss("EUR_USD", "long", sent[0]["volume"], sent[0]["price"], sent[0]["sl"])
    assert loss <= min(60, risk) + 1e-8
    assert agent._planned_loss("EUR_USD", "long", sent[0]["volume"] + 0.01, sent[0]["price"], sent[0]["sl"]) > min(60, risk)


# ------------------------------------------------------------------ protection: time exits, trailing
def test_time_exit_closes_own_legs_and_reports_close_with_r(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    force_signal(h, "rule_a")
    cycles(h, 3)
    ticket = next(t for t in h.server.trades_rx if t["event"] == "open")["ticket"]
    h.server.enabled = []  # new entries switched off: protection must continue
    deadline = datetime.fromisoformat(journal(h, "rule_a")["basket"]["deadline"].replace("Z", "+00:00"))
    assert deadline == core.exit_deadline(NOW)
    h.clock.t = deadline + timedelta(seconds=2)
    cycles(h, 3)
    assert [r["position"] for r in closes(h.mt5)] == [int(ticket)]
    close = [t for t in h.server.trades_rx if t["event"] == "close"]
    assert len(close) == 1 and close[0]["ticket"] == ticket
    state = journal(h, "rule_a")
    assert state["basket"] is None and len(state["risk_ledger"]) == 1
    assert close[0]["r_multiple"] == pytest.approx(state["risk_ledger"][0]["realized_r"])
    assert close[0]["pnl_usd"] is not None


def test_donchian_trailing_moves_sl_and_reports_modify(tmp_path):
    h = harness(tmp_path, enabled=["donchian4"], spread=0.3)
    force_signal(h, "donchian4")
    cycles(h, 3)
    assert len(entries(h.mt5)) == 1
    pos = h.mt5.positions[0]
    entry, sl0 = pos.price_open, pos.sl
    h.mt5.shocks.append(("EUR_USD", h.clock().timestamp() + 1, +0.0070))  # +70 pips → trailing (60 → 50 pips)
    jump(h, h.clock() + timedelta(seconds=20))
    cycles(h, 2)
    pos = h.mt5.positions[0]
    bid = h.mt5.bid_ask("EUR_USD")[0]
    assert pos.sl > sl0 and pos.sl == pytest.approx(bid - 0.0050, abs=2e-5)
    assert any(r["action"] == h.mt5.TRADE_ACTION_SLTP for r in h.mt5.sent)
    mods = [t for t in h.server.trades_rx if t["event"] == "modify"]
    assert mods and mods[-1]["sl"] == pytest.approx(pos.sl)
    assert journal(h, "donchian4")["basket"]["trail_active"] is True
    assert entry < pos.sl


# ------------------------------------------------------------------ ownership, restart
def test_manual_and_untracked_positions_are_never_adopted_or_touched(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    manual = h.mt5.open_manual("EUR_USD", "long", 0.1)
    force_signal(h, "rule_a")
    cycles(h, 3)
    assert entries(h.mt5) == []  # previous connector behaviour: unverified exposure blocks new entries
    assert not any(r.get("position") == manual.ticket for r in h.mt5.sent)
    assert h.server.heartbeats[-1]["positions"] == []
    # A position carrying Rule A's magic but missing from the ledger is not adopted either.
    stray = h.mt5.open_manual("GBP_USD", "short", 0.1, magic=MAGIC["rule_a"])
    cycles(h, 2)
    assert journal(h, "rule_a")["quarantine"] == "untracked_rule_a_magic_position"
    assert not any(r.get("position") == stray.ticket for r in h.mt5.sent)
    assert manual in h.mt5.positions and stray in h.mt5.positions


def test_ledger_survives_restart_without_duplicate_order(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    force_signal(h, "rule_a")
    cycles(h, 3)
    assert len(entries(h.mt5)) == 1
    before = journal(h, "rule_a")
    # New process: same state/ folder, same terminal and broker.
    h2 = harness(tmp_path, mt5=h.mt5, server=h.server, clock=h.clock)
    force_signal(h2, "rule_a")  # the same closed bar is offered again
    cycles(h2, 3)
    assert len(entries(h.mt5)) == 1
    after = journal(h2, "rule_a")
    assert after["basket"]["id"] == before["basket"]["id"] and after["last_initial_bucket"] == before["last_initial_bucket"]
    assert [p["rule"] for p in h.server.heartbeats[-1]["positions"]] == ["rule_a"]
    assert sorted(p.name for p in (tmp_path / "state").glob("*.json")) == ["donchian-v6.json", "donchian.json", "rule-a.json"]
    assert not list((tmp_path / "state").glob("*.tmp"))


def test_clear_stop_requires_journal_to_match_mt5(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"])
    agent = h.orch.strategies.by_rule("rule_a")
    state = agent.journal.load()
    state["quarantine"] = "EUR_USD quote is stale or invalid"
    agent.journal.save(state)
    stray = h.mt5.open_manual("EUR_USD", "long", 0.1, magic=MAGIC["rule_a"])
    with pytest.raises(ConnectorError):
        clear_stop(h.orch.strategies, "rule_a", h.adapter)
    h.mt5.positions.remove(stray)
    msg = clear_stop(h.orch.strategies, "rule_a", h.adapter)
    state = agent.journal.load()
    assert "解除" in msg and state["quarantine"] is None and state["cleared_stops"][0]["reason"].startswith("EUR_USD")


# ------------------------------------------------------------------ read-only modes
def test_once_mode_is_read_only(tmp_path):
    clock = Clock(NOW)
    mt5 = FakeMT5(clock)
    server = FakeServer(clock, enabled=["rule_a", "donchian4", "donchian6"])
    cfg = SimpleNamespace(state_dir=tmp_path / "state", terminal_id="win-test")
    adapter = MT5Adapter(MT5Settings(time_basis="utc"), mt5_module=mt5, clock=clock, read_only=True)
    orch = Orchestrator(cfg, server, adapter, trade=False, clock=clock)
    report = orch.run_once_report(max_candle_posts=30)
    assert report["mt5_connected"] and report["evaluated"] == 21
    assert mt5.sent == [] and not (tmp_path / "state").exists()
    with pytest.raises(RuntimeError):
        adapter.mt5.order_send({"action": 1})
    assert server.quotes_rx and server.signals_rx and server.candles_rx and server.heartbeats


# ------------------------------------------------------------------ payloads, candles, symbols
def test_reported_payloads_match_shared_fx_ts(tmp_path):
    h = harness(tmp_path, enabled=["rule_a"], real_engines=True)
    del h.orch.candles.step  # real candle feeder this time
    force_signal(h, "rule_a")
    cycles(h, 9)
    for hb in h.server.heartbeats:
        check_heartbeat(hb)
    for s in h.server.signals_rx:
        check_signal(s)
    for t in h.server.trades_rx:
        check_trade(t)
    tfs = {(p, tf) for p, tf, _ in h.server.candles_rx}
    assert {tf for _, tf in tfs} == {"M5", "H1", "H4", "D1"}
    h1_total = sum(n for p, tf, n in h.server.candles_rx if tf == "H1" and p == "USD/JPY")
    assert h1_total >= 120 * 24  # long H1 history for D1 SMA90 on the chart
    assert {q["pair"] for q in h.server.quotes_rx} == {"USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/USD", "GBP/USD", "AUD/USD"}
    json.dumps(h.server.heartbeats)  # JSON-serialisable


def test_h4_candles_are_utc_aligned_and_built_only_from_complete_h1_groups(tmp_path):
    h = harness(tmp_path)
    bars = h.orch.candles._h4(h.adapter.rates("EUR_USD", "H1", 48))
    assert bars and all(b["t"] % 14400 == 0 for b in bars)
    assert bars[-1]["t"] + 14400 <= NOW.timestamp()


def test_trade_payload_mapping_for_every_journal_event():
    at = "2026-10-20T12:00:10.000Z"
    open_ev = {"type": "basket_open", "symbol": "USD_JPY", "side": "short", "price": 150.1, "sl": 150.5, "tp": 148.9, "at": at,
               "legs": [{"ticket": "11", "volume": 0.3, "price": 150.1}], "group_ticket": "11", "reason": "automatic_entry"}
    add_ev = {**open_ev, "type": "add_filled", "legs": [{"ticket": "12", "volume": 0.3, "price": 150.3}]}
    close_ev = {"type": "basket_closed", "symbol": "USD_JPY", "side": "short", "price": 150.5, "at": at, "group_ticket": "11",
                "legs": [{"ticket": "11", "volume": 0.3, "price": 150.5, "pnl_usd": -80.0, "r_multiple": -0.5, "at": at},
                         {"ticket": "12", "volume": 0.3, "price": 150.5, "pnl_usd": -40.0, "r_multiple": -0.25, "at": at}]}
    mod_ev = {"type": "sltp_modified", "symbol": "USD_JPY", "side": "short", "ticket": "11", "price": 150.1, "volume": 0.3, "sl": 150.0, "tp": 148.9, "at": at}
    o, = trade_payloads("rule_a", open_ev)
    a, = trade_payloads("rule_a", add_ev)
    c1, c2 = trade_payloads("rule_a", close_ev)
    m, = trade_payloads("rule_a", mod_ev)
    for t in (o, a, c1, c2, m):
        check_trade(t)
    assert (o["event"], o["side"], o["pair"], o["group_ticket"]) == ("open", "SELL", "USD/JPY", None)
    assert (a["event"], a["group_ticket"]) == ("add", "11")
    assert c1["r_multiple"] + c2["r_multiple"] == pytest.approx(-0.75)
    assert m["event"] == "modify" and m["sl"] == 150.0
    assert trade_payloads("rule_a", {"type": "protection_failure", "symbol": "USD_JPY", "side": "short"}) is None
    assert trade_payloads("rule_a", {"type": "basket_open", "symbol": "USD_JPY", "side": "short", "price": 1, "at": at}) == []


def test_signal_stage_mapping():
    base = {"symbol": "EUR_USD", "as_of": "2026-10-20T12:00:00Z", "indicators": {"adx14_h1": 27.0, "sma10_d1": None}}
    labels = ["D1 trend alignment", "H4 trend alignment", "H1 trend alignment", "H1 pullback to SMA16", "H1 close vs D1 SMA10", "D1/H4 freshness"]
    setup = {**base, "state": "watching", "direction": "long", "checks": [{"label": l, "passed": True} for l in labels] + [{"label": "H1 ADX14", "passed": False}]}
    p = signal_payload("rule_a", setup)
    check_signal(p)
    assert (p["stage"], p["side"], p["pair"]) == ("setup", "BUY", "EUR/USD")
    assert p["bar_time"] == "2026-10-20T11:00:00.000Z"  # server convention: the judgment bar's OPEN
    assert signal_payload("donchian4", {**setup, "checks": []})["bar_time"] == "2026-10-20T08:00:00.000Z"
    assert signal_payload("rule_a", {**setup, "state": "ready"})["stage"] == "entry"
    half = {**setup, "checks": setup["checks"][:3] + [{"label": "H1 pullback to SMA16", "passed": False}]}
    assert signal_payload("rule_a", half)["stage"] == "none"
    assert signal_payload("rule_a", {**setup, "direction": "neutral"})["stage"] == "none"


def test_broker_suffix_symbols_and_ambiguity(tmp_path):
    clock = Clock(NOW)
    mt5 = FakeMT5(clock, suffix="#")
    adapter = MT5Adapter(MT5Settings(time_basis="utc"), mt5_module=mt5, clock=clock)
    adapter.connect()
    assert adapter.symbols["USD_JPY"] == "USDJPY#" and len(adapter.symbols) == 7
    mt5.extra_symbols = [SimpleNamespace(name="USDJPY.pro", currency_base="USD", currency_profit="JPY", custom=False)]
    with pytest.raises(ConnectorError, match="SYMBOL_MAP"):
        MT5Adapter(MT5Settings(time_basis="utc"), mt5_module=mt5, clock=clock).connect()
    ok = MT5Adapter(MT5Settings(time_basis="utc", symbol_map={"USD_JPY": "USDJPY#"}), mt5_module=mt5, clock=clock)
    ok.connect()
    assert ok.symbols["USD_JPY"] == "USDJPY#"


def test_account_pin_mismatch_refuses_connection(tmp_path):
    clock = Clock(NOW)
    mt5 = FakeMT5(clock)
    with pytest.raises(ConnectorError, match="MT5_LOGIN"):
        MT5Adapter(MT5Settings(expected_login="999", expected_server="Other"), mt5_module=mt5, clock=clock).connect()
    pinned = MT5Adapter(MT5Settings(), mt5_module=mt5, clock=clock)
    pinned.connect()
    mt5.login = 87654321  # account switched inside MT5 → refused on reconnect
    with pytest.raises(ConnectorError):
        pinned.connect()


# ------------------------------------------------------------------ gate unit tests
class _Client:
    def __init__(self, perms):
        self.perms, self.calls = perms, 0

    def permissions(self):
        self.calls += 1
        return self.perms


def _perms(now, **over):
    p = {"enabled_rules": ["rule_a"], "common_lot": 0.3, "risk_usd_donchian6": 60,
         "trading_hours": {"start_utc": 6, "end_utc": 20, "weekdays_only": True},
         "r_limit_block": {"blocked": False}, "year_config_valid_until": "2027-10-01", "year_config_valid": True,
         "lease": {"holder": "w", "expires_at": iso_utc(now + timedelta(seconds=30)), "held_by_you": True},
         "server_time": iso_utc(now)}
    p.update(over)
    return p


def test_gate_expiry_skew_lot_and_refresh_backoff():
    t = [1000.0]
    clock = Clock(NOW)
    client = _Client(_perms(NOW))
    gate = PermissionGate(client, clock, monotonic=lambda: t[0])
    assert gate.block_reason("rule_a", NOW) == "permissions_not_received"
    assert gate.refresh() and gate.block_reason("rule_a", NOW) is None
    assert gate.refresh() and client.calls == 1          # cached for 5 s
    t[0] += 31
    assert gate.block_reason("rule_a", NOW) == "permissions_expired"
    # lease that expires in 10 s bounds the validity
    gate.update(_perms(NOW, lease={"holder": "w", "expires_at": iso_utc(NOW + timedelta(seconds=10)), "held_by_you": True}), t[0])
    t[0] += 11
    assert gate.block_reason("rule_a", NOW) == "permissions_expired"
    gate.update(_perms(NOW, server_time=iso_utc(NOW + timedelta(seconds=9))), t[0])
    assert gate.block_reason("rule_a", NOW) == "server_clock_skew"
    gate.update(_perms(NOW, common_lot=0.005), t[0])
    assert gate.block_reason("rule_a", NOW) == "common_lot_invalid"
    gate.update(_perms(NOW, enabled_rules=[]), t[0])
    assert gate.block_reason("rule_a", NOW) == "rule_disabled"
    gate.update(_perms(NOW, risk_usd_donchian6=500), t[0])
    assert gate.risk_usd_donchian6() == 60
