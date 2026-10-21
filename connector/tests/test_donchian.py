# Ported from life-bot/tests/test_donchian.py. Removed only: tests of the previous server (fx_signals stores/web/UI) and
# of its updater (update_connector), which do not exist in Life OS. Everything else is unchanged.
"""All broker/notification operations here are synthetic; no real order is sent."""
from copy import deepcopy
from datetime import datetime,timedelta,timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import json,sqlite3,uuid
import pytest
from windows_mt5 import donchian_engine as dc,rule_a_engine as a
from windows_mt5.donchian_agent import DonchianAgent,MAGIC
from windows_mt5.auto_strategies import AutoStrategies
from windows_mt5.rule_a_agent import RuleAJournal,RuleAError
from tests.test_rule_a_engine import candles
from tests.test_rule_a_agent import FakeMT5,NOW,ready_evaluation

UTC=timezone.utc
AT=datetime(2026,10,20,12,tzinfo=UTC)


def frames(sign=1):
    step=.0001*sign
    h1=candles(AT-timedelta(hours=100),100,3600,step=step)
    h4=candles(AT-timedelta(hours=400),100,14400,step=step)
    d1=candles(AT.replace(hour=0)-timedelta(days=100),100,86400,step=step)
    j=len(h1)-3;ma=sum(r['close'] for r in h1[j-15:j+1])/16
    h1[j]['low']=min(h1[j]['low'],ma);h1[j]['high']=max(h1[j]['high'],ma)
    return {'H1':h1,'H4':h4,'D1':d1}


@pytest.mark.parametrize('sign,side',[(1,'long'),(-1,'short')])
def test_closed_h4_breakout_and_original_full_size_stop(sign,side):
    f=frames(sign);r=dc.evaluate_entry('EUR_USD',f,AT)
    assert r['state']=='ready',[c for c in r['checks'] if not c['passed']]
    assert r['direction']==side and r['entry_timeframe']=='H4'
    assert set(r['trend'])=={'D1','H4'}
    assert r['trend']['D1']['sma10_15_bars_ago'] == pytest.approx(sum(x['close'] for x in f['D1'][-25:-15])/10)
    signal=r['signal'];fill=signal['decision_close']+.0001*sign
    levels=dc.plan_entry(signal,fill)
    risk=sign*(fill-signal['raw_stop'])
    assert levels['risk_distance']==pytest.approx(risk)
    assert levels['stop']==pytest.approx(signal['raw_stop'])
    assert sign*(levels['target']-fill)==pytest.approx(3*risk+.00048)
    assert dc.execution_settings(.2)['max_adds']==0


@pytest.mark.parametrize('which',['H1','H4','D1'])
def test_future_bars_and_already_closed_lower_frames_after_decision_do_not_leak(which):
    f=frames();baseline=dc.evaluate_entry('EUR_USD',f,AT)
    width={'H1':3600,'H4':14400,'D1':86400}[which]
    later=AT+timedelta(seconds=width)
    if which=='D1':later=(AT+timedelta(days=1)).replace(hour=0)
    # Unfinished current candles can contain arbitrary future highs and close.
    f[which].append({'open_time':later-timedelta(seconds=width),'close_time':later,
                     'open':2,'high':5,'low':.1,'close':4})
    assert dc.evaluate_entry('EUR_USD',f,AT)==baseline
    f=frames();f['H1'].extend(candles(AT,2,3600,base=8))
    late=dc.evaluate_entry('EUR_USD',f,AT+timedelta(hours=2))
    assert late['as_of']==baseline['as_of'] and late['signal']==baseline['signal']


@pytest.mark.parametrize('sign',[1,-1])
def test_exact_breakout_equality_does_not_trigger_and_prior24_is_exclusive(sign):
    f=frames(sign);level=max(x['high'] for x in f['H4'][-25:-1]) if sign==1 else min(x['low'] for x in f['H4'][-25:-1])
    f['H4'][-1]['close']=level
    f['H4'][-1]['high']=max(f['H4'][-1]['high'],level)
    f['H4'][-1]['low']=min(f['H4'][-1]['low'],level)
    assert dc.evaluate_entry('EUR_USD',f,AT)['signal'] is None


def test_only_current_h1_touch_is_not_prior_pullback_and_missing_hour_blocks():
    f=frames();f['H1']=candles(AT-timedelta(hours=100),100,3600)
    f['H1'][-1]['low']=1.0
    assert not next(c['passed'] for c in dc.evaluate_entry('EUR_USD',f,AT)['checks'] if c['label']=='H1 pullback to SMA16')
    f=frames();f['H1'].pop(-4)
    assert dc.evaluate_entry('EUR_USD',f,AT)['signal'] is None


def test_research_session_and_preset_expiry_fail_closed():
    f=frames();assert dc.evaluate_entry('EUR_USD',f,AT)['signal']
    delta=timedelta(hours=8);f={k:[{**r,'open_time':r['open_time']+delta,'close_time':r['close_time']+delta} for r in v] for k,v in f.items() if k!='D1'} | {'D1':frames()['D1']}
    assert dc.evaluate_entry('EUR_USD',f,AT+delta)['signal'] is None
    f=frames();shift=timedelta(days=350);f={k:[{**r,'open_time':r['open_time']+shift,'close_time':r['close_time']+shift} for r in v] for k,v in f.items()}
    assert dc.evaluate_entry('EUR_USD',f,AT+shift)['signal'] is None


@pytest.mark.parametrize('sign',[1,-1])
def test_trailing_60_activation_50_distance_ratchets_and_remembers_restart(sign):
    side='long' if sign==1 else 'short'
    x=dc.trailing_level(side,150,150+sign*.599,'USD_JPY');assert not x['active']
    x=dc.trailing_level(side,150,150+sign*.6,'USD_JPY',best=x['best']);assert x['active'] and x['level']==pytest.approx(150+sign*.1)
    y=dc.trailing_level(side,150,150+sign*1.0,'USD_JPY',best=x['best'],previous_level=x['level']);assert y['level']==pytest.approx(150+sign*.5)
    z=dc.trailing_level(side,150,150+sign*.3,'USD_JPY',best=y['best'],previous_level=y['level']);assert z['level']==y['level']


@pytest.mark.parametrize('entry,expected',[
 ('2026-10-20T12:00:00Z','2026-10-22T12:00:00+00:00'),
 ('2026-10-23T16:00:00Z','2026-10-23T20:00:00+00:00'),
 ('2026-10-22T16:00:00Z','2026-10-23T20:00:00+00:00')])
def test_48h_or_saturday0500_jst_not_daily(entry,expected):assert dc.exit_deadline(entry).isoformat()==expected


def group(tmp_path):
    cfg=SimpleNamespace(expected_server='Demo',expected_login='12345',time_basis='utc',symbol_map={p:p for p in a.PAIRS},
                        rule_a_state_path=tmp_path/'a.json',donchian_state_path=tmp_path/'dc.json',
                        enable_rule_a=True,enable_donchian=True,close_endpoint=None,close_token=None)
    mt5=FakeMT5();g=AutoStrategies(mt5,cfg,clock=lambda:NOW)
    for x in g.agents:x._risk_history_checked=True
    return g,mt5


def position_for(agent,ticket='101'):
    state=agent.journal.load();p=SimpleNamespace(ticket=int(ticket),identifier=int(ticket)+100,magic=agent.magic,type=0,symbol='EUR_USD',volume=.3,price_open=1.1,sl=1.09,tp=1.13,time=int(NOW.timestamp()))
    state['basket']={'id':'b'+ticket,'symbol':'EUR_USD','side':'long','base_volume':.3,'adds':0,
                      'legs':{ticket:{'identifier':str(p.identifier),'volume':.3,'entry_price':1.1}}}
    agent.journal.save(state);return p


def test_each_strategy_can_enter_while_other_known_one_is_open_but_no_second_own(tmp_path):
    g,mt5=group(tmp_path);ra,dcagent=g.agents
    p=position_for(ra);mt5.positions=[p]
    assert not dcagent._initial_blocked(mt5.positions)
    assert ra._initial_blocked(mt5.positions)
    q=position_for(dcagent,'102');mt5.positions.append(q)
    assert ra._foreign_positions(mt5.positions,ra.journal.load()) is False
    assert dcagent._foreign_positions(mt5.positions,dcagent.journal.load()) is False
    assert ra._initial_blocked(mt5.positions) and dcagent._initial_blocked(mt5.positions)
    assert ra.magic!=dcagent.magic and ra.journal.path!=dcagent.journal.path


@pytest.mark.parametrize('mutation',['magic','identifier','type','symbol','volume'])
def test_peer_magic_alone_cannot_adopt_unknown_manual_or_modified_position(tmp_path,mutation):
    g,mt5=group(tmp_path);p=position_for(g.agents[0]);setattr(p,mutation,'BAD' if mutation=='symbol' else 9)
    assert g.agents[1]._initial_blocked([p])
    assert not mt5.sent


def test_combined_realized_loss_stops_both_and_missing_peer_journal_blocks(tmp_path):
    g,_=group(tmp_path);ra,dd=g.agents
    for agent,loss in ((ra,-1.0),(dd,-1.1)):
        state=agent.journal.load();state['risk_ledger']=[{'time':NOW.isoformat(),'realized_r':loss,'basket_id':agent.core.RULE_ID}];agent.journal.save(state)
    for agent in g.agents:assert agent._risk_status(agent.journal.load(),NOW)['can_trade'] is False
    dd.journal.path.write_text('broken')
    assert not g.can_open(ra) and ra._risk_status(ra.journal.load(),NOW)['can_trade'] is False


def test_uncertain_peer_order_stops_new_orders_and_other_exits_still_run(tmp_path):
    g,_=group(tmp_path);ra,dd=g.agents;state=dd.journal.load();state['intents']={'x':{'status':'unknown'}};dd.journal.save(state)
    assert not g.can_open(ra)
    with patch.object(ra,'run_once',side_effect=ValueError()),patch.object(dd,'run_once',return_value={'managed':True}) as run:
        assert g.run_once()[-1]=={'managed':True};run.assert_called_once()


def test_journals_reject_another_strategy_even_for_same_account(tmp_path):
    g,_=group(tmp_path);ra,dd=g.agents;ra.journal.save(ra.journal.load())
    with pytest.raises(RuleAError):RuleAJournal(ra.journal.path,ra.account_ref,strategy_id=dc.RULE_ID).load()


def test_donchian_never_adds_and_short_trail_uses_ask_persists_best(tmp_path):
    g,mt5=group(tmp_path);dd=g.agents[1];state=dd.journal.load();dd._add_cycle(state,NOW);assert not mt5.sent
    b={'side':'short','symbol':'USD_JPY','average_price':150}
    x=dd._trailing(b,{'bid':149.3,'ask':149.5},NOW);assert not x['active']
    x=dd._trailing(b,{'bid':149.2,'ask':149.4},NOW);assert x['active'] and b['trail_best']==149.4
    x=dd._trailing(b,{'bid':149.8,'ask':150},NOW);assert x['level']==pytest.approx(149.9)
















def test_both_mocked_fills_averaging_only_A_and_exit_does_not_touch_peer(tmp_path):
    from tests.test_rule_a_agent import BasketMT5,_m5_history
    from windows_mt5 import rule_a_agent as run
    class BothMT5(BasketMT5):
        def order_send(self,request):
            prior=len(self.deals);tickets={p.ticket for p in self.positions}
            res=super().order_send(request)
            for p in self.positions:
                if p.ticket not in tickets:p.magic=request['magic'];p.type=request['type']
            for d in self.deals[prior:]:d.magic=request['magic']
            return res
    base,_=group(tmp_path);cfg=base.agents[0].config;mt5=BothMT5();g=AutoStrategies(mt5,cfg,clock=lambda:NOW)
    for agent in g.agents:
        agent._risk_history_checked=True
        agent._lease={'enabled':True,'account_ref':agent.account_ref};agent._lease_deadline_mono=run.time.monotonic()+20
        history=_m5_history(NOW,last_close=1.1)
        for r in history:r['high']+=.001;r['low']-=.001
        agent._rates['EUR_USD']={'H1':[],'M5':history}
    ra,dd=g.agents
    for agent in g.agents:
        state=agent.journal.load()
        levels=agent.core.plan_entry({'direction':'long','symbol':'EUR_USD','raw_stop':1.09},1.1001)
        outcome,_=agent._send_deal(state,kind='initial',logical='EUR_USD',side='long',volume=.3,
            quote={'bid':1.1,'ask':1.1001,'time':NOW},levels={'stop':levels['stop'],'target':levels['target']},now=NOW,
            strategy={'raw_stop':1.09,'stop_scale':agent.core.RULE_CONFIG['stop_scale'],'atr14_h1':.002,'decision_close':1.1})
        assert outcome=='succeeded',state
        assert state['basket'] and state['basket']['adds']==0
    assert len(mt5.positions)==2 and {p.magic for p in mt5.positions}=={ra.magic,dd.magic}
    # Entry notifications are emitted from actual fills and carry each strategy's protected levels.
    for agent in g.agents:
        state=agent.journal.load();e=next(e for e in state['events'] if e['type']=='basket_open')
        assert e['price']==1.1001 and e['sl'] and e['tp']
    # Both peers stay live; A alone may add, pinned to its starting lot even if common size changes.
    ra._execution=a.execution_settings(.12,1)
    add_quote={'bid':1.099,'ask':1.0991,'time':NOW}
    mt5.tick.bid,mt5.tick.ask=add_quote['bid'],add_quote['ask']
    state=ra.journal.load();basket=state['basket'];projected=(basket['average_price']+.0+add_quote['ask'])/2
    levels=a.basket_levels('long',projected,basket['initial_risk_distance'],'EUR_USD')
    out,_=ra._send_deal(state,kind='add',logical='EUR_USD',side='long',volume=.3,quote=add_quote,levels=levels,now=NOW,strategy={},basket_id=basket['id'])
    assert out=='succeeded' and len(mt5.positions)==3
    # Closing A's two legs must leave Donchian intact, even on the same symbol.
    state=ra.journal.load();assert state['basket']['adds']==1 and state['basket']['base_volume']==.3
    assert ra._close_managed(state,state['basket'],mt5.positions_get(),NOW,'test_exit')
    assert len(mt5.positions)==1 and mt5.positions[0].magic==dd.magic
    ra._manage_basket(state,mt5.positions_get(),NOW)
    assert state['basket'] is None and len(state['risk_ledger'])==1
    assert dd.journal.load()['basket'] is not None
    # A restart restores strategy ownership and the peer basket; it never sends a fill twice.
    count=len(mt5.sent);restarted=AutoStrategies(mt5,cfg,clock=lambda:NOW)
    assert restarted.agents[0].journal.load()['basket'] is None
    assert restarted.agents[1].journal.load()['basket']['adds']==0
    assert len(mt5.sent)==count


def test_optional_long_history_failure_falls_back_without_relaxing_minimums(tmp_path):
    g,mt5=group(tmp_path);agent=g.agents[0];calls=[]
    sample=[{'time':int((AT-timedelta(hours=1)).timestamp()),'open':1.1,'high':1.11,'low':1.09,'close':1.1}]
    def rates(symbol,tf,start,count):
        calls.append((start,count));return None if count>4096 else sample
    mt5.copy_rates_from_pos=rates
    rows=agent._rates_for('EUR_USD','H1',12020,AT)
    assert len(rows)==1 and calls==[(1,12040),(1,4096)]
    with pytest.raises(RuleAError,match='120 days'):agent._market_pair('EUR_USD',AT)






def test_dc_only_local_setting_still_restores_A_risk_and_protective_state(tmp_path):
    g,_=group(tmp_path);cfg=g.agents[0].config;cfg.enable_rule_a=False
    g=AutoStrategies(FakeMT5(),cfg,clock=lambda:NOW)
    assert len(g.agents)==2 and not g.agents[0].enabled_local
    assert g.agents[1].enabled_local
