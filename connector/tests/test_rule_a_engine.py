# Ported from life-bot/tests/test_rule_a_engine.py. Only change: the engine folder path in the -S subprocess test.
import unittest
from datetime import datetime, timedelta, timezone

from windows_mt5.rule_a_engine import (
    RULE_CONFIG, RULE_ID, add_condition, basket_levels, build_frames,
    evaluate_entry, exit_deadline, plan_entry, portfolio_limits, trailing_level,
)

UTC = timezone.utc


def candles(start, count, tf_seconds, base=1.1, step=0.0001):
    out = []
    for i in range(count):
        t = start + timedelta(seconds=i * tf_seconds)
        c = base + i * step
        o = c - step * 0.1
        out.append({"open_time": t, "close_time": t + timedelta(seconds=tf_seconds),
                    "open": o, "high": max(o, c) + abs(step) * 0.2,
                    "low": min(o, c) - abs(step) * 0.2, "close": c})
    return out


class RuleAEngineTests(unittest.TestCase):
    def test_windows_core_needs_no_timezone_database_or_site_packages(self):
        import os, subprocess, sys
        from pathlib import Path
        source = str(Path(__file__).resolve().parents[1])  # Life OS: engines live in connector/, not windows_mt5/
        command = "import sys;sys.path.insert(0,sys.argv[1]);import rule_a_engine as c;assert c.exit_deadline('2026-10-19T12:00:00Z').isoformat()=='2026-10-19T20:00:00+00:00'"
        result = subprocess.run([sys.executable, "-S", "-c", command, source],
                                env=dict(os.environ, PYTHONTZPATH=""), capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_contract_and_entry_rejects_future_bars(self):
        now = datetime(2025, 1, 10, 12, tzinfo=UTC)
        h1 = candles(now - timedelta(hours=100), 100, 3600)
        h4 = candles(now - timedelta(hours=404), 100, 4 * 3600)
        d1 = candles(now.replace(hour=0) - timedelta(days=100), 100, 86400)
        # Latest H1 is still open at `now`; every result must use the previous close.
        h1.append({"open_time": now.replace(minute=0), "close_time": now.replace(minute=0) + timedelta(hours=1),
                   "open": 1.2, "high": 1.3, "low": 1.1, "close": 1.25})
        result = evaluate_entry("EUR_USD", {"H1": h1, "H4": h4, "D1": d1}, now)
        self.assertEqual(result["strategy_id"], RULE_ID)
        self.assertEqual(result["as_of"], h1[-2]["close_time"].isoformat().replace("+00:00", "Z"))
        self.assertIn(result["state"], ("ready", "watching"))
        self.assertFalse(result["signal"] and result["signal"]["as_of"] > result["as_of"])
        self.assertEqual(RULE_CONFIG["add_max"], 3)

    def test_long_and_short_entry_use_strict_breakout_and_directional_trends(self):
        now = datetime(2025, 6, 1, tzinfo=UTC)

        def directional_case(direction):
            step = 0.0001 * direction
            h1 = candles(now - timedelta(hours=100), 100, 3600, base=1.1, step=step)
            h4 = candles(now - timedelta(hours=400), 100, 4 * 3600, base=1.1, step=step)
            d1 = candles(now - timedelta(days=100), 100, 86400, base=1.1, step=step)
            # A prior range returns to SMA16; the final candle cleanly breaks
            # the three prior highs/lows with body larger than 0.2 ATR.
            closes = [x["close"] for x in h1]
            j = len(h1) - 3
            ma16 = sum(closes[j - 15:j + 1]) / 16
            h1[j]["low"] = min(h1[j]["low"], ma16)
            h1[j]["high"] = max(h1[j]["high"], ma16)
            last = h1[-1]
            last["close"] += 0.0005 * direction
            last["open"] = last["close"] - 0.0003 * direction
            last["high"] = max(last["high"], last["open"], last["close"]) + 0.00002
            last["low"] = min(last["low"], last["open"], last["close"]) - 0.00002
            return evaluate_entry("EUR_USD", {"H1": h1, "H4": h4, "D1": d1}, now)

        long_result = directional_case(1)
        short_result = directional_case(-1)
        self.assertEqual(long_result["direction"], "long")
        self.assertEqual(short_result["direction"], "short")
        self.assertEqual(long_result["state"], "ready", [x for x in long_result["checks"] if not x["passed"]])
        self.assertEqual(short_result["state"], "ready", [x for x in short_result["checks"] if not x["passed"]])

    def test_aggregate_only_complete_contiguous_utc_buckets(self):
        start = datetime(2025, 2, 1, tzinfo=UTC)
        h1 = candles(start, 8, 3600)
        now = start + timedelta(hours=8)
        frames = build_frames(h1, now)
        self.assertEqual(len(frames["H4"]), 2)
        self.assertEqual(frames["H4"][0]["open"], h1[0]["open"])
        # A missing H1 bar invalidates the full H4 aggregate; no synthetic fill.
        gapped = h1[:2] + h1[3:]
        self.assertEqual(len(build_frames(gapped, now)["H4"]), 1)
        self.assertEqual(build_frames(gapped, now)["H4"][0]["open_time"], start + timedelta(hours=4))

    def test_plan_and_basket_keep_risk_and_cost_target(self):
        signal = {"direction": "long", "symbol": "USD_JPY", "raw_stop": 149.0}
        planned = plan_entry(signal, 150.0)
        self.assertAlmostEqual(planned["risk_distance"], 0.5)
        self.assertAlmostEqual(planned["stop"], 149.5)
        self.assertAlmostEqual(planned["target"], 151.548)
        basket = basket_levels("long", 150.2, planned["risk_distance"], "USD_JPY")
        self.assertAlmostEqual(basket["stop"], 149.7)
        self.assertAlmostEqual(basket["target"], 151.748)

    def test_add_condition_uses_closed_m5_and_symbol_pip(self):
        start = datetime(2025, 3, 1, tzinfo=UTC)
        bars = candles(start, 20, 300, base=1.1, step=0.00001)
        # A 21st candle closes ten pips below a stable SMA20.
        t = bars[-1]["close_time"]
        bars.append({"open_time": t, "close_time": t + timedelta(minutes=5), "open": 1.1,
                     "high": 1.1001, "low": 1.0988, "close": 1.0989})
        cutoff = bars[-1]["close_time"]
        self.assertTrue(add_condition("long", bars, cutoff, "EUR_USD"))
        self.assertFalse(add_condition("long", bars, cutoff - timedelta(seconds=1), "EUR_USD"))

    def test_trailing_latches_and_only_tightens(self):
        start = datetime(2025, 4, 1, tzinfo=UTC)
        bars = candles(start, 20, 300, base=1.1, step=0.0001)
        activated = trailing_level("long", bars, 1.1, {"bid": 1.11, "ask": 1.1102}, symbol="EUR_USD")
        self.assertTrue(activated["active"])
        self.assertAlmostEqual(activated["level"], 1.1 + 9.5 * 0.0001 - 0.001)
        # Once active, the flag stays latched even after price falls below activation.
        latched = trailing_level("long", bars, 1.1, {"bid": 1.101, "ask": 1.1012},
                                 active=activated["active"], symbol="EUR_USD", previous_level=activated["level"])
        self.assertTrue(latched["active"])
        self.assertGreaterEqual(latched["level"], activated["level"])

    def test_deadline_exact_flat_boundary_and_portfolio_pause(self):
        exact = datetime(2025, 5, 2, 20, tzinfo=UTC)  # Saturday 05:00 JST
        self.assertEqual(exit_deadline(exact), exact + timedelta(hours=18))
        events = [{"time": "2025-05-05T10:00:00Z", "realized_r": -1.2},
                  {"time": "2025-05-05T11:00:00Z", "realized_r": -0.8}]
        limits = portfolio_limits(events, "2025-05-05T12:00:00Z")
        self.assertFalse(limits["can_trade"])
        self.assertEqual(limits["daily_r"], -2)
        self.assertEqual(limits["paused_until"], "2025-06-01T00:00:00Z")

    def test_duplicate_and_nonfinite_bars_are_rejected(self):
        now = datetime(2025, 6, 1, tzinfo=UTC)
        bar = candles(now - timedelta(hours=1), 1, 3600)[0]
        with self.assertRaisesRegex(ValueError, "duplicate"):
            evaluate_entry("EUR_USD", {"H1": [bar, dict(bar)], "H4": [], "D1": []}, now)
        bad = dict(bar, close=float("nan"))
        with self.assertRaisesRegex(ValueError, "finite"):
            evaluate_entry("EUR_USD", {"H1": [bad], "H4": [], "D1": []}, now)


if __name__ == "__main__":
    unittest.main()
