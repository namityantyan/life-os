"""Donchian execution uses the same durable order/protection machinery as Rule A."""
try:
    from .rule_a_agent import RuleAAgent, RuleAError
    from . import donchian_engine as core
except ImportError:
    from rule_a_agent import RuleAAgent, RuleAError
    import donchian_engine as core

MAGIC = 26101804


class DonchianAgent(RuleAAgent):
    core = core
    magic = MAGIC
    max_adds = 0
    trail_touch_close = True
    local_flag = 'enable_donchian'
    state_field = 'donchian_state_path'
    sync_path = '/fx/mt5/donchian/sync'
    comment_prefix = 'dc'

    def _add_cycle(self, state, now):
        return  # No averaging or pyramiding in the supplied preset.

    def _trailing(self, basket, quote, now):
        # Bid for a long exit; Ask for a short exit. Never infer Ask from Bid OHLC.
        price=quote['bid'] if basket['side']=='long' else quote['ask']
        trail=self.core.trailing_level(basket['side'],basket['average_price'],price,basket['symbol'],
                                  best=basket.get('trail_best'), previous_level=basket.get('active_stop') if basket.get('trail_active') else None)
        basket['trail_best']=trail['best']
        return trail

    def _send_deal(self, state, **kw):
        if kw['kind'] != 'initial':raise RuleAError('Donchian permits one initial entry only')
        quote,meta,logical=kw['quote'],kw['strategy'],kw['logical']
        pip=core.pip_size(logical); spread=quote['ask']-quote['bid']
        atr5=core.shared._atr(self._rates[logical]['M5'])[-1]
        risk=abs((quote['ask'] if kw['side']=='long' else quote['bid'])-kw['levels']['stop'])
        price=quote['ask'] if kw['side']=='long' else quote['bid']
        if not 0<=spread<=min(3*pip,.15*atr5):raise RuleAError('Donchian research spread guard')
        if risk<2*spread+.2*pip:raise RuleAError('Donchian research risk/spread guard')
        if abs(price-meta['decision_close'])>.5*meta['atr14_h1']:raise RuleAError('Donchian research quote gap guard')
        return super()._send_deal(state,**kw)
