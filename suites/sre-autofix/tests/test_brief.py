import os
import unittest

from helpers import FIXTURES, REAL_ROOT, TempDir, assemble_archive, make_temp_repo, read
from lib import brief as B
from lib import inputs
from lib.workspace import Worktree

BANNED = ["mustLogin", "mustGetCurrentUser", "InfoProvider", "BlindBox", "getCurrentUser", "pt-oversea", "olachat",
          "authcode", "BbcStrategy", "live_pk", "config_db", "getLevelsByTaskID", "pingMysql", "onPing",
          "readonly_config", "LivePk", "DbEventListener", "giftConfigV2", "IsBlindBoxEnabled", "RpcBlindBox",
          "GetUserFeatureFlag", "pt-app.private"]
V3 = ["不构成实现约束", "既有防线", "优先以最小改动接入", "留下可观测痕迹", "不反噬主路径", "同构位点（任务 8", "既有防线普查结果（任务 4"]
V4 = ["不是本代码的 bug", "传播路径", "产品决策", "不是**验收目标"]


def neutral_incident():
    inc = inputs.Incident()
    inc.id = "INC-N"
    inc.report_md = "中性报告正文"
    return inc


class ContractTest(unittest.TestCase):
    def test_contract_loads_from_skill(self):
        c = B.load_contract(REAL_ROOT)
        self.assertTrue(c.startswith("## 环境约束"))
        self.assertIn("## 任务", c)
        self.assertIn("## 产出契约", c)
        self.assertNotIn(B.CONTRACT_BEGIN, c)


class RenderTest(unittest.TestCase):
    def setUp(self):
        self.contract = B.load_contract(REAL_ROOT)
        self.el = {"repo": "org/repo", "files": ["src/handler.ext"]}

    def test_generic_brief_has_no_project_nouns(self):
        md = B.render(neutral_incident(), self.el, "org/repo", self.contract)
        for b in BANNED:
            self.assertNotIn(b, md, b)

    def test_contract_anchors(self):
        md = B.render(neutral_incident(), self.el, "org/repo", self.contract)
        for w in V3 + V4:
            self.assertIn(w, md, w)
        for w in ["# INCIDENT INC-N", "## 告警", "## 根因结论、证据与影响", "中性报告正文", "## 修复目标",
                  "`src/handler.ext`", "## 环境事实", "## 环境约束", "## 任务", "\n1. ", "\n10. ", "\n6b. ",
                  "## 产出契约", "FIXNOTES.md", ".sre-evidence/verification.json", "not_verified", "改了什么"]:
            self.assertIn(w, md, w)
        self.assertNotIn("人工评审意见", md)
        self.assertNotIn("上一轮为什么失败", md)

    def test_review_and_retry_sections(self):
        md = B.render(neutral_incident(), self.el, "org/repo", self.contract, review="改错地方了\n第二行",
                      last_fail={"fail_class": "diff_out_of_scope", "reason": "越界"}, attempt_n=2)
        self.assertIn("## 人工评审意见（必须遵照", md)
        self.assertIn("> 改错地方了\n> 第二行", md)
        self.assertIn("## 上一轮为什么失败（这是第 2 次尝试）", md)
        self.assertIn("`diff_out_of_scope`", md)

    def test_runtime_and_style_facts(self):
        md = B.render(neutral_incident(), self.el, "org/repo", self.contract, runtime_note="PHP 7.2（依据 x）",
                      style_note="`a.php` 缩进=tab、结尾换行=无")
        self.assertIn("目标运行时版本：PHP 7.2（依据 x）", md)
        self.assertIn("缩进=tab", md)
        md2 = B.render(neutral_incident(), self.el, "org/repo", self.contract)
        self.assertIn("未探测到", md2)

    def test_real_incident_embeds_report_verbatim(self):
        with TempDir() as tmp:
            inc, _, _ = inputs.load(assemble_archive(tmp))
            md = B.render(inc, {"repo": "r", "files": ["app/service/ExampleSrv.php"]}, "repos/r", self.contract)
            self.assertIn(inc.report_md.strip(), md)
            self.assertIn("rule_uid `rule-example-5xx`", md)


class DetectTest(unittest.TestCase):
    def test_detect_runtime_priority(self):
        files = {"composer.json": '{"require": {"php": "^7.2"}}', "go.mod": "module x\n\ngo 1.23\n"}

        def read_at(p):
            return files.get(p, "")

        self.assertEqual(B.detect_runtime(read_at, lambda: list(files)), "PHP ^7.2（依据 composer.json 的 require.php）")
        files[".github/workflows/ci.yml"] = "with:\n  php-version: '8.1'\n"
        self.assertTrue(B.detect_runtime(read_at, lambda: list(files)).startswith("PHP 8.1（依据 .github/workflows/ci.yml"))
        files = {"go.mod": "module x\n\ngo 1.23\n"}
        self.assertEqual(B.detect_runtime(read_at, lambda: list(files)), "Go 1.23（依据 go.mod）")
        files = {".nvmrc": "v20.11\n"}
        self.assertEqual(B.detect_runtime(read_at, lambda: list(files)), "Node 20.11（依据 .nvmrc）")
        files = {}
        self.assertEqual(B.detect_runtime(read_at, lambda: []), "")

    def test_detect_runtime_on_temp_repo(self):
        with TempDir() as tmp:
            clone, _ = make_temp_repo(tmp)
            wt = Worktree(clone, os.path.join(tmp, "wt"), "autofix/x", os.path.join(tmp, "excl"))
            wt.resolve_base_ref()
            note = B.detect_runtime(wt.read_file_at_base, wt.list_files_at_base)
            self.assertEqual(note, "PHP 7.2（依据 .github/workflows/lint.yml 的 php-version）")
            style = B.detect_file_style(wt.read_file_at_base, ["app/service/ExampleSrv.php"])
            self.assertIn("缩进=tab", style)
            self.assertIn("结尾换行=无", style)

    def test_style_of(self):
        self.assertEqual(B.style_of("\ta\n\tb\n\tc\n"), ("tab", True, True))
        self.assertEqual(B.style_of("    a\n    b\n        c"), ("空格×4", False, True))
        self.assertEqual(B.style_of("  a\n"), ("", True, False))
        self.assertEqual(B.style_of(" * doc\n * doc\n * doc\n\tx\n\ty\n\tz\n"), ("tab", True, True))


if __name__ == "__main__":
    unittest.main()
