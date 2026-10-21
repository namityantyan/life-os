"""Frozen 2026 Donchian v6 preset. Pure, closed-bar decision functions."""
from datetime import timedelta
from math import isfinite
from types import MappingProxyType
try:
    from . import rule_a_engine as shared
except ImportError:
    import rule_a_engine as shared

RULE_ID = 'donchian_improved_v6_2026'
PAIRS = shared.PAIRS
RULE_CONFIG = MappingProxyType({
    'entry_timeframe': 'H4', 'trend_timeframes': ('D1', 'H4'),
    'trend_fast_sma': 10, 'trend_slow_sma': 90,
    'd1_slope_bars': 15, 'h4_slope_bars': 3, 'breakout_bars': 24,
    'pullback_sma': 16, 'pullback_bars': 8, 'pullback_atr_band': .35,
    'atr_period': 14, 'stop_swing_bars': 5, 'stop_buffer_atr': .1,
    'minimum_original_stop_atr': .5, 'stop_scale': 1.0,
    'target_r': 3.0, 'commission_pips': .2, 'extra_cost_pips': 1.0,
    'max_holding_hours': 48, 'weekend_flat_jst': 'Saturday 05:00',
    'sizing': 'fixed_risk_usd', 'risk_usd': 60.0, 'lot_cap': 50.0,
    'daily_session_jst': '06:00', 'pivot_filter': 'R1 long / S1 short', 'add_max': 0, 'trailing_activation_pips': 60.0, 'trailing_distance_pips': 30.0,
    'entry_utc_hours': (6, 20), 'max_spread_pips': 3.0,
    'max_spread_atr_m5': .15, 'minimum_risk_spread_multiple': 2.0,
    'daily_loss_stop_r': -2.0, 'weekly_loss_stop_r': -3.0, 'monthly_loss_stop_r': -2.0,
    'preset_valid_until': '2027-10-01T00:00:00+09:00',
})
normalize_base_volume = shared.normalize_base_volume
pip_size = shared.pip_size
basket_levels = shared.basket_levels
portfolio_limits = shared.portfolio_limits


def execution_settings(base_volume=None, revision=0):
    # Common fixed-lot updates never change this preset's cash-risk budget.
    return {'schema_version': 1, 'base_volume': 50.0, 'max_adds': 0, 'revision': 0,
            'sizing': 'fixed_risk_usd', 'risk_usd': 60.0}


def _normalize(bars, tf, now):
    if tf != 'D1':return shared._normalize(bars, tf, now)
    # Shift the JST06:00 (UTC21:00) boundary to midnight for strict OHLC validation.
    shift=timedelta(hours=3); shifted=[]
    for row in bars:
        op=shared._get(row,'open_time');cl=shared._get(row,'close_time')
        shifted.append({**{k:shared._get(row,k) for k in ('open','high','low','close')},
                        **({'open_time':shared._dt(op)+shift} if op is not None else {}),
                        **({'close_time':shared._dt(cl)+shift} if cl is not None else {})})
    return [{**r,'open_time':r['open_time']-shift,'close_time':r['close_time']-shift}
            for r in shared._normalize(shifted,tf,shared._dt(now)+shift)]


def build_frames(h1, now):
    cutoff=shared._dt(now); result=shared.build_frames(h1,cutoff); result['D1']=[]
    groups={}
    for row in result['H1']:
        t=row['open_time'];start=(t+timedelta(hours=3)).replace(hour=0)-timedelta(hours=3)
        groups.setdefault(start,[]).append(row)
    # Match the research's observed-bar aggregation (complete=False), with no gap fill.
    # Do not admit a leading truncated session or any unfinished current day.
    first=result['H1'][0]['open_time'] if result['H1'] else cutoff
    for start,rows in sorted(groups.items()):
        end=start+timedelta(days=1)
        if start<first or end>cutoff:continue
        result['D1'].append({'open_time':start,'close_time':end,'open':rows[0]['open'],
                            'high':max(r['high'] for r in rows),'low':min(r['low'] for r in rows),'close':rows[-1]['close']})
    return result


def _trend(rows, lag):
    values = [r['close'] for r in rows]; i = len(values)-1
    fast = shared._sma(values, 10, i); slow = shared._sma(values, 90, i)
    prior = shared._sma(values, 10, i-lag)
    side = ('long' if values[i] > slow and fast > slow and fast > prior else
            'short' if values[i] < slow and fast < slow and fast < prior else 'neutral')
    return {'direction': side, 'sma10': fast, 'sma90': slow, f'sma10_{lag}_bars_ago': prior}


def evaluate_entry(symbol, frames, now):
    pip_size(symbol); now = shared._dt(now)
    rows = {tf: _normalize(frames.get(tf, ()), tf, now) for tf in ('H1','H4','D1')}
    h4 = rows['H4']; at = h4[-1]['close_time'] if h4 else now
    result = {'strategy_id': RULE_ID, 'symbol': symbol, 'as_of': shared._iso(at),
              'entry_timeframe': 'H4', 'state': 'watching', 'direction': 'neutral',
              'trend': {}, 'checks': [], 'indicators': {}, 'signal': None}
    def check(label, passed, detail):
        result['checks'].append({'label': label, 'passed': bool(passed), 'detail': detail})
    if not h4:
        check('H4 history', False, 'No closed H4 candle is available'); result['state']='stale'; return result
    # Higher/lower frames are all recut to the H4 decision close, never to now.
    rows = {tf: [r for r in rs if r['close_time'] <= at] for tf,rs in rows.items()}
    h1, h4, d1 = rows['H1'], rows['H4'], rows['D1']
    check('Closed history', len(h1)>=90 and len(h4)>=90 and len(d1)>=90,
          f'H1 {len(h1)}, H4 {len(h4)}, D1 {len(d1)}; 90 required')
    if not result['checks'][-1]['passed']: return result
    trend = {'D1':_trend(d1,15), 'H4':_trend(h4,3)}; result['trend']=trend
    side = trend['D1']['direction']
    aligned = side in ('long','short') and side == trend['H4']['direction']
    result['direction'] = side if aligned else 'neutral'
    check('D1/H4 trend alignment', aligned, 'SMA10/SMA90 with D1 15-bar and H4 3-bar slope')
    values = [r['close'] for r in h1]; atrs=shared._atr(h1); i=len(h1)-1; atr=atrs[i]
    pullback = any(isfinite(shared._sma(values,16,j)) and isfinite(atrs[j]) and
                   h1[j]['low']<=shared._sma(values,16,j)+.35*atrs[j] and
                   h1[j]['high']>=shared._sma(values,16,j)-.35*atrs[j]
                   for j in range(i-8,i))
    check('H1 pullback to SMA16', pullback, 'one of the prior 8 H1 bars overlaps SMA16 ±0.35 ATR14')
    prior = h4[-25:-1]; close = h4[-1]['close']
    breakout = len(prior)==24 and (close>max(r['high'] for r in prior) if side=='long' else
                                  close<min(r['low'] for r in prior) if side=='short' else False)
    check('H4 24-bar breakout', breakout, 'close strictly breaks the preceding 24 H4 bars; decision bar excluded')
    previous=d1[-1]; p=(previous['high']+previous['low']+previous['close'])/3
    r1,s1=2*p-previous['low'],2*p-previous['high']
    pivot_ok=close>r1 if side=='long' else close<s1 if side=='short' else False
    check('Daily pivot R1/S1',pivot_ok,'H4 close > R1 (long), < S1 (short); last confirmed JST06:00 day')
    fresh = now-at<=timedelta(hours=5) and at-d1[-1]['close_time']<=timedelta(hours=96) and at==h1[-1]['close_time']
    check('D1/H1 freshness', fresh, 'D1 <=96h and H1 closes exactly at the H4 decision')
    # These pre-existing guards also run in the supplied research engine.
    contiguous = all(h1[j]['close_time']==h1[j+1]['open_time'] for j in range(i-8,i))
    check('H1 continuity', contiguous, 'preceding 9 H1 bars have no missing hour')
    window = 6<=at.hour<20 and at.weekday()<5
    check('Entry session', window, 'research engine UTC 06:00–20:00, Monday–Friday')
    check('Annual preset', now<shared._dt(RULE_CONFIG['preset_valid_until']), '2026 preset; reselect in October 2027 before new entries')
    result['indicators']={'pivot_p':p,'pivot_r1':r1,'pivot_s1':s1,'pivot_day_close':shared._iso(previous['close_time']),
                          'atr14_h1':atr if isfinite(atr) else None,
                          'donchian_high':max(r['high'] for r in prior), 'donchian_low':min(r['low'] for r in prior)}
    if aligned and isfinite(atr) and atr>0 and all(c['passed'] for c in result['checks']):
        swing=h1[-5:]
        stop=min(min(r['low'] for r in swing)-.1*atr,h1[-1]['close']-.5*atr) if side=='long' else max(max(r['high'] for r in swing)+.1*atr,h1[-1]['close']+.5*atr)
        result['signal']={'id':f'{RULE_ID}:{symbol}:{shared._iso(at)}:{side}', 'symbol':symbol,
                          'direction':side,'as_of':shared._iso(at),'raw_stop':stop,
                          'decision_close':h1[-1]['close'],'atr14_h1':atr}
        result['state']='ready'
    elif not fresh: result['state']='stale'
    return result


def plan_entry(signal, fill_price):
    # Shared implementation applies .5 to original risk; Donchian uses full risk.
    base=shared.plan_entry(signal,fill_price); risk=base['risk_distance']*2
    levels=basket_levels(signal['direction'],float(fill_price),risk,signal['symbol'])
    return {**base,**levels,'entry_price':float(fill_price),'risk_distance':risk}


def exit_deadline(entry_time):
    entry=shared._dt(entry_time)
    # Friday 20:00 UTC == Saturday 05:00 JST, including a weekend entry fail-safe.
    friday=entry.replace(hour=20,minute=0,second=0,microsecond=0)+timedelta(days=(4-entry.weekday())%7)
    if friday<=entry: friday+=timedelta(days=7)
    return min(entry+timedelta(hours=48),friday)


def trailing_level(side, entry_price, executable_price, symbol, *, best=None, previous_level=None):
    if side not in ('long','short'): raise ValueError('invalid side')
    sign=1 if side=='long' else -1
    entry, price=float(entry_price),float(executable_price); pip=pip_size(symbol)
    if not all(isfinite(v) and v>0 for v in (entry,price)):raise ValueError('invalid trailing quote')
    best=price if best is None else (max(float(best),price) if sign==1 else min(float(best),price))
    active=sign*(best-entry)>=60*pip-1e-10
    level=best-sign*30*pip if active else None
    if previous_level is not None:level=(max(float(previous_level),level) if sign==1 else min(float(previous_level),level)) if level is not None else float(previous_level)
    return {'active':active or previous_level is not None,'level':level,'best':best}
