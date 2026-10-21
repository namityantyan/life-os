"""USD60 planned cash risk; broker-native currency conversion and volume limits."""
import math
from decimal import Decimal, ROUND_FLOOR
try:
    from .donchian_agent import DonchianAgent, RuleAError
    from .mt5_common import field_value
    from . import donchian_v6_engine as core
except ImportError:
    from donchian_agent import DonchianAgent, RuleAError
    from mt5_common import field_value
    import donchian_v6_engine as core

MAGIC=26101906

class DonchianV6Agent(DonchianAgent):
    core=core
    magic=MAGIC
    local_flag='enable_donchian_v6'
    state_field='donchian_v6_state_path'
    sync_path='/fx/mt5/donchian-v6/sync'
    comment_prefix='d6'

    def _risk_budget_usd(self):
        # Life OS hook: the frozen preset budget. The Life OS subclass may only LOWER it (never above 60).
        return 60.

    def _planned_loss(self, logical, side, volume, price, stop):
        sign=1 if side=='long' else -1
        if not sign*(price-stop)>0:raise RuleAError('fixed risk requires protective SL')
        symbol=self.symbols[logical]; action=self.mt5.ORDER_TYPE_BUY if sign==1 else self.mt5.ORDER_TYPE_SELL
        loss=self.mt5.order_calc_profit(action,symbol,volume,price,stop)
        fee=self.mt5.order_calc_profit(action,symbol,volume,price,price-sign*1.2*self.core.pip_size(logical))
        if loss is None or fee is None or not all(math.isfinite(float(v)) and v<0 for v in (loss,fee)):
            raise RuleAError('fixed risk currency conversion unavailable')
        return -float(loss)-float(fee)

    def _initial_volume(self, logical, side, quote, levels):
        self._account()  # Account identity and USD denomination are checked first.
        info=self.mt5.symbol_info(self.symbols[logical])
        minimum,maximum,step=[float(field_value(info,k,0)) for k in ('volume_min','volume_max','volume_step')]
        if not all(math.isfinite(v) and v>0 for v in (minimum,maximum,step)) or maximum<minimum:
            raise RuleAError('fixed risk broker volume limits unavailable')
        price=float(quote['ask'] if side=='long' else quote['bid'])
        # Probe a valid broker quantity; MT5 computes loss in actual account currency.
        loss=self._planned_loss(logical,side,minimum,price,levels['stop'])/minimum
        cap=min(maximum,50.,self._risk_budget_usd()/loss)
        # Research uses 0.01 lot precision; require both that and the broker's step.
        from fractions import Fraction
        a,b=Fraction(str(step)),Fraction(1,100)
        unit=Decimal(math.lcm(a.numerator*b.denominator,b.numerator*a.denominator))/Decimal(a.denominator*b.denominator)
        volume=float((Decimal(str(cap))/unit).to_integral_value(rounding=ROUND_FLOOR)*unit)
        if volume<minimum-1e-10:raise RuleAError('fixed risk minimum lot exceeds USD60 budget')
        self._validate_request_risk(logical,side,{'volume':volume,'price':price,'sl':levels['stop']})
        return volume

    def _validate_volume(self, state, kind, volume):
        if kind!='initial' or not math.isfinite(volume) or not 0<volume<=50:
            raise RuleAError('fixed risk initial entry only')

    def _validate_request_risk(self, logical, side, request):
        # Re-check the final fresh quote immediately before durable intent and send.
        if self._planned_loss(logical,side,float(request['volume']),float(request['price']),float(request['sl']))>self._risk_budget_usd()+1e-8:
            raise RuleAError('fixed risk final quote exceeds USD60 budget')
