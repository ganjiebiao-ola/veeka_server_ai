import os
import tempfile
import unittest

from tests.helpers import rmtree  # noqa: F401
from lib import window
from lib.ledger import Ledger


class WindowTests(unittest.TestCase):
    def test_parse_at_forms(self):
        self.assertEqual(window.parse_at("1787836890"), 1787836890)
        self.assertEqual(window.parse_at("1787836890000"), 1787836890)
        self.assertEqual(window.parse_at("2026-08-27T13:21:30Z"), 1787836890)
        self.assertEqual(window.parse_at("now-1h", now=3600), 0)
        from lib.common import SuiteError
        with self.assertRaises(SuiteError):
            window.parse_at("noon")

    def test_facts_and_block(self):
        tz, name = window.tz_from("Asia/Singapore")
        f = window.facts(1787836890, "15m", "10m", tz, name, 60)
        self.assertEqual((f["from_epoch"], f["to_epoch"]), (1787836890 - 900, 1787836890 + 600))
        self.assertEqual(f["eval_utc"], "2026-08-27T13:21:30Z")
        if name == "Asia/Singapore":
            self.assertEqual(f["eval_local"], "2026-08-27 21:21:30")
        b = window.block(f)
        self.assertIn("from=%d to=%d" % (f["from_epoch"], f["to_epoch"]), b)
        self.assertIn("不要自行换算时区", b)
        self.assertIn("2026-08-27T13:06:30Z", b)

    def test_tz_fixed_offset_and_fallback(self):
        tz, name = window.tz_from("+08:00")
        self.assertEqual(name, "UTC+08:00")
        self.assertEqual(window.facts(0, "0s", "0s", tz, name)["eval_local"], "1970-01-01 08:00:00")
        _, name = window.tz_from("Not/AZone")
        self.assertIn("unavailable", name)


class LedgerTests(unittest.TestCase):
    """Port of ola-sre-agent intake_test.go TestSuppressorCooldown / TestSuppressorPersists."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "ledger.json")

    def tearDown(self):
        rmtree(self.dir)

    def test_cooldown_then_recurrence(self):
        s = Ledger(self.path, 30 * 60, 14 * 86400)
        base = 1787836890
        a = {"fingerprint": "fp1", "rule_uid": "r1", "subject": "svc", "eval_epoch": base}
        self.assertFalse(s.check(a)["suppress"])
        s.register(a, "INC-1")
        within = dict(a, eval_epoch=base + 600)
        d = s.check(within)
        self.assertTrue(d["suppress"] and d["active_incident"] == "INC-1" and d["occurrence"] == 2, d)
        later = dict(a, eval_epoch=base + 3600)
        self.assertFalse(s.check(later)["suppress"])
        s.close("fp1")
        rec = dict(a, eval_epoch=base + 7200)
        d = s.check(rec)
        self.assertTrue(d["recurred"] and d["active_incident"] == "INC-1", d)
        far = dict(a, eval_epoch=base + 15 * 86400)
        self.assertFalse(s.check(far)["recurred"])

    def test_persists_across_restart(self):
        s1 = Ledger(self.path, 1800, 3600)
        base = 1787836890
        a = {"fingerprint": "fp2", "eval_epoch": base}
        s1.register(a, "INC-9")
        s2 = Ledger(self.path, 1800, 3600)
        d = s2.check(dict(a, eval_epoch=base + 60))
        self.assertTrue(d["suppress"] and d["active_incident"] == "INC-9", d)

    def test_peek_does_not_count(self):
        s = Ledger(self.path, 1800, 3600)
        a = {"fingerprint": "fp3", "eval_epoch": 100}
        s.register(a, "INC-3")
        s.peek(dict(a, eval_epoch=160))
        s.peek(dict(a, eval_epoch=170))
        self.assertEqual(s.entries["fp3"]["occurrences"], 1)
        self.assertEqual(s.check(dict(a, eval_epoch=180))["occurrence"], 2)

    def test_negative_gap_is_absolute(self):
        s = Ledger(self.path, 1800, 3600)
        a = {"fingerprint": "fp4", "eval_epoch": 10000}
        s.register(a, "INC-4")
        self.assertTrue(s.check(dict(a, eval_epoch=9500))["suppress"])


if __name__ == "__main__":
    unittest.main()
