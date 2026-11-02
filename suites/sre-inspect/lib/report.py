"""report.json v1.1 — the same contract suites/sre-autofix consumes (docs/input-contract.md there;
field names from the reference producer orchestrator/internal/report/report.go).

`skeleton()` is written by `run dive` with the incident block filled by code; the agent fills the
judgement fields; `finish()` validates, scrubs (suites/sre-autofix/lib/scrub.py by pointer) and
refuses to finish when a secret is present.
"""
import importlib.util
import json
import os

from .common import SuiteError, read_text, utc_now, write_json, write_text, EXIT_BLOCKED, EXIT_FAILED

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
CONFIDENCE = ("low", "medium", "high")
CAUSE_LOCI = ("code_defect", "infra", "dependency", "config", "unknown", "")
SEVERITY = ("low", "medium", "high", "critical", "")


def skeleton(inc_id, alert, rt, facts, tenant, occurrences=1, archive_dir=""):
    now = utc_now()
    return {
        "report_version": "1.1", "scenario": "dive", "trigger": "alert", "generated_at": now,
        "generator": "suites/sre-inspect (local)",
        "incident": {"id": inc_id, "fingerprint": alert.get("fingerprint", ""), "rule_uid": alert.get("rule_uid", ""),
                     "rid": rt.get("rid", ""), "rule_name": rt.get("rule_name") or alert.get("rule_name", ""),
                     "layer": rt.get("layer", ""), "subject": alert.get("subject", ""), "title": alert.get("title", ""),
                     "eval_epoch": facts["eval_epoch"], "occurrences": occurrences, "archive_dir": archive_dir},
        "status": {"state": "INVESTIGATING", "terminal": False, "needs_human": False, "human_note": "",
                   "created_at": now, "updated_at": now},
        "verdict": {"value": "", "source": "triage", "template": rt.get("template", ""), "summary": "", "reason": "",
                    "known_pattern": [], "mentioned_patterns": []},
        "root_cause": {"source": "dive", "statement": "", "chain": [], "confidence": "", "confidence_basis": "",
                       "cause_locus": "", "cause_locus_basis": "", "severity": "", "severity_basis": "",
                       "impact": {"scope": "", "magnitude": "", "time_window": ""},
                       "repro": {"conditions": "", "frequency": ""}, "suggested_fix": ""},
        "evidence": [], "excluded_hypotheses": [], "data_gaps": [],
        "suspect_change": "none", "duplicate_of": "none", "unfixable_reason": "",
        "data_sources": [], "sufficiency": {"total": 0, "grade": ""},
        "cost": {"incident_usd": 0, "tool_calls": 0},
        "degradations": ["local form: no cost ledger, no cross-incident dedup"], "timeline": [],
        "attachments": {"inspect": "INSPECT.md", "rca": "rca.md"}, "completeness": {"missing": []},
        "scrub": {"findings": [], "egress_blocked": False},
        "tenant": {"id": tenant.id, "timezone": tenant.timezone},
    }


def validate(rep, inc_id=None):
    p = []
    if not isinstance(rep, dict):
        return ["report.json is not an object"]
    if str(rep.get("report_version", "")) != "1.1":
        p.append("report_version must be \"1.1\"")
    inc = rep.get("incident") or {}
    if not inc.get("id"):
        p.append("incident.id is required")
    elif inc_id and inc["id"] != inc_id:
        p.append("incident.id %r != directory %r" % (inc["id"], inc_id))
    v = (rep.get("verdict") or {}).get("value", "")
    if v not in VERDICTS:
        p.append("verdict.value must be one of %s (got %r)" % ("/".join(VERDICTS), v))
    rc = rep.get("root_cause") or {}
    if v == "FAIL":
        st = str(rc.get("statement", "")).strip()
        if len(st) < 20:
            p.append("root_cause.statement is required for FAIL (>= 20 chars; write 未定因 + what is missing if undetermined)")
        if rc.get("confidence") not in CONFIDENCE:
            p.append("root_cause.confidence must be low|medium|high")
        if rc.get("cause_locus", "") not in CAUSE_LOCI:
            p.append("root_cause.cause_locus must be one of %s" % "/".join(x or "\"\"" for x in CAUSE_LOCI))
        if rc.get("cause_locus") == "code_defect" and not str(rc.get("cause_locus_basis", "")).strip():
            p.append("root_cause.cause_locus_basis is required when cause_locus=code_defect")
    if v == "PASS" and not str((rep.get("verdict") or {}).get("summary", "")).strip():
        p.append("verdict.summary is required for PASS (why the alert is not an anomaly)")
    if rc.get("severity", "") not in SEVERITY:
        p.append("root_cause.severity must be low|medium|high|critical or empty")
    ev = rep.get("evidence")
    if not isinstance(ev, list):
        p.append("evidence must be a list")
    else:
        for i, e in enumerate(ev):
            if not isinstance(e, dict) or not e.get("claim") or not e.get("tool"):
                p.append("evidence[%d] needs claim + tool" % i)
    for key in ("excluded_hypotheses", "data_gaps", "data_sources"):
        if not isinstance(rep.get(key), list):
            p.append("%s must be a list" % key)
    sc = str(rep.get("suspect_change", "none"))
    if sc != "none" and "@" not in sc:
        p.append("suspect_change must be none or repo@sha")
    return p


def load_scrub(root):
    path = os.path.join(root, "suites", "sre-autofix", "lib", "scrub.py")
    if not os.path.isfile(path):
        return None
    spec = importlib.util.spec_from_file_location("sre_autofix_scrub", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def finish(inc_dir, root, verdict_close=True, extra_secrets=()):
    """Validate + scrub report.json and rca.md in place. Returns (report, findings). Raises SuiteError
    (EXIT_FAILED) on validation errors, (EXIT_BLOCKED) when a secret is found."""
    inc_id = os.path.basename(os.path.normpath(inc_dir))
    rpath, mpath = os.path.join(inc_dir, "report.json"), os.path.join(inc_dir, "rca.md")
    text = read_text(rpath)
    if text is None:
        raise SuiteError("%s not found — the dive has not written its report" % rpath, EXIT_FAILED)
    try:
        rep = json.loads(text)
    except ValueError as e:
        raise SuiteError("report.json is not valid JSON: %s" % e, EXIT_FAILED)
    problems = validate(rep, inc_id)
    if problems:
        raise SuiteError("report.json 未通过契约校验：\n  - " + "\n  - ".join(problems), EXIT_FAILED)
    rca = read_text(mpath)
    if rca is None or len(rca.strip()) < 50:
        raise SuiteError("rca.md missing or too short (< 50 chars) in %s" % inc_dir, EXIT_FAILED)
    scrub = load_scrub(root)
    findings = []
    if scrub is not None:
        rep_text, f1 = scrub.scrub(json.dumps(rep, ensure_ascii=False, indent=1), extra_secrets)
        rca_text, f2 = scrub.scrub(rca, extra_secrets)
        findings = f1 + f2
        if any(f.get("blocked") for f in findings):
            names = sorted(set(f["name"] for f in findings if f.get("blocked")))
            rep["scrub"] = {"findings": findings, "egress_blocked": True}
            write_json(rpath, rep)
            raise SuiteError("report/rca 含密钥形态（%s）——已标 egress_blocked，去掉后重跑 finish" % ", ".join(names), EXIT_BLOCKED)
        rep = json.loads(rep_text)
        if rca_text != rca:
            write_text(mpath, rca_text)
    else:
        rep.setdefault("degradations", []).append("scrub unavailable (suites/sre-autofix/lib/scrub.py not found)")
    rep["scrub"] = {"findings": findings, "egress_blocked": False}
    v = rep["verdict"]["value"]
    st = rep.setdefault("status", {})
    if v == "PASS":
        st.update({"state": "FALSE_POSITIVE", "terminal": True})
    elif v == "FAIL":
        rc = rep.get("root_cause") or {}
        st.update({"state": "ROOT_CAUSED" if str(rc.get("statement", "")).find("未定因") < 0 else "INVESTIGATING",
                   "terminal": False})
    else:
        st.update({"state": "INVESTIGATING", "terminal": False, "needs_human": True})
    st["updated_at"] = utc_now()
    rep["generated_at"] = utc_now()
    write_json(rpath, rep)
    return rep, findings
