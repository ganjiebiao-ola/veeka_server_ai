"""Regression coverage for ambiguous legacy bill periods and missing review costs."""
import copy
import importlib.util
import json
from datetime import date
from importlib.machinery import SourceFileLoader
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[3]
loader = SourceFileLoader("weekly_cost_boundaries", str(ROOT / "scripts/ai-usage-weekly"))
spec = importlib.util.spec_from_loader(loader.name, loader)
weekly = importlib.util.module_from_spec(spec)
loader.exec_module(weekly)
FIXTURES = ROOT / "platform-internals/tests/ai-usage-weekly"


class CostBoundaries(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.reports = Path(self.tmp.name)
        self.base = weekly.load_json(str(FIXTURES / "team-budget/reports/2026-W33/alice.json"))
        self.schema = weekly.load_json(str(ROOT / weekly.SCHEMA_REL))
        self.mapping = weekly.load_mapping(str(ROOT / weekly.MAPPING_REL))
        self.request = weekly.load_json(str(FIXTURES / "team-budget/reports/requests/2026-08-alice-claude-seat.json"))

    def write_bills(self, bills, legacy=True, human_id="alice"):
        path = self.reports / "bill.json"
        path.write_text(json.dumps(bills), encoding="utf-8")
        actual, allocated, _ = weekly.read_bills(str(path), self.mapping, date(2026, 7, 27), date(2026, 8, 2))
        if legacy:
            # This is exactly the pre-items --bill shape, including the merged source/period.
            actual.pop("items")
            allocated.pop("items")
        sub = copy.deepcopy(self.base)
        sub["meta"].update(week="2026-W31", since="2026-07-27", until="2026-08-02", human_id=human_id)
        sub["cost"].update(actual=actual, allocated=allocated)
        self.assertEqual(weekly.validate(sub, self.schema), [])
        target = self.reports / "reports/2026-W31" / (human_id + ".json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(sub), encoding="utf-8")

    @staticmethod
    def bill(source, amount, since, until):
        return dict(source=source, nature="seat", currency="USD", amount=amount,
                    since=since, until=until, confirmed=True)

    def budget(self):
        return weekly.budget_status(str(self.reports), "2026-W31", date(2026, 8, 2),
                                   {"fixture-biz": {"monthly": 620, "currency": "USD"}},
                                   "fixture-biz", self.schema)

    def write_ambiguous_legacy_bills(self, legacy=True):
        # July: $10/day for 5 days = $50; August: $20/day for 2 days = $40.
        # The legacy $90 block loses the individual periods and cannot be spread as $90 * 2/7.
        self.write_bills([self.bill("July-seat", 310, "2026-07-01", "2026-07-31"),
                          self.bill("August-seat", 620, "2026-08-01", "2026-08-31")], legacy=legacy)

    def test_ambiguous_legacy_month_has_no_numeric_budget(self):
        self.write_ambiguous_legacy_bills()
        result = self.budget()
        self.assertNotEqual(result["state"], "ok")
        for rendered in ("\n".join(weekly.budget_md(result)), weekly.budget_html(result)):
            self.assertIn("待核实", rendered)
            self.assertIn("alice", rendered)
            self.assertIn("合并账单", rendered)
            self.assertNotIn("25.71", rendered)
            self.assertNotIn("398.57", rendered)

    def test_ambiguous_legacy_bill_is_excluded_from_other_known_costs(self):
        self.write_ambiguous_legacy_bills()
        self.write_bills([self.bill("known-seat", 10, "2026-08-01", "2026-08-02")], human_id="bob")
        result = self.budget()
        self.assertEqual(result["accumulated"], 10)
        self.assertEqual(result["weeks"][0]["pending"], ["alice"])
        for rendered in ("\n".join(weekly.budget_md(result)), weekly.budget_html(result)):
            self.assertIn("合并账单", rendered)
            self.assertNotIn("25.71", rendered)

    def test_itemized_bills_keep_their_exact_month_share(self):
        self.write_ambiguous_legacy_bills(legacy=False)
        self.assertEqual(self.budget()["accumulated"], 40)

    def test_legacy_actual_only_merged_bill_is_also_unknown(self):
        self.write_bills([self.bill("July-seat", 50, "2026-07-27", "2026-07-31"),
                          self.bill("August-seat", 40, "2026-08-01", "2026-08-02")])
        path = self.reports / "reports/2026-W31/alice.json"
        sub = weekly.load_json(str(path))
        sub["cost"]["allocated"] = None
        path.write_text(json.dumps(sub), encoding="utf-8")
        result = self.budget()
        self.assertNotEqual(result["state"], "ok")
        self.assertIn("合并账单", "\n".join(weekly.budget_md(result)))

    def test_single_legacy_bill_is_not_prorated_twice(self):
        self.write_bills([self.bill("August-seat", 200, "2026-08-01", "2026-08-31")])
        self.assertAlmostEqual(self.budget()["accumulated"], 12.903226)

    def test_legacy_merged_bills_wholly_in_august_are_counted(self):
        self.write_bills([self.bill("first-seat", 10, "2026-08-01", "2026-08-01"),
                          self.bill("second-seat", 20, "2026-08-02", "2026-08-02")])
        self.assertEqual(self.budget()["accumulated"], 30)

    @staticmethod
    def review_week(spend):
        return {"week": "2026-W33", "spend": spend, "usage": None, "outcomes": [], "coarse": []}

    def test_review_missing_currency_is_unknown_not_zero(self):
        for weeks in ([], [self.review_week({})], [self.review_week({"CNY": 700})]):
            with self.subTest(weeks=weeks):
                text = weekly.render_review_md(self.request, weeks)
                comparison = next(line for line in text.splitlines() if line.startswith("预算比对:"))
                self.assertIn("待核实", comparison)
                self.assertNotIn("账单累计 0.00 USD", comparison)
                if weeks and weeks[0]["spend"]:
                    self.assertIn("700.00 CNY", comparison)
                    self.assertIn("待换算", comparison)
                    self.assertNotIn("账单覆盖了周期内 1 周", comparison)

    def test_review_explicit_zero_is_still_zero(self):
        text = weekly.render_review_md(self.request, [self.review_week({"USD": 0})])
        self.assertIn("账单累计 0.00 USD", text)
        self.assertIn("| **合计** | **0.00 USD** |", text)

    def test_review_known_currency_keeps_foreign_costs_separate(self):
        weeks = [self.review_week({"USD": 100, "CNY": 700}), self.review_week({"CNY": 20})]
        weeks[1]["week"] = "2026-W34"
        text = weekly.render_review_md(self.request, weeks)
        self.assertIn("账单累计 100.00 USD", text)
        self.assertIn("720.00 CNY", text)
        self.assertIn("待换算", text)
        self.assertNotIn("账单覆盖了周期内 2 周", text)


if __name__ == "__main__":
    unittest.main()
