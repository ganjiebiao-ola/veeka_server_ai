import os
import unittest

from helpers import FIXTURES, TempDir, assemble_archive
from lib import eligibility as E
from lib import inputs

FILES = {"r1": ["app/service/ExampleSrv.php", "README.md"], "r2": ["src/other.go"]}


def find(repo, base):
    return [f for f in FILES.get(repo, []) if os.path.basename(f) == base]


def load(draft="draft-code-defect.json"):
    with TempDir() as tmp:
        inc, _, _ = inputs.load(assemble_archive(tmp, draft))
    return inc


class EligibilityTest(unittest.TestCase):
    def names(self, el):
        return [r["name"] for r in el["reasons"]]

    def test_code_defect_passes_with_five_reasons(self):
        el = E.check(load(), "medium", ["r1", "r2"], find)
        self.assertTrue(el["passed"], el)
        self.assertEqual(self.names(el), ["置信度达标", "根因归属=代码缺陷", "非重复件", "预算预留充足", "修复目标可定位"])
        self.assertEqual(el["repo"], "r1")
        self.assertEqual(el["files"], ["app/service/ExampleSrv.php"])

    def test_legacy_locus_passes_with_trace(self):
        el = E.check(load("draft-legacy.json"), "medium", ["r1"], find)
        self.assertTrue(el["passed"])
        self.assertIn("08-19", el["reasons"][1]["detail"])

    def test_dependency_failure_parks(self):
        el = E.check(load("draft-dependency.json"), "medium", ["r1"], find)
        self.assertFalse(el["passed"])
        self.assertTrue(el["blocked_reason"].startswith("根因归属=代码缺陷"))
        self.assertEqual(len(el["reasons"]), 5)  # non-short-circuit

    def test_low_confidence_parks(self):
        inc = load()
        inc.draft["confidence"] = "low"
        el = E.check(inc, "medium", ["r1"], find)
        self.assertFalse(el["passed"])
        self.assertIn("low < medium", el["reasons"][0]["detail"])
        el2 = E.check(inc, "low", ["r1"], find)
        self.assertTrue(el2["passed"])

    def test_no_source_file_named(self):
        inc = load()
        inc.draft["root_cause_statement"] = "接口超时"
        inc.draft["suggested_fix"] = "查上游"
        el = E.check(inc, "medium", ["r1"], find)
        self.assertFalse(el["passed"])
        self.assertIn("没有点名任何源文件", el["blocked_reason"])

    def test_unreachable_and_ambiguous(self):
        inc = load()
        self.assertFalse(E.check(inc, "medium", ["r2"], find)["passed"])
        both = {"a": ["x/ExampleSrv.php"], "b": ["y/ExampleSrv.php"]}
        el = E.check(inc, "medium", ["a", "b"], lambda r, bn: [f for f in both[r] if f.endswith(bn)])
        self.assertFalse(el["passed"])
        self.assertIn("多个", el["blocked_reason"])

    def test_no_repos_configured(self):
        el = E.check(load(), "medium", [], find)
        self.assertIn("TODO(owner)", el["blocked_reason"])

    def test_duplicate_without_local_pr_passes_with_note(self):
        inc = load()
        inc.draft["duplicate_of"] = "INC-20250101-000000-00000000"
        el = E.check(inc, "medium", ["r1"], find)
        self.assertTrue(el["passed"])
        self.assertIn("PR 正文应注明前次出现", el["reasons"][2]["detail"])

    def test_duplicate_with_local_pr_parks(self):
        inc = load()
        inc.draft["duplicate_of"] = "INC-20250101-000000-00000000"
        el = E.check(inc, "medium", ["r1"], find, dup_pr={"url": "https://example.invalid/pr/1", "state": "open"})
        self.assertFalse(el["passed"])
        self.assertIn("已为它开过 PR", el["blocked_reason"])

    def test_budget_always_ok(self):
        el = E.check(load("draft-dependency.json"), "medium", ["r1"], find)
        self.assertTrue(el["reasons"][3]["ok"])

    def test_forced_files(self):
        inc = load()
        el = E.check(inc, "medium", ["r1"], find, forced_files=["README.md"], forced_repo="r1")
        self.assertTrue(el["passed"])
        self.assertEqual(el["files"], ["README.md"])
        el = E.check(inc, "medium", ["r1"], find, forced_files=["nope.php"], forced_repo="r1")
        self.assertFalse(el["passed"])

    def test_source_candidates_order_and_dedupe(self):
        c = E.source_candidates("ExampleSrv.php:21 与 RoomController.php(11089) 见 ExampleSrv.php",
                                "版本 1.0 与 config.json 无关；见 handler.go:137")
        self.assertEqual(c, ["ExampleSrv.php", "RoomController.php", "handler.go"])

    def test_render_table(self):
        el = E.check(load(), "medium", ["r1"], find)
        t = E.render_table(el)
        self.assertIn("| 置信度达标 | ✅ |", t)
        self.assertIn("目标：r1", t)


if __name__ == "__main__":
    unittest.main()
