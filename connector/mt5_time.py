"""Explicit MT5 timestamp basis conversion, without host timezone dependencies.

MetaTrader's integer timestamps may encode a broker wall clock as though it
were UTC.  XM's European clock is UTC+2 in winter and UTC+3 in summer; the
change occurs at 01:00 UTC on the last Sunday of March and October.
"""

from __future__ import annotations

import calendar
import math
from datetime import datetime, timedelta, timezone


UTC = timezone.utc
TIME_BASES = frozenset({"utc", "xm_europe"})


class MT5TimeError(ValueError):
    """The configured source clock cannot identify one UTC instant."""


def validate_time_basis(value: str) -> str:
    if not isinstance(value, str) or value not in TIME_BASES:
        raise MT5TimeError("time_basisはutcまたはxm_europeを指定してください")
    return value


def _last_sunday(year: int, month: int) -> int:
    last_day = calendar.monthrange(year, month)[1]
    return last_day - (datetime(year, month, last_day).weekday() + 1) % 7


def _transition(year: int, month: int) -> datetime:
    return datetime(year, month, _last_sunday(year, month), 1, tzinfo=UTC)


def _offset_at_utc(instant: datetime) -> timedelta:
    instant = instant.astimezone(UTC)
    return timedelta(hours=3 if _transition(instant.year, 3) <= instant < _transition(instant.year, 10) else 2)


def source_to_utc(raw_epoch: int | float, basis: str = "utc") -> datetime:
    """Interpret a raw MT5 epoch as UTC or as a broker wall-clock epoch."""
    validate_time_basis(basis)
    try:
        raw = float(raw_epoch)
        if not math.isfinite(raw):
            raise ValueError("nonfinite source timestamp")
        wall = datetime.fromtimestamp(raw, UTC)
    except (TypeError, ValueError, OverflowError, OSError) as exc:
        raise MT5TimeError("MT5の時刻が不正です") from exc
    if basis == "utc":
        return wall
    candidates = [wall - offset for offset in (timedelta(hours=2), timedelta(hours=3))]
    matching = [candidate for candidate in candidates
                if candidate + _offset_at_utc(candidate) == wall]
    if len(matching) != 1:
        raise MT5TimeError("XMの夏時間切替時刻が重複または存在せず、UTC時刻を特定できません")
    return matching[0]


def utc_to_source(instant: datetime, basis: str = "utc") -> datetime:
    """Represent a UTC query bound in MT5's raw pseudo-UTC date domain."""
    validate_time_basis(basis)
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise MT5TimeError("UTCの時刻にタイムゾーンがありません")
    instant = instant.astimezone(UTC)
    return instant if basis == "utc" else instant + _offset_at_utc(instant)


def history_query_bounds(start: datetime, end: datetime, basis: str = "utc") -> tuple[datetime, datetime]:
    """Cover both sides of any clock change; callers filter results in UTC."""
    validate_time_basis(basis)
    if start.tzinfo is None or end.tzinfo is None or start > end:
        raise MT5TimeError("取引履歴の検索期間が不正です")
    start, end = start.astimezone(UTC), end.astimezone(UTC)
    if basis == "utc":
        return start, end
    points = [start, end]
    for year in range(start.year, end.year + 1):
        for month in (3, 10):
            change = _transition(year, month)
            if start < change < end:
                points.extend((change - timedelta(microseconds=1), change))
    source = [utc_to_source(point, basis) for point in points]
    return min(source), max(source)
