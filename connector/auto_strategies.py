"""Serialized two-strategy coordinator. Only journal-verified peer exposure is allowed."""
import uuid
try:
    from .rule_a_agent import RuleAAgent, RuleAError
    from .donchian_agent import DonchianAgent
    from .donchian_v6_agent import DonchianV6Agent
    from .mt5_common import field_value
except ImportError:
    from rule_a_agent import RuleAAgent, RuleAError
    from donchian_agent import DonchianAgent
    from donchian_v6_agent import DonchianV6Agent
    from mt5_common import field_value


class AutoStrategies:
    def __init__(self, mt5, config, **kwargs):
        self.version=2 if getattr(config,'enable_donchian_v6',False) else 1
        self.agents=[]
        if getattr(config,'enable_rule_a',False) or getattr(config,'enable_donchian',False) or getattr(config,'enable_donchian_v6',False):self.agents.append(RuleAAgent(mt5,config,**kwargs))
        if getattr(config,'enable_donchian',False) or getattr(config,'enable_donchian_v6',False):self.agents.append(DonchianAgent(mt5,config,**kwargs))
        if getattr(config,'enable_donchian_v6',False):self.agents.append(DonchianV6Agent(mt5,config,**kwargs))
        instance_id=str(uuid.uuid4())
        for agent in self.agents:
            agent.coordinator=self
            agent.instance_id=instance_id
        if len({a.journal.path for a in self.agents})!=len(self.agents):raise RuleAError('strategies must have separate journals')
        self._symbols={}
        # Single observed feed, distinct decision caches and durable ownership.
        if self.agents:
            shared=self.agents[0]._rates
            for a in self.agents:a._rates=shared

    @property
    def symbols(self):return self._symbols
    @symbols.setter
    def symbols(self,value):
        self._symbols=dict(value)
        for a in self.agents:a.symbols=dict(value)

    def run_once(self):
        result=[]
        for agent in self.agents:
            try:result.append(agent.run_once())
            except Exception:
                # A failing strategy must not suppress the other's protective exits.
                result.append({'strategy_id':agent.core.RULE_ID,'state':'blocked'})
        return result

    def can_open(self, caller):
        for peer in self.agents:
            if peer is caller:continue
            try:
                state=peer.journal.load()
                if not peer._risk_history_checked or state.get('quarantine') or peer._unresolved_intents(state):return False
            except Exception:return False
        return True

    def risk_events(self, caller, state):
        events=list(state.get('risk_ledger',[]))
        for peer in self.agents:
            if peer is not caller:events.extend(peer.journal.load().get('risk_ledger',[]))
        return events

    def known_peer_position(self,caller,position):
        ticket=str(field_value(position,'ticket',''));ident=str(field_value(position,'identifier',''))
        for peer in self.agents:
            if peer is caller or int(field_value(position,'magic',-1))!=peer.magic:continue
            try:
                basket=peer.journal.load().get('basket') or {};leg=basket.get('legs',{}).get(ticket)
                if not leg or str(leg.get('identifier'))!=ident:return False
                if field_value(position,'symbol')!=peer.symbols.get(basket.get('symbol')):return False
                expected=peer.mt5.ORDER_TYPE_BUY if basket.get('side')=='long' else peer.mt5.ORDER_TYPE_SELL
                return (field_value(position,'type')==expected and
                        abs(float(field_value(position,'volume',0))-float(leg.get('volume',0)))<1e-8)
            except Exception:return False
        return False

    def initial_blocked(self,caller,positions):
        if not self.can_open(caller):return True
        return any(not self.known_peer_position(caller,p) for p in positions)
