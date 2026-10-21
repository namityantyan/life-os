# Ported from life-bot/tests/test_rule_a_agent.py. Removed only: tests of the previous server (fx_signals stores/web/UI) and
# of its updater (update_connector), which do not exist in Life OS. Everything else is unchanged.
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from windows_mt5 import rule_a_agent as runner
from windows_mt5 import rule_a_engine as core


UTC = timezone.utc
NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)


class FakeMT5:
    ACCOUNT_MARGIN_MODE_RETAIL_HEDGING = 2
    TIMEFRAME_H1 = 60
    TIMEFRAME_M5 = 5
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_DONE_PARTIAL = 10010
    SYMBOL_FILLING_FOK = 1
    SYMBOL_FILLING_IOC = 2
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_SLTP = 6
    ORDER_TIME_GTC = 0
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_OUT_BY = 3
    DEAL_ENTRY_INOUT = 2
    TRADE_RETCODE_REQUOTE = 10004

    def __init__(self):
        self.sent = []
        self.positions = []
        self.orders = []
        self.check_retcode = 0
        self.tick = SimpleNamespace(time=int(NOW.timestamp()), time_msc=int(NOW.timestamp() * 1000),
                                    bid=1.1, ask=1.1001)

    def terminal_info(self):
        return SimpleNamespace(connected=True, trade_allowed=True, tradeapi_disabled=False)

    def account_info(self):
        return SimpleNamespace(server="Demo", login=12345, currency="USD", margin_mode=2,
                               trade_allowed=True, trade_expert=True, margin_free=10000)

    def positions_get(self):
        return list(self.positions)

    def orders_get(self):
        return list(self.orders)

    def order_send(self, request):
        self.sent.append(dict(request))
        return None

    def symbol_info_tick(self, _symbol):
        return self.tick

    def order_calc_profit(self, _kind, _symbol, volume, open_price, close_price):
        return (float(close_price) - float(open_price)) * float(volume) * 1000

    def order_calc_margin(self, *_args):
        return 100.0

    def order_check(self, _request):
        return SimpleNamespace(retcode=self.check_retcode)

    def symbol_info(self, _symbol):
        return SimpleNamespace(trade_mode=4, volume_min=0.01, volume_max=100.0,
                               volume_step=0.01, trade_stops_level=0, point=0.00001,
                               trade_tick_size=0.00001, digits=5, filling_mode=1)

    def history_deals_get(self, *_args):
        return []


def make_agent(tmp_path: Path, *, enabled=True):
    mt5 = FakeMT5()
    config = SimpleNamespace(expected_server="Demo", expected_login="12345",
                             enable_rule_a=enabled, time_basis="utc",
                             symbol_map={pair: pair for pair in core.PAIRS},
                             rule_a_state_path=tmp_path / "rule-a.json",
                             close_endpoint=None, close_token=None)
    return runner.RuleAAgent(mt5, config, clock=lambda: NOW), mt5


def ready_evaluation(as_of=NOW - timedelta(seconds=1)):
    return {"symbol": "EUR_USD", "state": "ready", "direction": "long",
            "as_of": as_of.isoformat().replace("+00:00", "Z"), "trend": {}, "checks": [],
            "indicators": {},
            "signal": {"symbol": "EUR_USD", "direction": "long",
                       "as_of": as_of.isoformat().replace("+00:00", "Z"),
                       "raw_stop": 1.09, "atr14_h1": 0.01, "decision_close": 1.1}}


def test_expired_lease_blocks_initial_entry_without_order_send(tmp_path):
    agent, mt5 = make_agent(tmp_path)
    agent._rates = {"EUR_USD": {"H1": []}}
    state = agent.journal.load()
    with patch.object(agent, "_evaluation", return_value=ready_evaluation()):
        agent._entry_cycle(state, [], NOW)
    assert mt5.sent == []
    assert agent._last_reason == "local_disabled_or_lease_expired"


def test_manual_position_blocks_initial_entry_without_order_send(tmp_path):
    agent, mt5 = make_agent(tmp_path)
    agent._rates = {"EUR_USD": {"H1": []}}
    state = agent.journal.load()
    manual = SimpleNamespace(ticket=8, magic=0)
    with patch.object(agent, "_evaluation", return_value=ready_evaluation()):
        agent._entry_cycle(state, [manual], NOW)
    assert mt5.sent == []
    assert agent._last_reason == "account_position_blocks_initial_entry"


def test_future_or_stale_tick_is_rejected(tmp_path):
    agent, mt5 = make_agent(tmp_path)
    mt5.tick.time = int((NOW + timedelta(seconds=6)).timestamp())
    mt5.tick.time_msc = int((NOW + timedelta(seconds=6)).timestamp() * 1000)
    with pytest.raises(runner.RuleAError, match="stale or invalid"):
        agent._quotes("EUR_USD", NOW)
    mt5.tick.time = int((NOW - timedelta(seconds=20)).timestamp())
    mt5.tick.time_msc = int((NOW - timedelta(seconds=20)).timestamp() * 1000)
    with pytest.raises(runner.RuleAError, match="stale or invalid"):
        agent._quotes("EUR_USD", NOW)
    assert mt5.sent == []


def test_filling_mode_never_falls_back_to_return(tmp_path):
    agent, _ = make_agent(tmp_path)
    info = SimpleNamespace(filling_mode=0)
    with pytest.raises(runner.RuleAError, match="fill-or-kill"):
        agent._filling(info)


def test_partial_send_is_quarantined_and_never_retried(tmp_path):
    agent, mt5 = make_agent(tmp_path)
    agent._lease = {"enabled": True, "account_ref": agent.account_ref}
    agent._lease_deadline_mono = runner.time.monotonic() + 10
    mt5.order_send = lambda request: (mt5.sent.append(dict(request)) or
                                      SimpleNamespace(retcode=mt5.TRADE_RETCODE_DONE_PARTIAL,
                                                      volume=0.1, deal="123", order="456"))
    state = agent.journal.load()
    outcome, matches = agent._send_deal(
        state, kind="initial", logical="EUR_USD", side="long", volume=0.3,
        quote={"bid": 1.1, "ask": 1.1001, "time": NOW, "symbol": "EUR_USD"},
        levels={"stop": 1.09, "target": 1.2}, now=NOW,
        strategy={"raw_stop": 1.09, "stop_scale": 0.5})
    assert outcome == "unknown"
    assert matches == []
    assert len(mt5.sent) == 1
    assert state["quarantine"] == "fill_not_reconciled_to_position"


def test_failed_native_sltp_preflight_does_not_send_unprotected_request(tmp_path):
    agent, mt5 = make_agent(tmp_path)
    mt5.check_retcode = 10016
    position = SimpleNamespace(ticket=11, identifier=11, magic=runner.MAGIC,
                               volume=0.3, sl=1.09, tp=1.2)
    basket = {"id": "b1", "symbol": "EUR_USD", "side": "long",
              "legs": {"11": {} }}
    assert agent._modify_position(state=agent.journal.load(), basket=basket,
                                  position=position, levels={"stop": 1.095, "target": 1.21},
                                  now=NOW) is False
    assert mt5.sent == []


def test_local_close_targets_only_known_rule_a_ticket(tmp_path):
    mt5 = BasketMT5()
    config = SimpleNamespace(expected_server="Demo", expected_login="12345",
                             enable_rule_a=True, time_basis="utc",
                             symbol_map={pair: pair for pair in core.PAIRS},
                             rule_a_state_path=tmp_path / "managed-close.json",
                             close_endpoint=None, close_token=None)
    agent = runner.RuleAAgent(mt5, config, clock=lambda: NOW)
    own = SimpleNamespace(ticket=10, identifier=110, magic=runner.MAGIC,
                          symbol="EUR_USD", volume=0.3, price_open=1.1)
    manual = SimpleNamespace(ticket=20, identifier=120, magic=0,
                             symbol="EUR_USD", volume=0.1, price_open=1.1)
    mt5.positions = [own, manual]
    basket = {"id": "b1", "symbol": "EUR_USD", "side": "long",
              "legs": {"10": {"identifier": "110", "volume": 0.3}}}
    assert agent._close_managed(agent.journal.load(), basket, list(mt5.positions), NOW,
                                "time_exit") is True
    assert [request["position"] for request in mt5.sent] == [10]
    assert mt5.positions == [manual]


def test_succeeded_but_unapplied_initial_intent_is_reconciled(tmp_path):
    agent, _ = make_agent(tmp_path)
    position = SimpleNamespace(ticket=11, identifier=11, magic=runner.MAGIC,
                               symbol="EUR_USD", volume=0.3, price_open=1.1)
    state = agent.journal.load()
    state["intents"]["i1"] = {"intent_id": "i1", "kind": "initial", "status": "succeeded",
                              "applied": False, "created_at": NOW.isoformat(), "comment": "ra-i1",
                              "symbol": "EUR_USD", "side": "long", "volume": 0.3,
                              "strategy": {"raw_stop": 1.09}}
    with patch.object(agent, "_intent_deals", return_value=[]), \
            patch.object(agent, "_intent_positions", return_value=[position]), \
            patch.object(agent, "_apply_filled_intent") as apply:
        agent._reconcile(state, [position], NOW)
    apply.assert_called_once()


def test_fast_broker_stop_before_position_snapshot_reconstructs_settlement(tmp_path):
    agent, mt5 = make_agent(tmp_path)
    opened, closed = NOW - timedelta(hours=1), NOW - timedelta(minutes=59)
    entry = SimpleNamespace(position_id=77, magic=runner.MAGIC, comment="ra-fast",
                            entry=FakeMT5.DEAL_ENTRY_IN, volume=0.3, price=1.1,
                            profit=0.0, commission=-1.0, swap=0.0, fee=0.0,
                            time=opened.timestamp())
    exit_deal = SimpleNamespace(position_id=77, magic=0, comment="broker-sl",
                                entry=FakeMT5.DEAL_ENTRY_OUT, volume=0.3, price=1.095,
                                profit=-1.5, commission=-1.0, swap=0.0, fee=0.0,
                                time=closed.timestamp())
    intent = {"intent_id": "fast", "kind": "initial", "status": "succeeded", "applied": False,
              "created_at": opened.isoformat(), "comment": "ra-fast", "symbol": "EUR_USD",
              "side": "long", "volume": 0.3, "request": {"sl": 1.095, "tp": 1.2},
              "strategy": {"raw_stop": 1.09, "stop_scale": 0.5}}
    state = agent.journal.load()
    state["intents"]["fast"] = intent
    with patch.object(agent, "_intent_deals", return_value=[entry]), \
            patch.object(agent, "_deal_rows", return_value=[entry, exit_deal]):
        agent._reconcile(state, [], NOW)
        assert state["basket"] is not None
        agent._manage_basket(state, [], NOW)
    assert state["basket"] is None
    assert len(state["risk_ledger"]) == 1
    event = next(e for e in state["events"] if e["type"] == "basket_closed")
    assert datetime.fromisoformat(event["at"].replace("Z", "+00:00")) == closed
    assert event["price"] == 1.095


def test_partial_initial_uses_actual_filled_volume_for_cash_r(tmp_path):
    agent, mt5 = make_agent(tmp_path)
    position = SimpleNamespace(ticket=11, identifier=11, magic=runner.MAGIC,
                               symbol="EUR_USD", volume=0.1, price_open=1.1,
                               time=NOW.timestamp(), sl=1.095, tp=1.2, comment="ra-i1")
    intent = {"intent_id": "i1", "kind": "initial", "status": "partial", "created_at": NOW.isoformat(),
              "comment": "ra-i1", "symbol": "EUR_USD", "side": "long", "volume": 0.3,
              "strategy": {"raw_stop": 1.09, "stop_scale": 0.5},
              "request": {"sl": 1.095}}
    state = agent.journal.load()
    agent._adopt_intent_exposure(state, intent, [position], NOW)
    assert state["basket"]["initial_risk_usd"] > 0
    assert state["basket"]["legs"]["11"]["volume"] == 0.1
    assert state["basket"]["initial_risk_usd"] == pytest.approx(0.1 * (0.005 + 0.00012) * 1000)
    assert mt5.sent == []


def test_public_basket_includes_add_count_and_volume():
    result = runner._public_basket({"id": "b1", "adds": 2,
                                    "legs": {"1": {"volume": 0.3}, "2": {"volume": 0.3}}})
    assert result["add_count"] == 2
    assert result["total_volume"] == pytest.approx(0.6)
    assert result["volume"] == pytest.approx(0.6)




def test_close_uses_identifier_deals_and_commits_event_and_risk_once(tmp_path):
    agent, _ = make_agent(tmp_path)
    opened = NOW - timedelta(hours=1)
    closed = NOW - timedelta(seconds=30)
    deals = [
        SimpleNamespace(position_id=77, magic=runner.MAGIC, entry=FakeMT5.DEAL_ENTRY_IN,
                         volume=0.3, profit=0.0, commission=-1.0, swap=0.0, fee=0.0,
                         time=opened.timestamp(), price=1.1),
        # A manual/broker-side close still belongs to this known position id.
        SimpleNamespace(position_id=77, magic=0, entry=FakeMT5.DEAL_ENTRY_OUT,
                         volume=0.3, profit=-50.0, commission=-1.0, swap=0.0, fee=0.0,
                         time=closed.timestamp(), price=1.09),
    ]
    basket = {"id": "b1", "symbol": "EUR_USD", "side": "long",
              "opened_at": opened.isoformat(), "initial_risk_usd": 100.0,
              "legs": {"11": {"identifier": "77", "volume": 0.3}}}
    state = agent.journal.load()
    state["basket"] = basket
    with patch.object(agent, "_deal_rows", return_value=deals):
        assert agent._finalize_basket(state, basket, NOW) is True
        assert agent._finalize_basket(state, basket, NOW) is True
    assert state["basket"] is None
    assert len([e for e in state["events"] if e["type"] == "basket_closed"]) == 1
    assert len(state["risk_ledger"]) == 1
    assert state["risk_ledger"][0]["realized_r"] == pytest.approx(-0.52)
    assert datetime.fromisoformat(state["risk_ledger"][0]["time"].replace("Z", "+00:00")) == closed
    assert next(e for e in state["events"] if e["type"] == "basket_closed")["price"] == 1.09


class BasketMT5(FakeMT5):
    def __init__(self):
        super().__init__()
        self.deals = []
        self.next_ticket = 100

    def history_deals_get(self, *_args):
        return list(self.deals)

    def order_send(self, request):
        self.sent.append(dict(request))
        if request["action"] == self.TRADE_ACTION_SLTP:
            position = next(p for p in self.positions if p.ticket == request["position"])
            position.sl, position.tp = request["sl"], request["tp"]
            return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE)
        if request.get("position"):
            position = next(p for p in self.positions if p.ticket == request["position"])
            self.positions.remove(position)
            self.deals.append(SimpleNamespace(
                position_id=position.identifier, ticket=self.next_ticket, magic=runner.MAGIC,
                comment=request["comment"], entry=self.DEAL_ENTRY_OUT,
                volume=request["volume"], price=request["price"],
                profit=(request["price"] - position.price_open) * request["volume"] * 1000,
                commission=-1.0, swap=0.0, fee=0.0, time=self.tick.time))
            self.next_ticket += 1
            return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE, volume=request["volume"],
                                   deal=str(self.next_ticket), order=str(self.next_ticket))
        self.next_ticket += 1
        ticket = self.next_ticket
        identifier = ticket + 1000
        is_buy = request["type"] == self.ORDER_TYPE_BUY
        position = SimpleNamespace(ticket=ticket, identifier=identifier, magic=runner.MAGIC,
                                   symbol=request["symbol"], volume=request["volume"],
                                   price_open=request["price"], time=self.tick.time,
                                   sl=request["sl"], tp=request["tp"], comment=request["comment"])
        self.positions.append(position)
        self.deals.append(SimpleNamespace(
            position_id=identifier, ticket=ticket, magic=runner.MAGIC,
            comment=request["comment"], entry=self.DEAL_ENTRY_IN,
            volume=request["volume"], price=request["price"], profit=0.0,
            commission=-1.0, swap=0.0, fee=0.0, time=self.tick.time))
        return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE, volume=request["volume"],
                               deal=str(ticket), order=str(ticket))


def _m5_history(now, last_close=1.098):
    rows = []
    for index in range(20):
        close_time = now - timedelta(minutes=5 * (19 - index))
        close = 1.1 if index < 19 else last_close
        rows.append({"open_time": close_time - timedelta(minutes=5),
                     "close_time": close_time, "open": close, "high": close + 0.0002,
                     "low": close - 0.0002, "close": close})
    return rows


def test_mocked_basket_fills_three_adds_and_closes_at_deadline(tmp_path):
    mt5 = BasketMT5()
    config = SimpleNamespace(expected_server="Demo", expected_login="12345",
                             enable_rule_a=True, time_basis="utc",
                             symbol_map={pair: pair for pair in core.PAIRS},
                             rule_a_state_path=tmp_path / "basket.json",
                             close_endpoint=None, close_token=None)
    agent = runner.RuleAAgent(mt5, config, clock=lambda: NOW)
    agent._lease = {"enabled": True, "account_ref": agent.account_ref}
    agent._lease_deadline_mono = runner.time.monotonic() + 3600
    agent._rates = {"EUR_USD": {"H1": [], "M5": _m5_history(NOW)}}
    state = agent.journal.load()
    quote = {"bid": 1.1, "ask": 1.1001, "time": NOW, "symbol": "EUR_USD"}
    outcome, _ = agent._send_deal(state, kind="initial", logical="EUR_USD", side="long",
                                  volume=0.3, quote=quote,
                                  levels={"stop": 1.09, "target": 1.2}, now=NOW,
                                  strategy={"raw_stop": 1.09, "stop_scale": 0.5})
    assert outcome == "succeeded"
    assert state["basket"]["adds"] == 0

    for addition in range(1, 4):
        now = NOW + timedelta(minutes=5 * addition)
        agent.clock = lambda now=now: now
        mt5.tick.time = int(now.timestamp())
        mt5.tick.time_msc = int(now.timestamp() * 1000)
        agent._rates["EUR_USD"]["M5"] = _m5_history(now)
        agent._add_cycle(state, now)
        assert state["basket"]["adds"] == addition
    assert sum(p.volume for p in mt5.positions) == pytest.approx(1.2)

    deadline = datetime.fromisoformat(state["basket"]["deadline"].replace("Z", "+00:00"))
    agent.clock = lambda: deadline
    mt5.tick.time = int(deadline.timestamp())
    mt5.tick.time_msc = int(deadline.timestamp() * 1000)
    agent._manage_basket(state, list(mt5.positions), deadline)
    agent._manage_basket(state, list(mt5.positions), deadline)
    assert state["basket"] is None
    assert len(state["risk_ledger"]) == 1
    assert len([e for e in state["events"] if e["type"] == "add_filled"]) == 3
    assert len([e for e in state["events"] if e["type"] == "basket_closed"]) == 1
    assert mt5.positions == []


def test_close_retries_definite_requote_after_cooldown_but_not_unknown(tmp_path):
    mt5 = BasketMT5()
    config = SimpleNamespace(expected_server="Demo", expected_login="12345",
                             enable_rule_a=True, time_basis="utc",
                             symbol_map={pair: pair for pair in core.PAIRS},
                             rule_a_state_path=tmp_path / "close-retry.json",
                             close_endpoint=None, close_token=None)
    agent = runner.RuleAAgent(mt5, config, clock=lambda: NOW)
    own = SimpleNamespace(ticket=10, identifier=110, magic=runner.MAGIC,
                          symbol="EUR_USD", volume=0.3, price_open=1.1)
    mt5.positions = [own]
    basket = {"id": "b1", "symbol": "EUR_USD", "side": "long",
              "legs": {"10": {"identifier": "110", "volume": 0.3}}}
    state = agent.journal.load()
    original_send = mt5.order_send
    calls = 0

    def send_with_one_requote(request):
        nonlocal calls
        if not request.get("position"):
            return original_send(request)
        calls += 1
        if calls == 1:
            mt5.sent.append(dict(request))
            return SimpleNamespace(retcode=mt5.TRADE_RETCODE_REQUOTE, volume=0.0, order="r1")
        return original_send(request)

    mt5.order_send = send_with_one_requote
    assert agent._close_managed(state, basket, list(mt5.positions), NOW, "time_exit") is False
    assert calls == 1
    assert next(iter(state["intents"].values()))["status"] == "failed"
    assert agent._close_managed(state, basket, list(mt5.positions), NOW + timedelta(seconds=4),
                                "time_exit") is False
    assert calls == 1
    retry_time = NOW + timedelta(seconds=5)
    agent.clock = lambda: retry_time
    mt5.tick.time = int(retry_time.timestamp())
    mt5.tick.time_msc = int(retry_time.timestamp() * 1000)
    assert agent._close_managed(state, basket, list(mt5.positions), retry_time, "time_exit") is True
    assert calls == 2
    assert mt5.positions == []
    assert state["quarantine"] is None

    # An uncertain result remains one-shot even after the same cooldown.
    own2 = SimpleNamespace(ticket=11, identifier=111, magic=runner.MAGIC,
                           symbol="EUR_USD", volume=0.3, price_open=1.1)
    mt5.positions = [own2]
    basket2 = {"id": "b2", "symbol": "EUR_USD", "side": "long",
               "legs": {"11": {"identifier": "111", "volume": 0.3}}}
    retry_time2 = retry_time + timedelta(seconds=5)
    agent.clock = lambda: retry_time2
    mt5.tick.time = int(retry_time2.timestamp())
    mt5.tick.time_msc = int(retry_time2.timestamp() * 1000)
    before = len(mt5.sent)
    mt5.order_send = lambda request: (mt5.sent.append(dict(request)) or None)
    assert agent._close_managed(state, basket2, list(mt5.positions), retry_time2, "time_exit") is False
    assert len(mt5.sent) == before + 1
    later = retry_time2 + timedelta(seconds=10)
    agent.clock = lambda: later
    mt5.tick.time = int(later.timestamp())
    mt5.tick.time_msc = int(later.timestamp() * 1000)
    assert agent._close_managed(state, basket2, list(mt5.positions), later, "time_exit") is False
    assert len(mt5.sent) == before + 1


def test_lease_identity_is_unique_even_for_copied_journal(tmp_path):
    first, _ = make_agent(tmp_path)
    state = first.journal.load()
    first.journal.save(state)
    second, _ = make_agent(tmp_path)
    assert first.instance_id != second.instance_id
    assert first.journal.load()["instance_id"] == second.journal.load()["instance_id"]
    captured = []
    first.sync_client = SimpleNamespace(post=lambda payload: captured.append(payload) or {})
    first._sync(state, NOW, force=True)
    assert captured[0]["instance_id"] == first.instance_id
    assert captured[0]["instance_id"] != state["instance_id"]
