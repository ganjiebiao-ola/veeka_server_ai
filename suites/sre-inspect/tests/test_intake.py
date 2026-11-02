import os
import unittest

from tests.helpers import FakeGrafana, fixture, make_root, rmtree
from lib import intake, tenant as T, window
from lib.ledger import Ledger

FRM, TO = 1787830000, 1787850000     # 2026-08-27 11:26 .. 17:00 UTC


class ParseTests(unittest.TestCase):
    def test_rfc_to_epoch(self):
        self.assertEqual(intake.rfc_to_epoch("2026-08-27T13:21:30.123456789Z"), 1787836890)
        self.assertEqual(intake.rfc_to_epoch("2026-08-27T21:21:30+08:00"), 1787836890)
        self.assertIsNone(intake.rfc_to_epoch("0001-01-01T00:00:00Z"))
        self.assertIsNone(intake.rfc_to_epoch(""))

    def test_annotation_text(self):
        t, labels, vals = intake.parse_annotation_text("API | 5XX {alertname=API | 5XX, api=/v1/orders, environment=production} - B=3.000000, C=1.000000")
        self.assertEqual(t, "API | 5XX")
        self.assertEqual(labels["api"], "/v1/orders")
        self.assertEqual(vals, "B=3.000000, C=1.000000")
        self.assertEqual(intake.parse_annotation_text("plain")[0], "plain")

    def test_subject(self):
        self.assertEqual(intake.subject_of({"api": "/x", "instance": "h"}, ["instance", "api"]), "h")
        self.assertEqual(intake.subject_of({"api": "/x"}, ["instance", "api"]), "/x")
        self.assertEqual(intake.subject_of({}, ["instance"]), "")


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.subj = T.DEFAULT_SUBJECT_LABELS
        self.rules = fixture("rules.json")
        self.index = {}
        for r in self.rules:
            self.index.setdefault(r["title"], []).append(r["uid"])

    def test_from_am_keeps_active_only(self):
        out = intake.from_am(fixture("am_alerts.json"), FRM, TO, self.subj)
        self.assertEqual([a["subject"] for a in out], ["/v1/orders", "svc.worker", "app-host-004"])
        a = out[0]
        self.assertEqual((a["rule_uid"], a["fingerprint"], a["eval_epoch"]), ("changeme00000001", "a1b2c3d4e5f60718", 1787836890))
        self.assertEqual(a["title"], "API /v1/orders returned `500` 3 times in the last minute")
        self.assertNotIn("__alert_rule_uid__", a["labels"])
        self.assertEqual(a["source"], "alertmanager")

    def test_from_annotations_alerting_only_and_ambiguity(self):
        out = intake.from_annotations(fixture("annotations.json"), self.index, FRM, TO, self.subj)
        names = [a["rule_name"] for a in out]
        self.assertEqual(names, ["API | 5XX", "NSQ | Congested Channel", "DTS | Sync Delay", "Milestone Event", "Duplicate Title"])
        self.assertEqual(out[0]["rule_uid"], "changeme00000001")
        self.assertEqual(out[0]["subject"], "/v1/orders")
        self.assertTrue(out[0]["fingerprint"].startswith("fb-"))
        dup = out[-1]
        self.assertEqual(dup["rule_uid"], "")
        self.assertEqual(dup["ambiguous_uids"], ["dup0000000000001", "dup0000000000002"])
        self.assertIn("instance", out[2]["labels"])

    def test_merge_dedups_and_adopts_fingerprint(self):
        am = intake.from_am(fixture("am_alerts.json"), FRM, TO, self.subj)
        ann = intake.from_annotations(fixture("annotations.json"), self.index, FRM, TO, self.subj)
        merged = intake.merge(am + ann)
        orders = [a for a in merged if a["subject"] == "/v1/orders"]
        self.assertEqual(len(orders), 1)                       # same (rule, subject, second) from both sources
        self.assertEqual(orders[0]["source"], "alertmanager")
        self.assertEqual(len(merged), len(am) + len(ann) - 1)
        self.assertEqual([a["eval_epoch"] for a in merged], sorted([a["eval_epoch"] for a in merged], reverse=True))

    def test_filter(self):
        alerts = intake.from_am(fixture("am_alerts.json"), FRM, TO, self.subj)
        kept, dropped = intake.apply_filter(alerts, {"include_labels": {"environment": ["production"]}, "exclude_labels": {"severity": ["info"]}})
        self.assertEqual([a["subject"] for a in kept], ["/v1/orders"])
        self.assertEqual(sorted(why for _, why in dropped), ["exclude_labels severity=info", "include_labels 未命中"])
        kept, dropped = intake.apply_filter(alerts, {})
        self.assertEqual(len(kept), 3)


class RouteQueueTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.suite = os.path.join(self.root, "suites", "sre-inspect")
        self.t = T.load(self.suite)
        self.routes, _ = T.load_routes(self.suite, self.t)

    def tearDown(self):
        rmtree(self.root)

    def test_route_kinds(self):
        r = intake.route({"rule_uid": "changeme00000001", "title": "x"}, self.routes)
        self.assertEqual((r["action"], r["rid"], r["template"]), ("triage", "R-01", "_template.md"))
        r = intake.route({"rule_uid": "changeme00000002", "title": "DTS | Sync Delay", "labels": {"instance": "[no value]"}}, self.routes)
        self.assertEqual(r["action"], "known_bug")
        r = intake.route({"rule_uid": "changeme00000002", "title": "DTS | Sync Delay", "labels": {"instance": "dts-1"}}, self.routes)
        self.assertEqual(r["action"], "unrouted")            # routed rule without a template and no known_bug hit
        r = intake.route({"rule_uid": "zzz", "title": "x"}, self.routes)
        self.assertEqual(r["action"], "unrouted")
        r = intake.route({"rule_uid": "", "rule_name": "Duplicate Title", "ambiguous_uids": ["a", "b"]}, self.routes)
        self.assertIn("多个 uid", r["reason"])

    def test_clusters_and_refires_are_computed_not_inferred(self):
        base = 1787836890
        def mk(n, subject, eval_epoch, fp=None):
            return {"n": n, "candidate": True, "route": {"action": "triage", "rid": "R-01", "rule_name": "API | 5XX", "template": "_template.md"},
                    "ledger": {}, "alert": {"fingerprint": fp or ("fp-" + subject), "rule_uid": "changeme00000001", "rule_name": "API | 5XX",
                                            "subject": subject, "eval_epoch": eval_epoch, "state": "alerting-transition"}}
        items = [mk(1, "/a", base + 3300, fp="fp-/a"),      # 55 min later re-fire of /a (item 4)
                 mk(2, "/b", base + 5), mk(3, "/c", base + 40), mk(4, "/a", base, fp="fp-/a"),
                 mk(5, "/d", base + 7200)]
        clusters = intake.annotate(items)
        self.assertEqual(len(clusters), 1)
        self.assertEqual(sorted(it["n"] for it in clusters[0]), [2, 3, 4])
        self.assertEqual(items[0]["refire_of"], 4)
        self.assertEqual(items[0]["refire_gap_s"], 3300)
        self.assertNotIn("cluster", items[4])
        tz, name = self.t.tz()
        text = intake.digest(items, [], base - 100, base + 8000, [], tz, name)
        self.assertIn("读法", text)
        self.assertIn("C1：", text)
        self.assertIn("建议先挖 [4]", text)
        self.assertIn("[1] 是 [4] 同指纹在 55m 后的再触发", text)
        self.assertIn("-15m/+15m", text)

    def test_collect_and_queue_and_digest(self):
        g = FakeGrafana()
        alerts, notes = intake.collect(g, self.t, FRM, TO)
        self.assertTrue(any("alertmanager firing=3" in n for n in notes))
        ledger = Ledger(os.path.join(self.root, "runs", "sre-inspect", "ledger.json"), self.t.cooldown, self.t.recurrence)
        items, dropped = intake.build_queue(alerts, self.routes, ledger, self.t)
        cands = [it for it in items if it["candidate"]]
        self.assertEqual([c["alert"]["subject"] for c in cands], ["/v1/orders"])       # ECS staging dropped by filter; NSQ/dup unrouted; DTS known_bug
        kinds = sorted(it["route"]["action"] for it in items)
        self.assertEqual(kinds, ["known_bug", "triage", "unrouted", "unrouted"])
        tz, name = self.t.tz()
        text = intake.digest(items, dropped, FRM, TO, notes, tz, name)
        self.assertIn("候选 1 件", text)
        self.assertIn("] R-01 API | 5XX | /v1/orders | 08-27 21:21:30 (firing) | 模板 _template.md", text)
        self.assertIn("unrouted", text)
        self.assertIn("known_bug", text)
        # a registered incident within cooldown becomes suppressed on the next intake
        ledger.register(cands[0]["alert"], "INC-X")
        items2, _ = intake.build_queue(alerts, self.routes, ledger, self.t)
        sup = [it for it in items2 if it["ledger"].get("suppress")]
        self.assertEqual(len(sup), 1)
        self.assertFalse(any(it["candidate"] for it in items2))


if __name__ == "__main__":
    unittest.main()
