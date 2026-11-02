import json
import os
import unittest

from tests.helpers import SUITE, fixture, make_root, read, rmtree, write
from lib import deploys, inspect_md, report, tenant as T, window
from lib.common import Result, SuiteError, EXIT_BLOCKED, EXIT_FAILED

ALERT = {"fingerprint": "a1b2c3d4e5f60718", "fingerprint_source": "grafana", "rule_uid": "changeme00000001", "rule_name": "API | 5XX",
         "title": "API /v1/orders returned 500", "subject": "/v1/orders", "eval_epoch": 1787836890, "window_sec": 60,
         "labels": {"api": "/v1/orders", "severity": "critical"}, "annotations": {"summary": "s"}, "links": {"generator": "https://g/x"},
         "state": "firing", "source": "alertmanager"}
ROUTE = {"action": "triage", "rid": "R-01", "rule_name": "API | 5XX", "layer": "L2", "template": "_template.md", "reason": "r"}


class DeployTests(unittest.TestCase):
    def runner_ok(self, argv):
        self.argv = argv
        return Result(json.dumps(fixture("gh_runs.json")), "", 0, 0.1)

    def test_filters_workflow_and_window(self):
        cfg = [{"repo": "example-org/example-service", "workflow": "production deploy"}]
        ev, note = deploys.fetch(cfg, 1787800000, 1787850000, runner=self.runner_ok)
        self.assertEqual(note, "")
        self.assertEqual([e["short_sha"] for e in ev], ["6904298a053a"])
        self.assertEqual(ev[0]["completed_utc"], "2026-08-27T03:14:43Z")
        self.assertIn("repos/example-org/example-service/actions/runs?", self.argv[2])
        self.assertIn("created=>=2026-08-27", self.argv[2])

    def test_unconfigured_and_errors(self):
        ev, note = deploys.fetch([], 0, 1)
        self.assertIsNone(ev)
        self.assertIn("未配置", note)
        ev, note = deploys.fetch([{"repo": "o/r", "workflow": "w"}], 0, 1, runner=lambda a: Result("", "gh: not logged in", 1, 0))
        self.assertEqual(ev, [])
        self.assertIn("gh api 退出 1", note)


class DiscoverTests(unittest.TestCase):
    def test_rules_marks_routed_and_drafts_stanzas(self):
        from lib import discover
        from tests.helpers import FakeGrafana
        root = make_root(); suite = os.path.join(root, "suites", "sre-inspect")
        try:
            t = T.load(suite); routes, _ = T.load_routes(suite, t)
            rows, snippet = discover.rules(FakeGrafana(), routes)
            by = {r["uid"]: r for r in rows}
            self.assertTrue(by["changeme00000001"]["routed"])
            self.assertFalse(by["nsq0000000000001"]["routed"])
            self.assertEqual(by["changeme00000001"]["datasource_uids"], ["dssls000000001"])
            self.assertIn("rule_uid: nsq0000000000001", snippet)
            self.assertNotIn("rule_uid: changeme00000001", snippet)
            text = discover.format_rules(rows, snippet, {"dssls000000001": "log_nginx_access"})
            self.assertIn("log_nginx_access", text)
        finally:
            rmtree(root)

    def test_deploys_picks_the_deploy_workflow(self):
        from lib import discover
        wfs = {"workflows": [{"name": "Lint", "state": "active", "path": ".github/workflows/lint.yml"},
                             {"name": "Production Build and Deploy", "state": "active", "path": ".github/workflows/production_build.yml"},
                             {"name": "Old Deploy", "state": "disabled_manually", "path": ".github/workflows/old.yml"},
                             {"name": "Copilot", "state": "active", "path": "dynamic/copilot"}]}
        runs = {"workflow_runs": [{"name": "Production Build and Deploy", "event": "workflow_dispatch", "updated_at": "2026-08-31T04:55:38Z"},
                                  {"name": "Lint", "event": "pull_request", "updated_at": "2026-08-31T04:49:02Z"}]}
        def runner(argv):
            return Result(json.dumps(wfs if "workflows" in argv[2] else runs), "", 0, 0.1)
        d = discover.deploys("example-org/example-service", runner=runner, now=1788200000)
        self.assertEqual(d["candidates"], ["Production Build and Deploy"])
        self.assertIn('workflow: "Production Build and Deploy"', d["snippet"])
        names = [w["name"] for w in d["workflows"]]
        self.assertNotIn("Copilot", names)
        self.assertEqual([w for w in d["workflows"] if w["name"] == "Production Build and Deploy"][0]["success_runs"], 1)
        self.assertIn("* \tProduction Build and Deploy", discover.format_deploys("example-org/example-service", d).replace("*\t", "* \t"))
        d2 = discover.deploys("example-org/x", runner=lambda a: Result("", "HTTP 404", 1, 0.1))
        self.assertIn("failed", d2["note"])


class InspectMdTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.suite = os.path.join(self.root, "suites", "sre-inspect")
        self.t = T.load(self.suite)
        tz, name = self.t.tz()
        self.facts = window.facts(ALERT["eval_epoch"], "15m", "15m", tz, name, 60)

    def tearDown(self):
        rmtree(self.root)

    def test_render_fills_placeholders_and_blocks(self):
        tmpl = read(os.path.join(self.suite, "triage", "_template.md")) + "\n{{unknown_thing}}"
        ev = [{"repo": "example-org/example-service", "short_sha": "6904298a053a", "title": "Production Deploy", "branch": "main",
               "completed_epoch": 1787801683, "completed_utc": "2026-08-27T03:14:43Z"}]
        md = inspect_md.render("INC-1", ALERT, ROUTE, self.facts, tmpl, ev, "", self.t, ["grafana-sls"])
        self.assertIn("rule_uid changeme00000001", md)
        self.assertIn("在窗 %d–%d 内" % (self.facts["from_epoch"], self.facts["to_epoch"]), md)
        self.assertIn("{{unknown_thing}}", md)
        self.assertIn("未识别的占位符", md)
        self.assertIn("| 1 | 2026-08-27T03:14:43Z | 1787801683 | example-org/example-service@6904298a053a |", md)
        self.assertIn("run finish INC-1", md)
        self.assertIn("不要自行换算时区", md)
        self.assertIn("alerting_manage_rules", md)
        md2 = inspect_md.render("INC-2", ALERT, dict(ROUTE, template=""), self.facts, "", None, "tenant.yaml 未配置 deploys[]", self.t, [])
        self.assertIn("未接入", md2)
        self.assertIn("unrouted", md2)
        md3 = inspect_md.render("INC-3", ALERT, ROUTE, self.facts, "x", [], "", self.t, [])
        self.assertIn("窗内无发布完成事件", md3)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.suite = os.path.join(self.root, "suites", "sre-inspect")
        self.t = T.load(self.suite)
        tz, name = self.t.tz()
        self.facts = window.facts(ALERT["eval_epoch"], "15m", "15m", tz, name, 60)
        self.inc = os.path.join(self.root, "runs", "sre-inspect", "INC-1")
        os.makedirs(self.inc)

    def tearDown(self):
        rmtree(self.root)

    def filled(self, **over):
        rep = report.skeleton("INC-1", ALERT, ROUTE, self.facts, self.t)
        rep["verdict"].update({"value": "FAIL", "summary": "5xx real"})
        rep["root_cause"].update({"statement": "php-fpm worker closed the FastCGI connection during rolling reload; nginx returned 502",
                                  "confidence": "high", "cause_locus": "infra", "severity": "medium"})
        rep["evidence"].append({"claim": "2 rows status=500", "tool": "sls_query", "query": "status >= 500 | select count(*)", "time_window": "x"})
        rep.update(over)
        return rep

    def test_skeleton_is_incomplete_until_filled(self):
        rep = report.skeleton("INC-1", ALERT, ROUTE, self.facts, self.t)
        self.assertEqual(rep["report_version"], "1.1")
        self.assertEqual(rep["incident"]["rid"], "R-01")
        self.assertTrue(report.validate(rep, "INC-1"))
        self.assertEqual(report.validate(self.filled(), "INC-1"), [])
        bad = self.filled()
        bad["root_cause"]["cause_locus"] = "code_defect"
        self.assertTrue(any("cause_locus_basis" in p for p in report.validate(bad, "INC-1")))
        bad = self.filled(suspect_change="justtext")
        self.assertTrue(any("suspect_change" in p for p in report.validate(bad, "INC-1")))
        p = self.filled()
        p["verdict"] = {"value": "PASS", "summary": ""}
        self.assertTrue(any("verdict.summary" in x for x in report.validate(p, "INC-1")))

    def test_finish_validates_scrubs_and_sets_state(self):
        write(os.path.join(self.inc, "report.json"), json.dumps(self.filled()))
        write(os.path.join(self.inc, "rca.md"), "# rca\n\n" + "x" * 60 + "\ncontact ops@example.com for uid=1234567\n")
        rep, findings = report.finish(self.inc, self.root)
        self.assertEqual(rep["status"]["state"], "ROOT_CAUSED")
        self.assertFalse(rep["scrub"]["egress_blocked"])
        self.assertTrue(any(f["kind"] == "pii" for f in findings))
        self.assertNotIn("ops@example.com", read(os.path.join(self.inc, "rca.md")))

    def test_finish_blocks_on_secret(self):
        rep = self.filled()
        rep["evidence"][0]["query"] = "curl -H 'Authorization: Bearer glsa_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'"
        write(os.path.join(self.inc, "report.json"), json.dumps(rep))
        write(os.path.join(self.inc, "rca.md"), "# rca\n" + "y" * 80)
        with self.assertRaises(SuiteError) as cm:
            report.finish(self.inc, self.root)
        self.assertEqual(cm.exception.code, EXIT_BLOCKED)
        self.assertTrue(json.loads(read(os.path.join(self.inc, "report.json")))["scrub"]["egress_blocked"])

    def test_finish_rejects_contract_violations(self):
        write(os.path.join(self.inc, "report.json"), json.dumps(report.skeleton("INC-1", ALERT, ROUTE, self.facts, self.t)))
        write(os.path.join(self.inc, "rca.md"), "z" * 80)
        with self.assertRaises(SuiteError) as cm:
            report.finish(self.inc, self.root)
        self.assertEqual(cm.exception.code, EXIT_FAILED)
        self.assertIn("verdict.value", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
