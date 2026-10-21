# Ported from life-bot/tests/test_donchian_v6.py. Removed only: tests of the previous server (fx_signals stores/web/UI) and
# of its updater (update_connector), which do not exist in Life OS. Everything else is unchanged.
"""Synthetic broker and in-memory server only; never creates a real order."""
from copy import deepcopy
from datetime import datetime,timedelta,timezone
UTC=timezone.utc
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
import json,math,sqlite3,uuid
import pytest
from windows_mt5 import donchian_v6_engine as v6,donchian_engine as v4,rule_a_engine as a
from windows_mt5.donchian_v6_agent import DonchianV6Agent
from windows_mt5.auto_strategies import AutoStrategies
from windows_mt5.rule_a_agent import RuleAError
from tests.test_donchian import frames,AT,group,position_for
from tests.test_rule_a_agent import FakeMT5,NOW
from tests.test_rule_a_engine import candles


def vf(sign=1):
    f=frames(sign)
    # Both fixtures trend identically; daily history is anchored at UTC21/JST06.
    for r in f['D1']:
        r['open_time']-=timedelta(hours=3);r['close_time']-=timedelta(hours=3)
        for k in ('open','high','low','close'):r[k]-=.02*sign
    return f

@pytest.mark.parametrize('sign,side',[(1,'long'),(-1,'short')])
def test_pivot_uses_last_confirmed_session_and_strict_direction(sign,side):
    f=vf(sign);x=v6.evaluate_entry('EUR_USD',f,AT)
    assert x['state']=='ready',x['checks']
    assert x['direction']==side and x['strategy_id']==v6.RULE_ID
    d=f['D1'][-1];p=(d['high']+d['low']+d['close'])/3
    assert x['indicators']['pivot_r1']==pytest.approx(2*p-d['low'])
    assert x['indicators']['pivot_s1']==pytest.approx(2*p-d['high'])
    assert x['indicators']['pivot_day_close'].endswith('21:00:00Z')
    target=f['H4'][-1]['close']
    delta=target-(2*p-d['low'] if sign==1 else 2*p-d['high'])
    for r in f['D1']:
        for k in ('open','high','low','close'):r[k]+=delta
    x=v6.evaluate_entry('EUR_USD',f,AT)
    assert not next(c['passed'] for c in x['checks'] if c['label']=='Daily pivot R1/S1')
    assert x['signal'] is None


def test_daily_session_rollover_and_no_future_leak():
    h=candles(AT.replace(hour=21)-timedelta(days=105),105*24,3600)
    result=v6.build_frames(h,AT.replace(hour=21));assert result['D1'][-1]['close_time'].hour==21
    assert all(x['open_time'].hour==21 for x in result['D1'])
    before=v6.build_frames(h,AT.replace(hour=20,minute=59));assert before['D1'][-1]['close_time']==result['D1'][-2]['close_time']
    assert all(x['open_time'].hour%4==0 for x in result['H4'])
    f=vf();baseline=v6.evaluate_entry('EUR_USD',f,AT)
    f['D1'].append(dict(open_time=AT.replace(hour=21)-timedelta(days=1),close_time=AT.replace(hour=21),open=5,high=9,low=1,close=8))
    assert v6.evaluate_entry('EUR_USD',f,AT)==baseline
    with pytest.raises(ValueError):v6.evaluate_entry('EUR_USD',frames(),AT)

@pytest.mark.parametrize('side,sign',[('long',1),('short',-1)])
def test_trailing_60_30_and_full_stop_target(side,sign):
    t=v6.trailing_level(side,150,150+sign*.6,'USD_JPY')
    assert t['active'] and t['level']==pytest.approx(150+sign*.3)
    assert v4.trailing_level(side,150,150+sign*.6,'USD_JPY')['level']==pytest.approx(150+sign*.1)
    sig={'symbol':'USD_JPY','direction':side,'raw_stop':150-sign*.5}
    plan=v6.plan_entry(sig,150)
    assert plan['risk_distance']==pytest.approx(.5)
    assert sign*(plan['target']-150)==pytest.approx(1.548)
    assert v6.execution_settings(.99,7)==v6.execution_settings()
    assert v6.execution_settings()['risk_usd']==60

class CashMT5(FakeMT5):
    def order_calc_profit(self,kind,symbol,volume,op,cl):
        # Broker converts JPY to actual USD account currency.
        return (cl-op)*(1 if kind==0 else -1)*volume*100000/(150 if symbol.endswith('JPY') else 1)

def agents(tmp_path, mt5=None):
    base,_=group(tmp_path);cfg=base.agents[0].config
    cfg.enable_donchian_v6=True;cfg.donchian_v6_state_path=tmp_path/'v6.json'
    g=AutoStrategies(mt5 or CashMT5(),cfg,clock=lambda:NOW)
    for agent in g.agents:agent._risk_history_checked=True
    return g

@pytest.mark.parametrize('symbol,side,price,stop',[('EUR_USD','long',1.1,1.095),('EUR_USD','short',1.1,1.105),('USD_JPY','long',150,149.5),('USD_JPY','short',150,150.5)])
def test_cash_sizing_rounds_down_in_broker_currency(tmp_path,symbol,side,price,stop):
    g=agents(tmp_path);r=g.agents[-1];q={'ask':price,'bid':price};v=r._initial_volume(symbol,side,q,{'stop':stop})
    risk=r._planned_loss(symbol,side,v,price,stop)
    assert 0<risk<=60.+1e-8
    assert r._planned_loss(symbol,side,v+.01,price,stop)>60
    assert Decimal(str(v))%Decimal('.01')==0
    if symbol=='EUR_USD':assert v==.11
    else:assert v==.17
    assert g.version==2

@pytest.mark.parametrize('step,minimum',[('.1',.1),('.025',.025),('.001',.001)])
def test_size_obeys_broker_step_and_research_centilot(tmp_path,step,minimum):
    m=CashMT5();old=m.symbol_info
    def info(s):
        r=old(s);r.volume_step=float(step);r.volume_min=minimum;return r
    m.symbol_info=info;r=agents(tmp_path,m).agents[-1]
    v=r._initial_volume('EUR_USD','long',{'ask':1.1,'bid':1.1},{'stop':1.095})
    assert Decimal(str(v))%Decimal(step)==0
    assert Decimal(str(v))%Decimal('.01')==0


def test_rejects_minimum_risk_unknown_conversion_wrong_account_and_final_quote(tmp_path):
    m=CashMT5();r=agents(tmp_path,m).agents[-1]
    with pytest.raises(RuleAError,match='minimum lot'):r._initial_volume('EUR_USD','long',{'ask':1.1,'bid':1.1},{'stop':1.0})
    v=r._initial_volume('EUR_USD','long',{'ask':1.1,'bid':1.1},{'stop':1.095})
    with pytest.raises(RuleAError,match='final quote'):r._validate_request_risk('EUR_USD','long',dict(volume=v,price=1.101,sl=1.095))
    m.order_calc_profit=lambda *args:None
    with pytest.raises(RuleAError,match='conversion'):r._initial_volume('EUR_USD','long',{'ask':1.1,'bid':1.1},{'stop':1.095})
    old=m.account_info;m.account_info=lambda:SimpleNamespace(**(vars(old())|{'currency':'JPY'}))
    with pytest.raises(RuleAError):r._initial_volume('EUR_USD','long',{'ask':1.1,'bid':1.1},{'stop':1.095})
    assert m.sent==[]


def test_three_journals_allow_each_verified_peer_and_preserve_foreign_guard(tmp_path):
    g=agents(tmp_path);ra,dc,r=g.agents
    assert len({x.magic for x in g.agents})==3 and len({x.journal.path for x in g.agents})==3
    g.agents[0]._risk_history_checked=False;assert r._initial_blocked([])
    ra._risk_history_checked=True
    positions=[position_for(ra,'101'),position_for(dc,'102')]
    assert not r._initial_blocked(positions)
    positions.append(position_for(r,'103'));assert r._initial_blocked(positions)
    positions.pop();positions[0].magic=0;assert r._initial_blocked(positions)
    state=dc.journal.load();state['risk_ledger']=[{'at':NOW.isoformat(),'realized_r':-3}];dc.journal.save(state)
    assert not r._risk_status(r.journal.load(),NOW)['can_trade']
    old=[x.journal.load() for x in g.agents]
    recovered=agents(tmp_path)
    assert [x.journal.load() for x in recovered.agents]==old


def test_version_one_group_cannot_claim_version_two_without_v6(tmp_path):
    g,_=group(tmp_path);assert g.version==1










def test_mocked_three_fills_native_protection_cash_risk_restart_and_exit_isolation(tmp_path):
    from tests.test_rule_a_agent import BasketMT5,_m5_history
    from windows_mt5 import rule_a_agent as runner
    class ThreeMT5(BasketMT5):
        order_calc_profit=CashMT5.order_calc_profit
        def order_send(self,request):
            n=len(self.deals);tickets={p.ticket for p in self.positions}
            result=super().order_send(request)
            for p in self.positions:
                if p.ticket not in tickets:p.magic=request['magic'];p.type=request['type']
            for d in self.deals[n:]:d.magic=request['magic']
            return result
    m=ThreeMT5();g=agents(tmp_path,m)
    for r in g.agents:
        r._lease={'enabled':True,'account_ref':r.account_ref};r._lease_deadline_mono=runner.time.monotonic()+20
        hist=_m5_history(NOW,last_close=1.1)
        for row in hist:row['high']+=.001;row['low']-=.001
        r._rates['EUR_USD']={'H1':[],'M5':hist}
        q={'bid':1.1,'ask':1.1001,'time':NOW};levels=r.core.plan_entry({'direction':'long','symbol':'EUR_USD','raw_stop':1.095},q['ask'])
        volume=r._initial_volume('EUR_USD','long',q,levels)
        state=r.journal.load()
        outcome,_=r._send_deal(state,kind='initial',logical='EUR_USD',side='long',volume=volume,quote=q,levels=levels,now=NOW,
            strategy={'raw_stop':1.095,'stop_scale':r.core.RULE_CONFIG['stop_scale'],'atr14_h1':.002,'decision_close':1.1})
        assert outcome=='succeeded' and state['basket']['base_volume']==volume
        event=next(e for e in state['events'] if e['type']=='basket_open')
        assert event['volume']==volume and event['sl'] and event['tp']
        if r.core is v6:assert state['basket']['initial_risk_usd']<=60.+1e-8
    assert len(m.positions)==3
    r=g.agents[-1];state=r.journal.load();assert r._close_managed(state,state['basket'],m.positions,NOW,'test_exit')
    r._manage_basket(state,m.positions,NOW)
    assert state['basket'] is None and len(state['risk_ledger'])==1
    assert len(m.positions)==2 and all(p.magic!=r.magic for p in m.positions)
    restarted=AutoStrategies(m,g.agents[0].config,clock=lambda:NOW)
    assert all(x.journal.load()['basket'] for x in restarted.agents[:2])
    assert restarted.agents[-1].journal.load()['basket'] is None


def test_final_fresh_price_increase_rejected_before_any_order_or_intent(tmp_path):
    from tests.test_rule_a_agent import _m5_history
    from windows_mt5 import rule_a_agent as runner
    m=CashMT5();r=agents(tmp_path,m).agents[-1]
    r._lease={'enabled':True,'account_ref':r.account_ref};r._lease_deadline_mono=runner.time.monotonic()+20
    history=_m5_history(NOW,last_close=1.1)
    for h in history:h['high']+=.001;h['low']-=.001
    r._rates['EUR_USD']={'H1':[],'M5':history}
    # Start exactly at budget, then move less than 2 pips to exercise the final risk check.
    price=1.1;v=.1;stop=price-(60/(v*100000)-.00012)
    q={'bid':price-.0001,'ask':price,'time':NOW};m.tick.bid=price;m.tick.ask=price+.0001
    state=r.journal.load()
    with pytest.raises(RuleAError,match='final quote'):
        r._send_deal(state,kind='initial',logical='EUR_USD',side='long',volume=v,quote=q,
          levels={'stop':stop,'target':1.12},now=NOW,strategy={'atr14_h1':.002,'decision_close':price})
    assert m.sent==[] and not state['intents']


def test_v6_only_local_flag_still_loads_all_peer_risk_journals(tmp_path):
    g=agents(tmp_path);cfg=g.agents[0].config
    cfg.enable_rule_a=False;cfg.enable_donchian=False
    restored=AutoStrategies(CashMT5(),cfg,clock=lambda:NOW)
    assert len(restored.agents)==3 and restored.version==2
    assert [r.enabled_local for r in restored.agents]==[False,False,True]


