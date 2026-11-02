import json
import os
import unittest

from helpers import FIXTURES, read
from lib import gate as G

POLICY = {"include": ["app/"], "scaffold": ["INCIDENT.md", "FIXNOTES.md", ".sre-evidence/"]}
DIFF = read(os.path.join(FIXTURES, "shipped.diff"))
SHIPPED = read(os.path.join(FIXTURES, "verification-shipped.json"))
ARCHIVED = read(os.path.join(FIXTURES, "verification-archived.json"))


def inp(**kw):
    base = {"diff": DIFF, "reverse_applies": True, "reverse_err": "", "changed_files": ["app/service/ExampleSrv.php"],
            "untracked": [], "verification_json": SHIPPED, "extra_secrets": []}
    base.update(kw)
    return base


class GateTest(unittest.TestCase):
    def test_golden_passes_all_four(self):
        r = G.evaluate(inp(), POLICY)
        self.assertTrue(r["passed"], r)
        self.assertEqual([c["name"] for c in r["checks"]],
                         [G.CHECK_PATCH, G.CHECK_SCOPE, G.CHECK_SECRET, G.CHECK_VERIFY, G.CHECK_REPO])
        self.assertIn("未配置", r["checks"][4]["detail"])   # no repo checks configured → loud pass
        self.assertIn("+11/-4", r["checks"][0]["detail"])
        self.assertEqual(r["files"], ["app/service/ExampleSrv.php"])
        self.assertIn("3 项验证全部通过", r["checks"][3]["detail"])

    def test_both_verification_schemas_accepted(self):
        self.assertTrue(G.evaluate(inp(verification_json=ARCHIVED), POLICY)["passed"])

    def test_verification_rejections(self):
        cases = {
            None: "没有产出",
            "{": "不是合法 JSON",
            json.dumps({"checks": [{"name": "a", "passed": True}]}): "缺 all_passed",
            json.dumps({"all_passed": True, "checks": []}): "checks 为空",
            json.dumps({"all_passed": True, "checks": [{"name": "php -l", "passed": False}]}): "验证项未通过：php -l",
            json.dumps({"all_passed": True, "checks": [{"passed": None}]}): "验证项未通过：#1",
            json.dumps({"all_passed": False, "checks": [{"name": "a", "passed": True}]}): "all_passed=false",
        }
        for raw, want in cases.items():
            detail, ok = G.verification_ok(raw)
            self.assertFalse(ok, raw)
            self.assertIn(want, detail)
        r = G.evaluate(inp(verification_json=None), POLICY)
        self.assertEqual(r["fail_class"], G.FAIL_VERIFICATION_FAILED)

    def test_empty_patch(self):
        r = G.evaluate(inp(diff="", changed_files=[]), POLICY)
        self.assertEqual(r["fail_class"], G.FAIL_PATCH_EMPTY)
        self.assertEqual(len(r["checks"]), 5)  # non-short-circuit
        self.assertEqual(r["files"], [])

    def test_not_applicable(self):
        r = G.evaluate(inp(reverse_applies=False, reverse_err="error: patch failed\nmore"), POLICY)
        self.assertEqual(r["fail_class"], G.FAIL_PATCH_NOT_APPLICABLE)
        self.assertIn("patch failed", r["checks"][0]["detail"])

    def test_out_of_scope_and_scaffold(self):
        r = G.evaluate(inp(changed_files=["app/service/ExampleSrv.php", "config/db.php"]), POLICY)
        self.assertEqual(r["fail_class"], G.FAIL_DIFF_OUT_OF_SCOPE)
        self.assertIn("config/db.php", r["reason"])
        r = G.evaluate(inp(changed_files=["app/service/ExampleSrv.php", "FIXNOTES.md"]), POLICY)
        self.assertEqual(r["fail_class"], G.FAIL_SCAFFOLD_TRACKED)
        r = G.evaluate(inp(changed_files=[".sre-evidence/verification.json"]), POLICY)
        self.assertEqual(r["fail_class"], G.FAIL_SCAFFOLD_TRACKED)

    def test_empty_include_rejects_everything(self):
        r = G.evaluate(inp(), {"include": [], "scaffold": POLICY["scaffold"]})
        self.assertEqual(r["fail_class"], G.FAIL_DIFF_OUT_OF_SCOPE)

    def test_in_scope_semantics(self):
        self.assertTrue(G.in_scope("app/x.php", ["app/"]))
        self.assertTrue(G.in_scope("app/x.php", ["app"]))
        self.assertTrue(G.in_scope("app", ["app"]))
        self.assertFalse(G.in_scope("apple/x.php", ["app/"]))
        self.assertFalse(G.in_scope("apple/x.php", ["app"]))
        self.assertTrue(G.in_scope("cli/run.php", ["app/", "cli/"]))

    def test_secret_hits_built_at_runtime(self):
        samples = ["ghp_" + "A" * 36, "AKIA" + "B" * 16, "LTAI" + "c" * 16, "x-access-token:" + "z" * 20 + "@host",
                   "-----BEGIN " + "RSA PRIVATE" + " KEY-----"]
        for s in samples:
            r = G.evaluate(inp(diff=DIFF + "\n+" + s + "\n"), POLICY)
            self.assertEqual(r["fail_class"], G.FAIL_SECRET_HIT, s)
        r = G.evaluate(inp(diff=DIFF + "\n+const X = 'supersecretvalue123';\n", extra_secrets=["supersecretvalue123"]), POLICY)
        self.assertEqual(r["fail_class"], G.FAIL_SECRET_HIT)
        self.assertIn("env-exact-match", r["reason"])

    def test_email_in_source_does_not_trip_secret_check(self):
        r = G.evaluate(inp(diff=DIFF + "\n+// contact: dev@example.invalid\n"), POLICY)
        self.assertTrue(r["checks"][2]["passed"])

    def test_untracked_reported_not_failed(self):
        r = G.evaluate(inp(untracked=["app/service/New.php"]), POLICY)
        self.assertTrue(r["passed"])
        self.assertIn("未纳入提交", r["checks"][1]["detail"])

    def test_diff_size(self):
        self.assertEqual(G.diff_size("--- a\n+++ b\n+x\n+y\n-z\n"), "+2/-1")


if __name__ == "__main__":
    unittest.main()


class RepoChecksTest(unittest.TestCase):
    def _rc(self, *codes, **kw):
        results = [{"cmd": "cmd%d" % i, "code": c, "elapsed_sec": 0.5, "output": kw.get("output", "")}
                   for i, c in enumerate(codes)]
        return {"configured": True, "results": results}

    def test_not_configured_passes_loudly(self):
        r = G.evaluate(inp(repo_checks=None), dict(POLICY, repo_id="demo"))
        c5 = r["checks"][4]
        self.assertTrue(c5["passed"])
        self.assertIn("repos[demo].checks", c5["detail"])
        self.assertTrue(r["passed"])

    def test_all_zero_passes(self):
        r = G.evaluate(inp(repo_checks=self._rc(0, 0)), POLICY)
        self.assertTrue(r["passed"], r)
        self.assertIn("2 条命令全部退出 0", r["checks"][4]["detail"])
        self.assertIn("仓库自检命令", G.gate_summary(r["checks"]))

    def test_nonzero_fails_with_class_and_first_line(self):
        r = G.evaluate(inp(repo_checks=self._rc(0, 1, output="PHP Parse error: x\nmore")), POLICY)
        self.assertFalse(r["passed"])
        self.assertEqual(r["fail_class"], G.FAIL_REPO_CHECK)
        self.assertIn("`cmd1` 退出 1：PHP Parse error: x", r["reason"])
        self.assertEqual(r["files"], [])

    def test_wall_clock_kill_is_named(self):
        r = G.evaluate(inp(repo_checks=self._rc(124)), POLICY)
        self.assertIn("超时被杀", r["checks"][4]["detail"])

    def test_configured_but_no_results_fails(self):
        r = G.evaluate(inp(repo_checks={"configured": True, "results": []}), POLICY)
        self.assertEqual(r["fail_class"], G.FAIL_REPO_CHECK)

    def test_empty_patch_marks_row_unexecuted_but_keeps_patch_empty_class(self):
        r = G.evaluate(inp(diff="", changed_files=[], repo_checks={"configured": True, "results": []}), POLICY)
        self.assertEqual(r["fail_class"], G.FAIL_PATCH_EMPTY)
        self.assertFalse(r["checks"][4]["passed"])
        self.assertIn("补丁为空", r["checks"][4]["detail"])

