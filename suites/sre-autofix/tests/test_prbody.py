import os
import unittest

from helpers import FIXTURES, INCIDENT, TempDir, assemble_archive, read
from lib import inputs, prbody as P

DIFF = read(os.path.join(FIXTURES, "shipped.diff"))
FIXNOTES = read(os.path.join(FIXTURES, "fixnotes-sample.md"))
CHECKS = [{"name": "补丁非空且能干净应用", "passed": True, "detail": "1 个文件、+11/-4"},
          {"name": "改动限定在业务路径", "passed": True, "detail": "全部落在 app/"},
          {"name": "补丁不含密钥", "passed": True, "detail": "未命中任何密钥模式"},
          {"name": "验证证据已申报", "passed": True, "detail": "3 项验证全部通过"}]


def load():
    with TempDir() as tmp:
        inc, _, _ = inputs.load(assemble_archive(tmp))
    return inc


def meta(**kw):
    m = {"repo": "example-org/demo-repo", "branch": "autofix/" + INCIDENT, "base_sha": "a" * 40, "commit_sha": "b" * 40,
         "files": ["app/service/ExampleSrv.php"], "diff": DIFF, "checks": CHECKS, "attempts": 1, "fixnotes": FIXNOTES,
         "verification_summary": "3 项验证全部通过", "refs_issue": 0, "archive_dir": "/x"}
    m.update(kw)
    return m


class BodyTest(unittest.TestCase):
    def test_four_assertions_and_layout(self):
        body, blocked, reason, _ = P.render(load(), meta(refs_issue=123))
        self.assertFalse(blocked, reason)
        for w in ["## 10 分钟评审路径", "## 一、精简版：根因与修法", "## 二、完整证据链",
                  "**复现条件**：", "ev://%s/tool/call_0001" % INCIDENT, "**推理链**",      # ① ② repro + chain w/ refs
                  "| 文件 | 行 | 首行改动 |", "app/service/ExampleSrv.php` | 8–28",        # ③ hunks
                  "### 验证方式", "3 项验证全部通过",                                      # ④
                  "### 机器标记", "### 签收清单", "Refs #123", "**根因归属**：代码缺陷（code_defect）",
                  "| 补丁规模 | — | 1 个文件，+11/-4 |", "isFeatureEnabled：RPC 抛异常"]:  # fixnotes 改了什么 lifted
            self.assertIn(w, body, w)
        self.assertEqual(body.count("| ✅ |"), 4)
        self.assertNotIn("Closes", body)
        self.assertEqual(body.count("- [ ]"), 4)
        self.assertIn("<!-- sre-agent:eval_epoch=1786440000 fingerprint=deadbeefcafe0001 incident=%s rule_uid=rule-example-5xx -->" % INCIDENT, body)

    def test_closing_keywords_rewritten(self):
        body, _, _, _ = P.render(load(), meta(fixnotes=FIXNOTES + "\nCloses #7\nfixes #8 too\n"))
        self.assertNotIn("Closes #7", body)
        self.assertIn("Refs #7", body)
        self.assertIn("Refs #8", body)

    def test_secret_in_fixnotes_blocks(self):
        body, blocked, reason, _ = P.render(load(), meta(fixnotes=FIXNOTES + "\ntoken " + "ghp_" + "Q" * 36 + "\n"))
        self.assertTrue(blocked)
        self.assertIn("github-token", reason)
        self.assertNotIn("Q" * 36, body)

    def test_attempts_row_and_hedge_warning(self):
        inc = load()
        inc.draft["root_cause_statement"] = "未定因。直接层：x"
        body, _, _, _ = P.render(inc, meta(attempts=2))
        self.assertIn("| 尝试次数 | — | 第 2 次才通过验证门 |", body)
        self.assertIn("深层未定因", body)


class HelpersTest(unittest.TestCase):
    def test_fix_summary_forms(self):
        self.assertEqual(P.fix_summary("# t\n## 改了什么\n\nA\nB\n\n## 为什么\nC"), "A\nB")
        self.assertEqual(P.fix_summary("## What changed\nX\n## Y\n"), "X")
        self.assertEqual(P.fix_summary("# title\nline1\n\nline2\nline3\nline4"), "title\nline1\nline2")
        self.assertEqual(P.fix_summary(""), "")

    def test_pr_title(self):
        d = {"title": "未定因。RPC 返回空时抛异常", "root_cause_statement": "x"}
        self.assertEqual(P.pr_title(d, ["app/service/ExampleSrv.php"]), "fix(service): RPC 返回空时抛异常")
        self.assertEqual(P.pr_title({"title": "", "root_cause_statement": "根因"}, ["a.php", "b.php"]), "fix: 根因")
        t = P.pr_title({"title": "x" * 100}, ["a.php"])
        self.assertEqual(len(t), len("fix: ") + 73)

    def test_commit_message_no_ai_signature(self):
        m = P.commit_message(load().draft, ["app/service/ExampleSrv.php"])
        self.assertTrue(m.startswith("ExampleSrv.php:21 在 RPC 返回 false/空时抛出未捕获异常，被框架转为 500\n\n"))
        self.assertIn("Files: app/service/ExampleSrv.php", m)
        for bad in ("Co-Authored-By", "Claude", "AI"):
            self.assertNotIn(bad, m)

    def test_hunk_list_and_diff_stat(self):
        h = P.hunk_list(DIFF)
        self.assertEqual(len(h), 1)
        self.assertEqual(h[0]["file"], "app/service/ExampleSrv.php")
        self.assertEqual(h[0]["lines"], "8–28")
        self.assertTrue(h[0]["first"].startswith("-"))
        self.assertEqual(P.diff_stat(DIFF), (11, 4))

    def test_rate(self):
        s = P.rate(load().draft)
        self.assertGreaterEqual(s["total"], 50)
        self.assertIn(s["grade"], ("充分", "基本可评审"))
        self.assertEqual(P.rate({})["grade"], "不足")


if __name__ == "__main__":
    unittest.main()
