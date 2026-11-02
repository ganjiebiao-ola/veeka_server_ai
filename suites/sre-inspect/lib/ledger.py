"""Recurrence ledger — port of ola-sre-agent orchestrator/internal/intake/suppress.go.

Semantics kept 1:1 (the reference's tests are re-run in tests/test_ledger.py):
  * first sighting of a fingerprint -> new;
  * same fingerprint while the incident is open and within `cooldown` -> suppressed (folded into
    the active incident as another occurrence; suppression is never "ignore");
  * same fingerprint after the incident was closed but within `recurrence` -> recurred (points at
    the previous incident);
  * otherwise -> new.
Gaps are taken as absolute values because sources do not guarantee time-ordered arrival.
"""
import os

from .common import read_json, write_json


class Ledger:
    def __init__(self, path, cooldown_s=1800, recurrence_s=14 * 86400):
        self.path = path
        self.cooldown = int(cooldown_s)
        self.recurrence = int(recurrence_s)
        st = read_json(path, {}) if path else {}
        self.entries = dict((st or {}).get("entries") or {})

    # -- queries ----------------------------------------------------------------
    def _decide(self, fingerprint, eval_epoch, mutate):
        e = self.entries.get(fingerprint)
        if e is None:
            return {"suppress": False, "recurred": False, "occurrence": 1, "reason": "首次出现"}
        gap = abs(int(eval_epoch) - int(e.get("last_eval", 0)))
        if not e.get("closed") and gap < self.cooldown:
            occ = int(e.get("occurrences", 1)) + 1
            if mutate:
                e["last_eval"] = int(eval_epoch)
                e["occurrences"] = occ
                self.save()
            return {"suppress": True, "active_incident": e.get("incident_id"), "occurrence": occ,
                    "recurred": False, "reason": "冷却窗内复发（距上次 %ds < %ds）" % (gap, self.cooldown)}
        if e.get("closed") and gap < self.recurrence:
            return {"suppress": False, "active_incident": e.get("incident_id"), "recurred": True,
                    "occurrence": int(e.get("occurrences", 1)) + 1,
                    "reason": "复发布防窗内同指纹再现（距上次 %ds < %ds）" % (gap, self.recurrence)}
        return {"suppress": False, "recurred": False, "occurrence": 1, "previous_incident": e.get("incident_id"),
                "reason": "超出冷却窗，按新事件处理"}

    def peek(self, alert):
        """Decision without mutating state (intake listing)."""
        return self._decide(alert["fingerprint"], alert["eval_epoch"], mutate=False)

    def check(self, alert):
        """Decision; a suppressed sighting is counted onto the active incident (reference semantics)."""
        return self._decide(alert["fingerprint"], alert["eval_epoch"], mutate=True)

    # -- mutations --------------------------------------------------------------
    def register(self, alert, incident_id):
        self.entries[alert["fingerprint"]] = {
            "fingerprint": alert["fingerprint"], "incident_id": incident_id,
            "rule_uid": alert.get("rule_uid", ""), "subject": alert.get("subject", ""),
            "first_eval": int(alert["eval_epoch"]), "last_eval": int(alert["eval_epoch"]),
            "occurrences": 1, "closed": False,
        }
        self.save()

    def close(self, fingerprint):
        e = self.entries.get(fingerprint)
        if e is not None:
            e["closed"] = True
            self.save()

    def save(self):
        if self.path:
            write_json(self.path, {"entries": self.entries})
