"""Behavioral tests for overlapping exports, ISO-week validation and report refresh."""
import copy
import importlib.util
from importlib.machinery import SourceFileLoader
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date

ROOT = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[3]
loader = SourceFileLoader("weekly_integrity", str(ROOT / "scripts/ai-usage-weekly"))
spec = importlib.util.spec_from_loader(loader.name, loader)
weekly = importlib.util.module_from_spec(spec)
loader.exec_module(weekly)
FIXTURES = ROOT / "platform-internals/tests/ai-usage-weekly"


class ReportIntegrity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.reports = self.base / "reports-repo"
        self.reports.mkdir()
        self.ws = self.base / "ws"
        self.ws.mkdir()
        shutil.copyfile(FIXTURES / "ws/workspace.yaml", self.ws / "workspace.yaml")
        self.empty = self.base / "empty"
        self.empty.mkdir()
        self.schema = weekly.load_json(str(ROOT / weekly.SCHEMA_REL))
        self.submission = weekly.load_json(str(FIXTURES / "team-budget/reports/2026-W33/alice.json"))

    def run_tool(self, *args):
        return subprocess.run([str(ROOT / "scripts/ai-usage-weekly"), *map(str, args),
                               "--reports-dir", str(self.reports), "--workspace-root", str(self.ws)],
                              text=True, capture_output=True)

    def submit(self, *exports):
        args = ["submit", "--week", "2026-W33", "--source", "native", "--claude-dir", self.empty,
                "--codex-dir", self.empty, "--qoder-dir", self.empty, "--pricing", FIXTURES / "pricing.json", "--out", self.base / "out"]
        for path in exports:
            args.extend(["--platform-export", path])
        result = self.run_tool(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return weekly.load_json(str(self.reports / "reports/2026-W33/alice.json"))

    def test_repeated_csv_and_xlsx_exports_count_once(self):
        csv = FIXTURES / "platform-export.csv"
        once = self.submit(csv)
        repeated = self.submit(csv, csv, FIXTURES / "platform-export.xlsx")
        self.assertEqual(repeated["usage"]["requests"], 7)
        self.assertEqual(repeated["cost"]["estimated"]["amount"], once["cost"]["estimated"]["amount"])
        self.assertEqual(len(repeated["usage"]["cells"]), 2)
        source = next(s for s in repeated["usage"]["sources"] if s["type"] == "platform-export")
        self.assertEqual(source["records"], 2)

    def test_codex_submit_obeys_declared_timezone_across_weeks(self):
        codex = self.base / "codex"
        codex.mkdir()
        rows = [{"type": "session_meta", "timestamp": "2026-08-16T15:00:00Z",
                 "payload": {"cwd": str(self.ws), "timestamp": "2026-08-16T15:00:00Z"}}]
        for ts, inp, cached, out in [("2026-08-16T15:30:00Z", 100, 20, 10),
                                     ("2026-08-16T16:30:00Z", 300, 60, 30)]:
            rows.append({"type": "event_msg", "timestamp": ts, "payload": {
                "type": "token_count", "info": {"total_token_usage": {
                    "input_tokens": inp, "cached_input_tokens": cached, "output_tokens": out}}}})
        (codex / "rollout-2026-08-16T15-00-00-test.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
        for week, expected in [("2026-W33", (80, 20, 10)), ("2026-W34", (160, 40, 20))]:
            result = self.run_tool("submit", "--week", week, "--timezone", "Asia/Singapore", "--source", "native",
                                   "--claude-dir", self.empty, "--codex-dir", codex, "--qoder-dir", self.empty, "--out", self.base / "out",
                                   "--pricing", FIXTURES / "pricing.json")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            sub = weekly.load_json(str(self.reports / "reports" / week / "alice.json"))
            self.assertEqual(tuple(sub["usage"][k] for k in ("input", "cache_read", "output")), expected)
            self.assertEqual(sub["usage"]["requests"], 1)

    def test_later_export_replaces_overlap_but_keeps_other_days(self):
        update = self.base / "update.csv"
        update.write_text("Date,User,Model,Requests,Input Tokens,Output Tokens,Cached Tokens\n"
                          "2026-08-10,alice,claude-fable-5,3,600,200,100\n"
                          "2026-08-13,alice,claude-fable-5,4,800,300,200\n", encoding="utf-8")
        sub = self.submit(FIXTURES / "platform-export.csv", update)
        self.assertEqual(sub["usage"]["requests"], 9)  # 3 replacement + 2 untouched + 4 new
        result = self.run_tool("team", "--week", "2026-W33", "--pricing", FIXTURES / "pricing.json",
                               "--platform-export", FIXTURES / "platform-export.csv", "--platform-export", update)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        md = (self.reports / "reports/2026-W33/team-report.md").read_text()
        self.assertRegex(md, r"\| alice[^|]*\| 9 \|")

    def write_submission(self, sub, week="2026-W33", name="alice"):
        target = self.reports / "reports" / week / (name + ".json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(sub), encoding="utf-8")

    def test_mismatched_dates_are_rejected_before_aggregation(self):
        bad = copy.deepcopy(self.submission)
        bad["meta"].update(since="2026-08-01", until="2026-08-31")
        self.write_submission(bad)
        accepted, rejected = weekly.load_week(str(self.reports), "2026-W33", self.schema)
        self.assertEqual(accepted, [])
        self.assertEqual(len(rejected), 1)
        self.assertIn("2026-08-10", rejected[0][1])
        self.assertIn("2026-08-16", rejected[0][1])

    def test_period_check_rejects_wrong_or_invalid_dates(self):
        for since, until in [("2026-08-01", "2026-08-31"), ("2026-08-10", "2026-08-15"),
                             ("2026-08-99", "2026-08-16")]:
            with self.subTest(since=since, until=until):
                sub = copy.deepcopy(self.submission)
                sub["meta"].update(since=since, until=until)
                aggregate = weekly.aggregate([sub], [], None, date(2026, 8, 10), date(2026, 8, 16))
                check = next(c for c in weekly.run_checks(aggregate, "2026-W33") if c[0] == "周期一致")
                self.assertEqual(check[1], "fail")

    def test_valid_week_is_accepted(self):
        self.write_submission(self.submission)
        accepted, rejected = weekly.load_week(str(self.reports), "2026-W33", self.schema)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(rejected, [])

    def seed_two_weeks(self):
        shutil.copytree(FIXTURES / "team-budget/reports", self.reports / "reports", dirs_exist_ok=True)

    def refresh(self, *paths):
        script = ROOT / "skills/ai-usage-weekly/assets/reports-repo/scripts/team-report.sh"
        result = subprocess.run(["sh", str(script), str(ROOT), str(self.reports), *paths],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_roster_change_refreshes_all_existing_weeks_once(self):
        self.seed_two_weeks()
        path = self.reports / "reports/team.json"
        team = weekly.load_json(str(path))
        team["team"] = "updated-team"
        path.write_text(json.dumps(team))
        stdout = self.refresh("reports/team.json", "reports/2026-W33/alice.json", "reports/team.json")
        for week in ("2026-W32", "2026-W33", "2026-W34"):
            self.assertEqual(stdout.count("== team report " + week), 1)
            self.assertIn("updated-team", (self.reports / "reports" / week / "team-report.md").read_text())

    def test_budget_change_refreshes_existing_reports(self):
        self.seed_two_weeks()
        (self.reports / "reports/budget.json").write_text(json.dumps({"fixture-biz": {"monthly": 999, "currency": "USD"}}))
        self.refresh("reports/budget.json")
        for week in ("2026-W32", "2026-W33", "2026-W34"):
            path = self.reports / "reports" / week / "team-report.md"
            self.assertTrue(path.is_file(), "budget change did not render " + week)
            self.assertIn("999.00", path.read_text())

    def test_request_update_and_deletion_refresh_due_reviews(self):
        self.seed_two_weeks()
        path = self.reports / "reports/requests/2026-08-alice-claude-seat.json"
        req = weekly.load_json(str(path))
        req["resource"] = "Updated resource"
        path.write_text(json.dumps(req))
        self.refresh("reports/requests/2026-08-alice-claude-seat.json")
        md = self.reports / "reports/2026-W33/team-report.md"
        self.assertTrue(md.is_file(), "request change did not render the report")
        self.assertIn("Updated resource", md.read_text())
        path.unlink()
        self.refresh("reports/requests/2026-08-alice-claude-seat.json")
        self.assertNotIn("Updated resource", md.read_text())

    def test_ordinary_submission_only_refreshes_its_week(self):
        self.seed_two_weeks()
        stdout = self.refresh("reports/2026-W33/alice.json", "reports/2026-W33/bob.json")
        self.assertEqual(stdout.count("== team report "), 1)
        self.assertIn("== team report 2026-W33", stdout)

    def test_global_change_with_no_week_data_is_a_safe_noop(self):
        stdout = self.refresh("reports/team.json", "reports/budget.json")
        self.assertNotIn("== team report ", stdout)


if __name__ == "__main__":
    unittest.main()
