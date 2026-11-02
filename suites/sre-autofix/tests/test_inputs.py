import json
import os
import shutil
import unittest

from helpers import FIXTURES, INCIDENT, TempDir, assemble_archive, write
from lib import inputs
from lib.common import SuiteError


class ArchiveTest(unittest.TestCase):
    def test_archive_has_all_draft_fields(self):
        with TempDir() as tmp:
            d = assemble_archive(tmp)
            inc, kind, _ = inputs.load(d)
            self.assertEqual(kind, "archive")
            self.assertEqual(inc.id, INCIDENT)
            self.assertEqual(sorted(inc.draft), sorted(inputs.DRAFT_FIELDS))
            self.assertEqual(inc.draft["cause_locus"], "code_defect")
            self.assertEqual(len(inc.draft["evidence"]), 3)
            self.assertEqual(inc.draft["evidence"][0]["excerpt"][:7], "42 hits")
            self.assertEqual(inc.report_md_source, "issue.draft.md")
            self.assertIn("## 6. 证据引用", inc.report_md)
            self.assertEqual(inc.rid, "R-01")
            self.assertEqual(inc.eval_epoch, 1786440000)

    def test_legacy_draft_has_empty_locus(self):
        with TempDir() as tmp:
            inc, _, _ = inputs.load(assemble_archive(tmp, "draft-legacy.json"))
            self.assertEqual(inc.draft["cause_locus"], "")

    def test_archive_requires_issue_md(self):
        with TempDir() as tmp:
            d = assemble_archive(tmp)
            os.unlink(os.path.join(d, "issue.draft.md"))
            with self.assertRaises(SuiteError):
                inputs.load(d)

    def test_closed_pr_review_enters_rework_mode(self):
        with TempDir() as tmp:
            d = assemble_archive(tmp)
            write(os.path.join(d, "n2", "pr.json"), json.dumps({"state": "closed", "review_summary": "改错地方了"}))
            inc, _, _ = inputs.load(d)
            self.assertEqual(inc.review_summary, "改错地方了")

    def test_report_next_to_draft_upgrades_to_archive(self):
        with TempDir() as tmp:
            d = assemble_archive(tmp)
            shutil.copy(os.path.join(FIXTURES, "report-v11.json"), os.path.join(d, "report.json"))
            _, kind, resolved = inputs.load(os.path.join(d, "report.json"))
            self.assertEqual(kind, "archive")
            self.assertEqual(resolved, d)


class ReportTest(unittest.TestCase):
    def test_report_mapping(self):
        with TempDir() as tmp:
            p = os.path.join(tmp, "report-v11.json")
            shutil.copy(os.path.join(FIXTURES, "report-v11.json"), p)
            inc, kind, _ = inputs.load(p)
        self.assertEqual(kind, "report")
        d = inc.draft
        self.assertEqual(inc.id, INCIDENT)
        self.assertEqual(d["confidence"], "high")
        self.assertEqual(d["cause_locus"], "code_defect")
        self.assertEqual(d["impact_magnitude"][:2], "42")
        self.assertEqual(d["repro_frequency"][:2], "间歇")
        self.assertEqual([e["tool_call_id"] for e in d["evidence"]], ["call_0001", "call_0002", "call_0003"])
        self.assertEqual(d["evidence"][0]["excerpt"], "")
        self.assertEqual(d["suspect_change"], "none")
        self.assertEqual(inc.sufficiency, {"total": 88, "grade": "充分"})
        # attachments point at files that do not exist next to the fixture → reconstructed md
        self.assertEqual(inc.report_md_source, "reconstructed-from-report.json")
        for h in ("## 1. 问题", "## 5. 根因与推理链", "## 6. 证据引用", "## 9. 修复建议", "## 12. 签收清单"):
            self.assertIn(h, inc.report_md)
        self.assertIn("ev://%s/tool/call_0002" % INCIDENT, inc.report_md)
        self.assertIn("摘录不在 report.json 中", inc.report_md)
        self.assertTrue(any("重建" in x for x in inc.degradations))

    def test_report_uses_attached_issue_md_when_present(self):
        with TempDir() as tmp:
            d = os.path.join(tmp, "rep")
            os.makedirs(d)
            shutil.copy(os.path.join(FIXTURES, "report-v11.json"), os.path.join(d, "report.json"))
            shutil.copy(os.path.join(FIXTURES, "issue.draft.md"), os.path.join(d, "issue.draft.md"))
            inc, _, _ = inputs.load(os.path.join(d, "report.json"))
            self.assertEqual(inc.report_md_source, "issue.draft.md")
            self.assertEqual(inc.degradations, [])

    def test_dive_report_has_empty_confidence(self):
        inc, _, _ = inputs.load(os.path.join(FIXTURES, "report-dive.json"))
        self.assertEqual(inc.draft["confidence"], "")
        self.assertEqual(inc.draft["root_cause_chain"], [])

    def test_report_without_root_cause_is_rejected(self):
        with TempDir() as tmp:
            with open(os.path.join(FIXTURES, "report-v11.json"), encoding="utf-8") as f:
                rep = json.load(f)
            rep.pop("root_cause")
            p = os.path.join(tmp, "r.json")
            write(p, json.dumps(rep))
            with self.assertRaises(SuiteError):
                inputs.load(p)

    def test_bare_draft_file_is_refused_with_hint(self):
        with self.assertRaises(SuiteError) as cm:
            inputs.load(os.path.join(FIXTURES, "draft-code-defect.json"))
        self.assertIn("archive directory", str(cm.exception))

    def test_roundtrip_dict(self):
        inc, _, _ = inputs.load(os.path.join(FIXTURES, "report-v11.json"))
        back = inputs.Incident.from_dict(json.loads(json.dumps(inc.to_dict())), inc.report_md)
        self.assertEqual(back.to_dict(), inc.to_dict())


if __name__ == "__main__":
    unittest.main()
