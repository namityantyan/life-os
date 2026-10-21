"""Shared MT5 helpers copied verbatim from the previous Windows connector (windows_mt5/connector.py).

Only the helpers the strategy agents import live here (field_value, iso_utc, account_reference, …) plus the
broker-symbol resolver. LOGICAL_SYMBOLS is restricted to the seven traded pairs (the old file also listed
EUR_AUD / GBP_AUD reference quotes, which Life OS does not trade).
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timezone
from typing import Any, Mapping

UTC = timezone.utc
LOGICAL_SYMBOLS = ("USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_USD", "GBP_USD", "AUD_USD")


class ConnectorError(RuntimeError):
    """An operational error safe to show without secret values."""

def utc_now() -> datetime:
    return datetime.now(UTC)


def iso_utc(value: datetime | int | float) -> str:
    if not isinstance(value, datetime):
        value = datetime.fromtimestamp(float(value), UTC)
    if value.tzinfo is None or value.utcoffset() is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def parse_utc(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(UTC)


def finite(value: Any, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ConnectorError(f"MT5の{label}が数値ではありません") from exc
    if not math.isfinite(number):
        raise ConnectorError(f"MT5の{label}が有限値ではありません")
    return number


def optional_price(value: Any) -> float | None:
    number = finite(value, "価格")
    return None if number == 0 else number


def decimal_id(value: Any, label: str) -> str:
    text = str(value)
    if not text.isdecimal():
        raise ConnectorError(f"MT5の{label}が数字ではありません")
    return text


def field_value(record: Any, name: str, default: Any = None) -> Any:
    if isinstance(record, Mapping):
        return record.get(name, default)
    # copy_rates_from_pos returns rows from a NumPy structured array.  A row is
    # np.void rather than Mapping, and exposes columns through item lookup.
    dtype = getattr(record, "dtype", None)
    names = getattr(dtype, "names", None)
    if names and name in names:
        return record[name]
    return getattr(record, name, default)


def account_reference(server: str, login: str) -> str:
    return hashlib.sha256(f"{server}|{login}".encode("utf-8")).hexdigest()



def _currency_pair(logical: str) -> tuple[str, str]:
    base, profit = logical.split("_", 1)
    return base, profit


def resolve_symbols(
    mt5: Any, configured: Mapping[str, str]
) -> dict[str, str]:
    symbols = mt5.symbols_get()
    if symbols is None:
        raise ConnectorError("MT5の銘柄一覧を取得できません")
    by_name = {str(field_value(item, "name")): item for item in symbols}
    resolved: dict[str, str] = {}
    for logical in LOGICAL_SYMBOLS:
        base, profit = _currency_pair(logical)
        explicit = configured.get(logical)
        if explicit:
            item = by_name.get(explicit)
            if item is None:
                raise ConnectorError(f"{logical}の指定銘柄がMT5にありません")
            if (
                str(field_value(item, "currency_base", "")).upper() != base
                or str(field_value(item, "currency_profit", "")).upper() != profit
            ):
                raise ConnectorError(f"{logical}の指定銘柄の通貨が一致しません")
            resolved[logical] = explicit
            continue
        candidates = [
            str(field_value(item, "name"))
            for item in symbols
            if str(field_value(item, "currency_base", "")).upper() == base
            and str(field_value(item, "currency_profit", "")).upper() == profit
            and not bool(field_value(item, "custom", False))
        ]
        if len(candidates) != 1:
            detail = "見つかりません" if not candidates else "複数あります"
            choices = (
                ""
                if not candidates
                else f" 候補: {', '.join(sorted(candidates)[:12])}。"
            )
            raise ConnectorError(
                f"{logical}に対応するXM銘柄が{detail}。{choices}"
                "lifeos_connector.ini の SYMBOL_MAP で指定してください"
            )
        resolved[logical] = candidates[0]
    if len(set(resolved.values())) != len(resolved):
        raise ConnectorError("複数の通貨ペアに同じXM銘柄が指定されています")
    return resolved



def load_mt5_module() -> Any:
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError as exc:
        raise ConnectorError(
            "MetaTrader5 Pythonパッケージがありません。install.bat を実行してください"
        ) from exc
    return mt5
