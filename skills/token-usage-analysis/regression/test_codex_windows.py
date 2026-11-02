"""Codex cumulative counters must be attributed to their event-time window."""
import importlib.util
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from datetime import date

ROOT = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[3]
loader = SourceFileLoader("codex_window_report", str(ROOT / "scripts/token-usage-report"))
spec = importlib.util.spec_from_loader(loader.name, loader)
report = importlib.util.module_from_spec(spec)
loader.exec_module(report)


class CodexWindows(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.previous_tz = os.environ.get("TZ")
        self.addCleanup(self.restore_timezone)
        os.environ["TZ"] = "Asia/Singapore"
        time.tzset()

    def restore_timezone(self):
        if self.previous_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = self.previous_tz
        time.tzset()

    def session(self, events, started="2026-08-16T15:00:00Z"):
        rows = [{"type": "session_meta", "timestamp": started,
                 "payload": {"cwd": "/fake/ws", "timestamp": started}}]
        for timestamp, inp, cached, out in events:
            rows.append({"type": "event_msg", "timestamp": timestamp,
                         "payload": {"type": "token_count", "info": {"total_token_usage": {
                             "input_tokens": inp, "cached_input_tokens": cached,
                             "output_tokens": out, "reasoning_output_tokens": 0}}}})
        (Path(self.tmp.name) / "rollout-2026-08-16T15-00-00-fixture.jsonl").write_text(
            "\n".join(json.dumps(row) for row in rows), encoding="utf-8")

    def collect(self, since, until):
        return report.collect_codex(self.tmp.name, date.fromisoformat(since), date.fromisoformat(until),
                                    "/fake/ws", [], False)[0]

    def test_cross_week_deltas_and_full_window_conserve_tokens(self):
        self.session([("2026-08-16T15:30:00Z", 100, 20, 10),
                      ("2026-08-16T16:30:00Z", 300, 60, 30)])
        for since, until, expected in [("2026-08-10", "2026-08-16", (100, 20, 10)),
                                       ("2026-08-17", "2026-08-23", (200, 40, 20)),
                                       ("2026-08-10", "2026-08-23", (300, 60, 30))]:
            with self.subTest(since=since, until=until):
                result = self.collect(since, until)
                self.assertIsNotNone(result)
                self.assertEqual(tuple(result["totals"][k] for k in ("input", "cached_input", "output")), expected)
                self.assertEqual(result["totals"]["sessions"], 1)
                self.assertEqual(result["by_bucket"]["workspace"]["input"], expected[0])

    def test_declared_timezone_controls_the_boundary(self):
        self.session([("2026-08-16T15:30:00Z", 100, 20, 10),
                      ("2026-08-16T16:30:00Z", 300, 60, 30)])
        os.environ["TZ"] = "UTC"
        time.tzset()
        self.assertEqual(self.collect("2026-08-10", "2026-08-16")["totals"]["input"], 300)
        self.assertIsNone(self.collect("2026-08-17", "2026-08-23"))

    def test_repeated_counter_in_next_week_is_not_new_usage(self):
        self.session([("2026-08-16T15:30:00Z", 100, 20, 10),
                      ("2026-08-16T16:30:00Z", 100, 20, 10)])
        self.assertIsNone(self.collect("2026-08-17", "2026-08-23"))

    def test_resumed_old_file_contributes_only_in_window_delta(self):
        self.session([("2026-08-16T15:30:00Z", 100, 20, 10),
                      ("2026-09-01T01:00:00Z", 400, 80, 40)])
        result = self.collect("2026-09-01", "2026-09-01")
        self.assertIsNotNone(result)
        self.assertEqual(result["totals"]["input"], 300)

    def test_counter_reset_starts_a_new_increment(self):
        self.session([("2026-08-16T15:30:00Z", 100, 20, 10),
                      ("2026-08-16T16:30:00Z", 20, 5, 2)])
        result = self.collect("2026-08-17", "2026-08-23")
        self.assertIsNotNone(result)
        self.assertEqual(result["totals"]["input"], 20)

    def test_missing_timestamp_is_not_assigned_to_session_start(self):
        self.session([(None, 100, 20, 10), ("2026-08-16T16:30:00Z", 300, 60, 30)])
        self.assertIsNone(self.collect("2026-08-10", "2026-08-16"))
        self.assertEqual(self.collect("2026-08-17", "2026-08-23")["totals"]["input"], 200)


if __name__ == "__main__":
    unittest.main()
