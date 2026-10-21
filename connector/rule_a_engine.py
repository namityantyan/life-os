"""Pure deterministic core for Rule A (improved).

The module deliberately has no broker, filesystem, clock, or network dependency.
All inputs are caller-supplied bars and timestamps; all returned values are plain
JSON-compatible objects except the immutable configuration constant.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from math import isfinite
from types import MappingProxyType
from typing import Any, Iterable, Mapping

RULE_ID = "rule_a_improved_v1"
PAIRS = ("USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_USD", "GBP_USD", "AUD_USD")
RULE_CONFIG = MappingProxyType({
    "entry_timeframe": "H1", "trend_timeframes": ("D1", "H4", "H1"),
    "trend_fast_sma": 10, "trend_slow_sma": 90, "trend_slope_bars": 3,
    "pullback_sma": 16, "pullback_bars": 8, "pullback_atr_band": 0.35,
    "adx_period": 14, "adx_min": 25.0, "atr_period": 14,
    "trigger_bars": 3, "trigger_body_atr": 0.2, "max_sma10_deviation_pips": 85.0,
    "stop_swing_bars": 5, "stop_buffer_atr": 0.1,
    "minimum_original_stop_atr": 0.5, "stop_scale": 0.5,
    "target_r": 3.0, "commission_pips": 0.2, "extra_cost_pips": 1.0,
    "max_holding_hours": 18, "daily_flat_jst_hour": 5,
    "add_max": 3, "add_size": "same", "add_basis": "average",
    "add_trigger": "M5 close <= SMA20-10pips (long), >= SMA20+10pips (short)",
    "trailing_activation_pips": 100.0, "trailing_sma": 20, "trailing_offset_pips": 10.0,
    "daily_loss_stop_r": -2.0, "weekly_loss_stop_r": -3.0, "monthly_loss_stop_r": -2.0,
})

_UTC = timezone.utc
_JST = timezone(timedelta(hours=9))  # Modern JST has no DST; Windows needs no external tzdata.
_WIDTH = {"M5": 300, "H1": 3600, "H4": 14400, "D1": 86400}


def normalize_base_volume(value: Any) -> float:
    """Shared execution size validation; does not alter indicator/risk rules."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError("ロット数は0.01〜100.00を、小数第2位までで入力してください。")
    if len(str(value)) > 32:
        raise ValueError("ロット数を確認してください。")
    try:
        number = Decimal(str(value).strip())
        valid = number.is_finite() and Decimal('0.01') <= number <= Decimal('100.00')
        if not valid or number != number.quantize(Decimal('0.01')):
            raise ValueError
    except (InvalidOperation, ValueError):
        raise ValueError("ロット数は0.01〜100.00を、小数第2位までで入力してください。") from None
    return float(number)


def execution_settings(base_volume=0.30, revision=0) -> dict[str, Any]:
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ValueError("ロット設定のバージョンを確認してください。")
    return {"schema_version": 1, "base_volume": normalize_base_volume(base_volume),
            "max_adds": 3, "revision": revision}


def _dt(value: Any) -> datetime:
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, str):
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        raise ValueError("timestamp must be an aware datetime or ISO-8601 string")
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("timestamps must include a timezone")
    return result.astimezone(_UTC)


def _iso(value: datetime) -> str:
    return _dt(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def _get(obj: Any, key: str, default: Any = None) -> Any:
    return obj.get(key, default) if isinstance(obj, Mapping) else getattr(obj, key, default)


def _bar(obj: Any, tf: str) -> dict[str, Any]:
    width = timedelta(seconds=_WIDTH[tf])
    op_time = _get(obj, "open_time")
    cl_time = _get(obj, "close_time")
    if op_time is None and cl_time is None:
        raise ValueError(f"{tf} bar needs open_time or close_time")
    if op_time is None:
        close_time = _dt(cl_time)
        open_time = close_time - width
    else:
        open_time = _dt(op_time)
        close_time = _dt(cl_time) if cl_time is not None else open_time + width
    if close_time != open_time + width:
        raise ValueError(f"{tf} bar duration must be exactly {width}")
    if open_time.timestamp() % _WIDTH[tf] != 0:
        raise ValueError(f"{tf} open_time must align to UTC timeframe boundary")
    vals = {}
    for key in ("open", "high", "low", "close"):
        try:
            n = float(_get(obj, key))
        except (TypeError, ValueError):
            raise ValueError(f"bar {key} must be finite") from None
        if not isfinite(n):
            raise ValueError(f"bar {key} must be finite")
        vals[key] = n
    if vals["high"] < max(vals["open"], vals["close"], vals["low"]):
        raise ValueError("bar high is inconsistent with OHLC")
    if vals["low"] > min(vals["open"], vals["close"], vals["high"]):
        raise ValueError("bar low is inconsistent with OHLC")
    return {"open_time": open_time, "close_time": close_time, **vals}


def _normalize(bars: Iterable[Any], tf: str, cutoff: datetime) -> list[dict[str, Any]]:
    if tf not in _WIDTH:
        raise ValueError(f"unsupported timeframe: {tf}")
    rows = [_bar(x, tf) for x in bars]
    rows.sort(key=lambda x: x["open_time"])
    seen = set()
    for row in rows:
        k = row["open_time"]
        if k in seen:
            raise ValueError(f"duplicate {tf} candle at {_iso(k)}")
        seen.add(k)
    return [x for x in rows if x["close_time"] <= cutoff]


def _sma(values: list[float], period: int, index: int) -> float:
    if index + 1 < period:
        return float("nan")
    return sum(values[index - period + 1:index + 1]) / period


def _wilder(values: list[float], period: int, start: int = 0) -> list[float]:
    out = [float("nan")] * len(values)
    seed = start + period - 1
    if seed >= len(values):
        return out
    value = sum(values[start:seed + 1]) / period
    out[seed] = value
    for i in range(seed + 1, len(values)):
        value = ((period - 1) * value + values[i]) / period
        out[i] = value
    return out


def _atr(rows: list[dict[str, Any]], period: int = 14) -> list[float]:
    tr = []
    for i, row in enumerate(rows):
        tr.append(row["high"] - row["low"] if i == 0 else max(
            row["high"] - row["low"], abs(row["high"] - rows[i - 1]["close"]),
            abs(row["low"] - rows[i - 1]["close"])))
    return _wilder(tr, period)


def _adx(rows: list[dict[str, Any]], period: int = 14) -> list[float]:
    n = len(rows)
    up, down = [], []
    for i in range(1, n):
        u = rows[i]["high"] - rows[i - 1]["high"]
        d = rows[i - 1]["low"] - rows[i]["low"]
        up.append(u if u > d and u > 0 else 0.0)
        down.append(d if d > u and d > 0 else 0.0)
    plus = sum(up[:period])
    minus = sum(down[:period])
    dx = [0.0] * n
    for i in range(period, n):
        if i > period:
            plus += up[i - 1] - plus / period
            minus += down[i - 1] - minus / period
        dx[i] = 100.0 * abs(plus - minus) / (plus + minus) if plus + minus > 0 else 0.0
    # Matches the reference engine: DX starts at index period, and ADX is
    # Wilder-seeded over `period` DX values, first available at 2*period-1.
    return _wilder(dx, period, period)


def pip_size(symbol: str) -> float:
    if symbol not in PAIRS:
        raise ValueError(f"unsupported Rule A symbol: {symbol}")
    return 0.01 if symbol.endswith("_JPY") else 0.0001


def _directional_trend(rows: list[dict[str, Any]], i: int) -> tuple[str, float, float]:
    closes = [x["close"] for x in rows]
    fast, slow = _sma(closes, 10, i), _sma(closes, 90, i)
    prior_fast = _sma(closes, 10, i - 3)
    if closes[i] > slow and fast > slow and fast > prior_fast:
        direction = "long"
    elif closes[i] < slow and fast < slow and fast < prior_fast:
        direction = "short"
    else:
        direction = "neutral"
    return direction, fast, slow


def evaluate_entry(symbol: str, frames: Mapping[str, Iterable[Any]], now: datetime | str) -> dict[str, Any]:
    """Evaluate the latest closed H1 bar using only bars known by its close."""
    pip = pip_size(symbol)
    now_utc = _dt(now)
    normalized = {tf: _normalize(frames.get(tf, ()), tf, now_utc) for tf in ("H1", "H4", "D1")}
    h1 = normalized["H1"]
    if not h1:
        return _empty_result(symbol, now_utc, "stale", "No closed H1 candle is available.")
    trigger = h1[-1]
    asof = trigger["close_time"]
    if now_utc - asof > timedelta(minutes=90):
        result = _empty_result(symbol, asof, "stale", "Latest H1 close is more than 90 minutes old.")
        result["symbol"] = symbol
        result["as_of"] = _iso(asof)
        return result
    # Re-cut every timeframe at the decision close to prevent higher-timeframe lookahead.
    h1 = [x for x in h1 if x["close_time"] <= asof]
    h4 = [x for x in normalized["H4"] if x["close_time"] <= asof]
    d1 = [x for x in normalized["D1"] if x["close_time"] <= asof]
    trend_info: dict[str, Any] = {}
    checks: list[dict[str, Any]] = []

    def add(label: str, passed: bool, detail: str) -> None:
        checks.append({"label": label, "passed": bool(passed), "detail": detail})

    enough = {"H1": len(h1) >= 90, "H4": len(h4) >= 90, "D1": len(d1) >= 90}
    for tf, rows in (("D1", d1), ("H4", h4), ("H1", h1)):
        add(f"{tf} history", enough[tf], f"{len(rows)} closed bars; 90 required")
        if enough[tf]:
            idx = len(rows) - 1
            direction, fast, slow = _directional_trend(rows, idx)
            trend_info[tf] = {"direction": direction, "sma10": fast, "sma90": slow,
                              "sma10_3_bars_ago": _sma([x["close"] for x in rows], 10, idx - 3)}
        else:
            trend_info[tf] = {"direction": "neutral", "sma10": None, "sma90": None,
                              "sma10_3_bars_ago": None}
    if not all(enough.values()):
        return {"strategy_id": RULE_ID, "symbol": symbol, "as_of": _iso(asof), "entry_timeframe": "H1",
                "state": "watching", "direction": "neutral", "trend": trend_info, "checks": checks,
                "indicators": {}, "signal": None}

    directions = [trend_info[tf]["direction"] for tf in ("D1", "H4", "H1")]
    side = directions[0] if directions[0] in ("long", "short") and len(set(directions)) == 1 else "neutral"
    for tf in ("D1", "H4", "H1"):
        add(f"{tf} trend alignment", trend_info[tf]["direction"] == side and side != "neutral",
            f"{trend_info[tf]['direction']} {('matches ' + side) if side != 'neutral' else 'does not align'}")

    closes = [x["close"] for x in h1]
    atrs, adxs = _atr(h1), _adx(h1)
    i = len(h1) - 1
    atr, adx = atrs[i], adxs[i]
    fast_h1 = _sma(closes, 10, i)
    entry_ma = _sma(closes, 16, i)
    pullback = False
    if isfinite(atr) and atr > 0:
        for j in range(max(0, i - 8), i):
            ma = _sma(closes, 16, j)
            if isfinite(ma) and h1[j]["low"] <= ma + 0.35 * atrs[j] and h1[j]["high"] >= ma - 0.35 * atrs[j]:
                pullback = True
                break
    add("H1 pullback to SMA16", pullback, "one of the prior 8 H1 ranges overlaps SMA16 ±0.35 ATR14")
    adx_ok = isfinite(adx) and adx >= 25
    add("H1 ADX14", adx_ok, f"{adx:.6g} >= 25" if isfinite(adx) else "ADX14 unavailable")
    body = abs(trigger["close"] - trigger["open"])
    body_ok = isfinite(atr) and atr > 0 and body >= 0.2 * atr and (
        (side == "long" and trigger["close"] > trigger["open"]) or
        (side == "short" and trigger["close"] < trigger["open"]))
    add("H1 trigger body", body_ok, "trigger candle has the trend direction and body >=0.2 ATR14")
    prior = h1[max(0, i - 3):i]
    breakout = len(prior) == 3 and (trigger["close"] > max(x["high"] for x in prior) if side == "long"
                                    else trigger["close"] < min(x["low"] for x in prior) if side == "short" else False)
    add("H1 3-bar breakout", breakout, "close strictly breaks the prior 3 H1 highs/lows")
    deviation = abs(trigger["close"] - fast_h1) / pip if isfinite(fast_h1) else float("inf")
    deviation_ok = deviation < 85.0
    add("H1 SMA10 distance", deviation_ok, f"{deviation:.6g} pips < 85")
    d1_fast = trend_info["D1"]["sma10"]
    d1_ok = (trigger["close"] > d1_fast if side == "long" else trigger["close"] < d1_fast if side == "short" else False)
    add("H1 close vs D1 SMA10", d1_ok, "decision close is on the trend side of D1 SMA10")
    # Higher-frame freshness follows the source engine's causal stale limits.
    fresh = asof - d1[-1]["close_time"] <= timedelta(hours=96) and asof - h4[-1]["close_time"] <= timedelta(hours=5)
    add("D1/H4 freshness", fresh, "D1 <=96h and H4 <=5h old at the H1 close")
    direction = side if side != "neutral" else "neutral"
    passed = side != "neutral" and all(c["passed"] for c in checks if c["label"] not in ("H1 history", "H4 history", "D1 history"))
    raw_stop = None
    signal = None
    if passed:
        window = h1[max(0, i - 4):i + 1]
        if side == "long":
            raw_stop = min(min(x["low"] for x in window) - 0.1 * atr, trigger["close"] - 0.5 * atr)
        else:
            raw_stop = max(max(x["high"] for x in window) + 0.1 * atr, trigger["close"] + 0.5 * atr)
        signal = {"id": f"{RULE_ID}:{symbol}:{_iso(asof)}:{side}", "symbol": symbol,
                  "direction": side, "as_of": _iso(asof), "atr14_h1": atr,
                  "raw_stop": raw_stop, "decision_close": trigger["close"]}
    return {"strategy_id": RULE_ID, "symbol": symbol, "as_of": _iso(asof), "entry_timeframe": "H1",
            "state": "stale" if not fresh else "ready" if signal else "watching", "direction": direction,
            "trend": trend_info, "checks": checks,
            "indicators": {"atr14_h1": atr if isfinite(atr) else None, "adx14_h1": adx if isfinite(adx) else None,
                           "sma16_h1": entry_ma if isfinite(entry_ma) else None,
                           "sma10_h1": fast_h1 if isfinite(fast_h1) else None,
                           "sma10_d1": d1_fast}, "signal": signal}


def _empty_result(symbol: str, now: datetime, state: str, detail: str) -> dict[str, Any]:
    return {"strategy_id": RULE_ID, "symbol": symbol, "as_of": _iso(now), "entry_timeframe": "H1",
            "state": state, "direction": "neutral", "trend": {},
            "checks": [{"label": "H1 data", "passed": False, "detail": detail}], "indicators": {}, "signal": None}


def build_frames(h1: Iterable[Any], now: datetime | str) -> dict[str, list[dict[str, Any]]]:
    """Build UTC H4/D1 candles from complete, contiguous H1 groups; never fill gaps."""
    cutoff = _dt(now)
    hourly = _normalize(h1, "H1", cutoff)
    result = {"H1": hourly, "H4": [], "D1": []}
    for tf, width_hours in (("H4", 4), ("D1", 24)):
        grouped: dict[datetime, list[dict[str, Any]]] = {}
        for row in hourly:
            t = row["open_time"]
            if tf == "H4":
                start = t.replace(hour=t.hour - t.hour % 4, minute=0, second=0, microsecond=0)
            else:
                start = t.replace(hour=0, minute=0, second=0, microsecond=0)
            grouped.setdefault(start, []).append(row)
        expected = width_hours
        for start, bars in sorted(grouped.items()):
            bars.sort(key=lambda x: x["open_time"])
            if len(bars) != expected or bars[0]["open_time"] != start or any(
                    bars[k]["open_time"] != start + timedelta(hours=k) for k in range(expected)):
                continue
            close_time = start + timedelta(hours=expected)
            if close_time > cutoff:
                continue
            result[tf].append({"open_time": start, "close_time": close_time, "open": bars[0]["open"],
                               "high": max(x["high"] for x in bars), "low": min(x["low"] for x in bars),
                               "close": bars[-1]["close"]})
    return result


def plan_entry(signal: Mapping[str, Any], fill_price: float) -> dict[str, float]:
    """Resolve next-M5 executable fill into fixed stop and cost-inclusive 3R target."""
    side = signal["direction"]
    if side not in ("long", "short"):
        raise ValueError("signal direction must be long or short")
    fill = float(fill_price)
    raw_stop = float(signal["raw_stop"])
    pip = pip_size(signal["symbol"])
    original_distance = fill - raw_stop if side == "long" else raw_stop - fill
    if not isfinite(fill) or not isfinite(raw_stop) or original_distance <= 0:
        raise ValueError("fill must be finite and on the risk side of raw_stop")
    risk_distance = original_distance * 0.5
    stop = fill - risk_distance if side == "long" else fill + risk_distance
    target_distance = 3.0 * risk_distance + 4.0 * (0.2 + 1.0) * pip
    target = fill + target_distance if side == "long" else fill - target_distance
    return {"entry_price": fill, "raw_stop": raw_stop, "risk_distance": risk_distance,
            "stop": stop, "target": target, "target_distance": target_distance,
            "target_r": 3.0, "pip_size": pip}


def basket_levels(side: str, average_price: float, initial_risk_distance: float, symbol: str) -> dict[str, float]:
    """Recenter the original fixed distance and 3R cost target at basket average."""
    if side not in ("long", "short"):
        raise ValueError("side must be long or short")
    avg, risk, pip = float(average_price), float(initial_risk_distance), pip_size(symbol)
    if not isfinite(avg) or not isfinite(risk) or risk <= 0:
        raise ValueError("average_price and positive initial_risk_distance must be finite")
    stop = avg - risk if side == "long" else avg + risk
    td = 3.0 * risk + 4.8 * pip
    return {"average_price": avg, "risk_distance": risk, "stop": stop,
            "target": avg + td if side == "long" else avg - td, "target_distance": td}


def _closed_m5(m5: Iterable[Any], decision_time: datetime | str) -> list[dict[str, Any]]:
    return _normalize(m5, "M5", _dt(decision_time))


def _m5_sma(rows: list[dict[str, Any]], index: int, period: int = 20) -> float:
    if index + 1 < period:
        return float("nan")
    return sum(x["close"] for x in rows[index - period + 1:index + 1]) / period


def add_condition(side: str, m5: Iterable[Any], decision_time: datetime | str,
                  symbol: str | None = None) -> bool:
    """Whether the latest closed M5 close triggers one scale-in decision."""
    if side not in ("long", "short"):
        raise ValueError("side must be long or short")
    source = list(m5)
    rows = _closed_m5(source, decision_time)
    i = len(rows) - 1
    sma = _m5_sma(rows, i)
    if i < 19 or not isfinite(sma):
        return False
    if symbol is None:
        symbol = next((_get(x, "symbol") for x in source if _get(x, "symbol")), None)
    if symbol is None:
        raise ValueError("symbol is required to apply the 10-pip M5 add threshold")
    pip = pip_size(symbol)
    return rows[i]["close"] <= sma - 10 * pip if side == "long" else rows[i]["close"] >= sma + 10 * pip


def add_condition_for_symbol(side: str, m5: Iterable[Any], decision_time: datetime | str, symbol: str) -> bool:
    """Symbol-explicit form of the M5 add trigger; preferred for execution code."""
    if side not in ("long", "short"):
        raise ValueError("side must be long or short")
    return add_condition(side, m5, decision_time, symbol=symbol)


def trailing_level(side: str, m5: Iterable[Any], average_price: float, current_bidask: Any,
                   active: bool = False, symbol: str | None = None,
                   previous_level: float | None = None,
                   decision_time: datetime | str | None = None) -> dict[str, Any]:
    """Latch trailing after 100 executable pips; return a tightening M5 SMA20 stop."""
    if side not in ("long", "short"):
        raise ValueError("side must be long or short")
    if symbol is None:
        symbol = _get(current_bidask, "symbol")
    if symbol is None:
        raise ValueError("symbol is required for pip conversion")
    pip = pip_size(symbol)
    bid = float(_get(current_bidask, "bid", _get(current_bidask, "Bid", float("nan"))))
    ask = float(_get(current_bidask, "ask", _get(current_bidask, "Ask", float("nan"))))
    avg = float(average_price)
    executable_profit = (bid - avg) if side == "long" else (avg - ask)
    active = bool(active or executable_profit >= 100 * pip)
    cutoff = _dt(decision_time) if decision_time is not None else datetime.max.replace(tzinfo=_UTC)
    rows = _normalize(m5, "M5", cutoff)
    i = len(rows) - 1
    sma = _m5_sma(rows, i)
    candidate = None
    level = previous_level
    if active and isfinite(sma):
        candidate = sma - 10 * pip if side == "long" else sma + 10 * pip
        if previous_level is None:
            level = candidate
        else:
            level = max(float(previous_level), candidate) if side == "long" else min(float(previous_level), candidate)
    return {"active": active, "level": level, "candidate": candidate,
            "executable_profit_pips": executable_profit / pip}


def exit_deadline(entry_time: datetime | str) -> datetime:
    """Earlier of entry+18h and the next 05:00 JST boundary (equal counts next day)."""
    entry = _dt(entry_time)
    local = entry.astimezone(_JST)
    flat = local.replace(hour=5, minute=0, second=0, microsecond=0)
    if local >= flat:
        flat += timedelta(days=1)
    return min(entry + timedelta(hours=18), flat.astimezone(_UTC))


def portfolio_limits(realized_events: Iterable[Mapping[str, Any]], now: datetime | str) -> dict[str, Any]:
    """Aggregate realized R by UTC day/week/month and report any active pause."""
    current = _dt(now)
    day_start = current.replace(hour=0, minute=0, second=0, microsecond=0)
    monday = day_start - timedelta(days=current.weekday())
    month_start = day_start.replace(day=1)
    totals = {"daily_r": 0.0, "weekly_r": 0.0, "monthly_r": 0.0}
    for event in realized_events:
        tm = _dt(event.get("time", event.get("exit_time")))
        if tm > current:
            continue
        try:
            r = float(event.get("realized_r", event.get("net_r", event.get("r"))))
        except (TypeError, ValueError):
            raise ValueError("each realized event needs realized_r/net_r/r") from None
        if not isfinite(r):
            raise ValueError("realized R must be finite")
        if tm >= day_start:
            totals["daily_r"] += r
        if tm >= monday:
            totals["weekly_r"] += r
        if tm >= month_start:
            totals["monthly_r"] += r
    pauses = []
    if totals["daily_r"] <= -2:
        pauses.append((day_start + timedelta(days=1), "daily_loss_limit"))
    if totals["weekly_r"] <= -3:
        pauses.append((monday + timedelta(days=7), "weekly_loss_limit"))
    if totals["monthly_r"] <= -2:
        nxt = (month_start.replace(day=28) + timedelta(days=4)).replace(day=1)
        pauses.append((nxt, "monthly_loss_limit"))
    until = max((x[0] for x in pauses), default=None)
    return {"can_trade": not pauses, **totals,
            "paused_until": _iso(until) if until else None,
            "reasons": [reason for _, reason in pauses]}

