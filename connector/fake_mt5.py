"""Deterministic stand-in for the `MetaTrader5` module (tests and local smoke runs only — never a broker).

Same module-level API the agents and MT5Adapter use: initialize/shutdown, terminal_info, account_info,
symbols_get/symbol_select/symbol_info, symbol_info_tick, copy_rates_from_pos, positions_get, orders_get,
order_check, order_calc_margin, order_calc_profit, order_send, history_deals_get, plus the constants.

Prices are a pure function of time (sums of sines per pair), so bars and ticks are reproducible.
Market orders fill at the current Ask (buy) / Bid (sell); positions, deals and SL/TP are kept in memory.
Times are reported on the UTC basis (TIME_BASIS=utc).
"""
from __future__ import annotations

import math
from functools import lru_cache
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Callable, Optional

UTC = timezone.utc
_BASE = {"USD_JPY": 150.0, "EUR_JPY": 162.0, "GBP_JPY": 190.0, "AUD_JPY": 98.0,
         "EUR_USD": 1.08, "GBP_USD": 1.27, "AUD_USD": 0.655}
_TF = {5: 300, 16385: 3600, 16388: 14400, 16408: 86400}


@lru_cache(maxsize=500_000)
def _wave(logical: str, ts: float) -> float:
    """Pure synthetic mid price (cached: bars are re-read many times)."""
    base = _BASE[logical]
    k = sum(map(ord, logical)) % 17
    return base * (1 + 0.004 * math.sin(2 * math.pi * ts / (86400 * 3.7) + k)
                   + 0.0015 * math.sin(2 * math.pi * ts / (3600 * 5.3) + 2 * k)
                   + 0.0004 * math.sin(2 * math.pi * ts / 1800 + 3 * k))


class FakeMT5:
    # --- constants (values of the real package where it matters for readability)
    ACCOUNT_MARGIN_MODE_RETAIL_HEDGING = 2
    TIMEFRAME_M5 = 5
    TIMEFRAME_H1 = 16385
    TIMEFRAME_H4 = 16388
    TIMEFRAME_D1 = 16408
    TRADE_RETCODE_REQUOTE = 10004
    TRADE_RETCODE_REJECT = 10006
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_DONE_PARTIAL = 10010
    TRADE_RETCODE_INVALID = 10013
    TRADE_RETCODE_INVALID_VOLUME = 10014
    TRADE_RETCODE_INVALID_PRICE = 10015
    TRADE_RETCODE_INVALID_STOPS = 10016
    TRADE_RETCODE_TRADE_DISABLED = 10017
    TRADE_RETCODE_MARKET_CLOSED = 10018
    TRADE_RETCODE_NO_MONEY = 10019
    TRADE_RETCODE_PRICE_CHANGED = 10020
    TRADE_RETCODE_PRICE_OFF = 10021
    TRADE_RETCODE_INVALID_FILL = 10030
    SYMBOL_FILLING_FOK = 1
    SYMBOL_FILLING_IOC = 2
    SYMBOL_TRADE_MODE_DISABLED = 0
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
    DEAL_ENTRY_INOUT = 2
    DEAL_ENTRY_OUT_BY = 3

    def __init__(self, clock: Callable[[], datetime] = lambda: datetime.now(UTC), *, login: int = 12345678,
                 server: str = "XMTrading-Fake", suffix: str = "", spread_pips: float = 0.8, equity: float = 10000.0):
        self.clock = clock
        self.login, self.server, self.suffix = login, server, suffix
        self.spread_pips = spread_pips
        self.equity = equity
        self.initialized = False
        self.positions: list[SimpleNamespace] = []
        self.deals: list[SimpleNamespace] = []
        self.orders: list[Any] = []
        self.sent: list[dict] = []
        self.next_ticket = 5000
        # Test hooks
        self.send_mode = "fill"            # fill | none (result unknown) | lost_reply (filled, reply lost) | requote | raise
        self.price_offset: dict[str, float] = {}   # logical → added to every price (to move the market)
        self.shocks: list[tuple[str, float, float]] = []  # (logical, from_ts, delta): price += delta for ts >= from_ts
        self.tick_lag_seconds = 0.0
        self.extra_symbols: list[SimpleNamespace] = []

    # ---- connection / account ------------------------------------------------
    def initialize(self, *_a: Any, **_k: Any) -> bool:
        self.initialized = True
        return True

    def shutdown(self) -> None:
        self.initialized = False

    def last_error(self) -> tuple[int, str]:
        return (1, "Success")

    def terminal_info(self) -> Any:
        return SimpleNamespace(connected=True, trade_allowed=True, tradeapi_disabled=False)

    def account_info(self) -> Any:
        return SimpleNamespace(server=self.server, login=self.login, currency="USD", margin_mode=2,
                               trade_allowed=True, trade_expert=True, margin_free=self.equity,
                               equity=self.equity + sum(p.profit for p in self._live_positions()), balance=self.equity)

    # ---- symbols -------------------------------------------------------------
    def broker(self, logical: str) -> str:
        return logical.replace("_", "") + self.suffix

    def _logical(self, broker: str) -> str:
        for logical in _BASE:
            if self.broker(logical) == broker:
                return logical
        raise KeyError(broker)

    def symbols_get(self) -> list[Any]:
        rows = [SimpleNamespace(name=self.broker(l), currency_base=l[:3], currency_profit=l[4:], custom=False) for l in _BASE]
        return rows + list(self.extra_symbols)

    def symbol_select(self, _name: str, _enable: bool = True) -> bool:
        return True

    def symbol_info(self, broker: str) -> Any:
        logical = self._logical(broker)
        jpy = logical.endswith("_JPY")
        point = 0.001 if jpy else 0.00001
        return SimpleNamespace(name=broker, trade_mode=4, volume_min=0.01, volume_max=50.0, volume_step=0.01,
                               trade_stops_level=0, point=point, trade_tick_size=point, digits=3 if jpy else 5,
                               filling_mode=1, currency_base=logical[:3], currency_profit=logical[4:])

    # ---- prices --------------------------------------------------------------
    def price(self, logical: str, ts: float) -> float:
        digits = 3 if logical.endswith("_JPY") else 5
        shock = sum(d for (l, t0, d) in self.shocks if l == logical and ts >= t0)
        return round(_wave(logical, ts) + self.price_offset.get(logical, 0.0) + shock, digits)

    def _pip(self, logical: str) -> float:
        return 0.01 if logical.endswith("_JPY") else 0.0001

    def bid_ask(self, logical: str, ts: Optional[float] = None) -> tuple[float, float]:
        ts = self.clock().timestamp() if ts is None else ts
        bid = self.price(logical, ts)
        digits = 3 if logical.endswith("_JPY") else 5
        return bid, round(bid + self.spread_pips * self._pip(logical), digits)

    def symbol_info_tick(self, broker: str) -> Any:
        logical = self._logical(broker)
        ts = self.clock().timestamp() - self.tick_lag_seconds
        bid, ask = self.bid_ask(logical, ts)
        return SimpleNamespace(time=int(ts), time_msc=int(ts * 1000), bid=bid, ask=ask)

    def copy_rates_from_pos(self, broker: str, timeframe: int, start_pos: int, count: int) -> list[dict]:
        logical = self._logical(broker)
        width = _TF[timeframe]
        now = self.clock().timestamp()
        forming = int(now // width) * width
        out = []
        for pos in range(start_pos + count - 1, start_pos - 1, -1):
            t0 = forming - pos * width
            samples = [self.price(logical, t0 + width * f) for f in (0, 0.25, 0.5, 0.75)]
            end = min(t0 + width, now)
            close = self.price(logical, end)
            out.append({"time": t0, "open": samples[0], "high": max(samples + [close]),
                        "low": min(samples + [close]), "close": close, "tick_volume": 100})
        return out

    # ---- positions / orders ----------------------------------------------------
    def _live_positions(self) -> list[SimpleNamespace]:
        for p in self.positions:
            logical = self._logical(p.symbol)
            bid, ask = self.bid_ask(logical)
            exit_px = bid if p.type == self.ORDER_TYPE_BUY else ask
            p.price_current = exit_px
            p.profit = self.order_calc_profit(p.type, p.symbol, p.volume, p.price_open, exit_px) or 0.0
        return self.positions

    def positions_get(self, **_k: Any) -> list[Any]:
        return list(self._live_positions())

    def orders_get(self, **_k: Any) -> list[Any]:
        return list(self.orders)

    def order_check(self, _request: dict) -> Any:
        return SimpleNamespace(retcode=0, comment="Done")

    def order_calc_margin(self, *_a: Any) -> float:
        return 100.0

    def order_calc_profit(self, kind: int, broker: str, volume: float, price_open: float, price_close: float) -> Optional[float]:
        logical = self._logical(broker)
        sign = 1 if kind == self.ORDER_TYPE_BUY else -1
        quote_ccy = sign * (float(price_close) - float(price_open)) * float(volume) * 100000
        if logical.endswith("_JPY"):
            return quote_ccy / self.bid_ask("USD_JPY")[0]
        return quote_ccy

    def history_deals_get(self, date_from: Any = None, date_to: Any = None, **_k: Any) -> list[Any]:
        lo = date_from.timestamp() if isinstance(date_from, datetime) else float("-inf")
        hi = date_to.timestamp() if isinstance(date_to, datetime) else float("inf")
        return [d for d in self.deals if lo <= d.time <= hi]

    def _deal(self, position: SimpleNamespace, entry: int, volume: float, price: float, comment: str, magic: int) -> None:
        self.next_ticket += 1
        profit = 0.0
        if entry != self.DEAL_ENTRY_IN:
            profit = self.order_calc_profit(position.type, position.symbol, volume, position.price_open, price) or 0.0
        now = self.clock().timestamp()
        self.deals.append(SimpleNamespace(ticket=self.next_ticket, order=self.next_ticket, position_id=position.identifier,
                                          magic=magic, comment=comment, entry=entry, volume=volume, price=price,
                                          profit=profit, commission=-0.5 * volume / 0.1 * 0.1, swap=0.0, fee=0.0,
                                          symbol=position.symbol, time=now, time_msc=int(now * 1000)))

    def order_send(self, request: dict) -> Any:
        if self.send_mode == "lost_reply":
            self.send_mode = "fill"
            self.order_send(request)   # the broker filled it …
            self.send_mode = "lost_reply"
            return None                # … but the terminal reply never arrived
        self.sent.append(dict(request))
        if self.send_mode == "raise":
            raise RuntimeError("terminal IPC broken")
        if self.send_mode == "none":
            return None
        if self.send_mode == "requote":
            return SimpleNamespace(retcode=self.TRADE_RETCODE_REQUOTE, volume=0.0, deal=0, order=0)
        action = request["action"]
        if action == self.TRADE_ACTION_SLTP:
            p = next((p for p in self.positions if p.ticket == int(request["position"])), None)
            if p is None:
                return SimpleNamespace(retcode=self.TRADE_RETCODE_INVALID, volume=0.0)
            p.sl, p.tp = float(request["sl"]), float(request["tp"])
            return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE)
        logical = self._logical(request["symbol"])
        bid, ask = self.bid_ask(logical)
        if request.get("position"):
            p = next((p for p in self.positions if p.ticket == int(request["position"])), None)
            if p is None:
                return SimpleNamespace(retcode=self.TRADE_RETCODE_INVALID, volume=0.0)
            px = bid if p.type == self.ORDER_TYPE_BUY else ask
            self.positions.remove(p)
            self._deal(p, self.DEAL_ENTRY_OUT, float(request["volume"]), px, request.get("comment", ""), int(request.get("magic", 0)))
            return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE, volume=float(request["volume"]),
                                   deal=str(self.next_ticket), order=str(self.next_ticket))
        buy = request["type"] == self.ORDER_TYPE_BUY
        px = ask if buy else bid
        self.next_ticket += 1
        ticket = self.next_ticket
        now = self.clock().timestamp()
        p = SimpleNamespace(ticket=ticket, identifier=ticket, magic=int(request.get("magic", 0)), symbol=request["symbol"],
                            type=request["type"], volume=float(request["volume"]), price_open=px, time=int(now),
                            time_msc=int(now * 1000), sl=float(request.get("sl", 0) or 0), tp=float(request.get("tp", 0) or 0),
                            comment=request.get("comment", ""), profit=0.0, price_current=px)
        self.positions.append(p)
        self._deal(p, self.DEAL_ENTRY_IN, p.volume, px, p.comment, p.magic)
        return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE, volume=p.volume, deal=str(self.next_ticket), order=str(ticket))

    # ---- test helpers --------------------------------------------------------
    def open_manual(self, logical: str, side: str = "long", volume: float = 0.1, magic: int = 0) -> SimpleNamespace:
        """A position opened by hand / another EA (never adopted by the connector)."""
        req = {"action": self.TRADE_ACTION_DEAL, "symbol": self.broker(logical), "volume": volume,
               "type": self.ORDER_TYPE_BUY if side == "long" else self.ORDER_TYPE_SELL, "magic": magic, "comment": "manual"}
        saved, self.sent = self.sent, []
        self.order_send(req)
        self.sent = saved
        return self.positions[-1]

    def broker_hit(self, ticket: int) -> None:
        """Broker-side SL/TP close of a position (deal magic 0, as a stop-out would look)."""
        p = next(p for p in self.positions if p.ticket == ticket)
        logical = self._logical(p.symbol)
        bid, ask = self.bid_ask(logical)
        self.positions.remove(p)
        self._deal(p, self.DEAL_ENTRY_OUT, p.volume, bid if p.type == self.ORDER_TYPE_BUY else ask, "[sl]", 0)
