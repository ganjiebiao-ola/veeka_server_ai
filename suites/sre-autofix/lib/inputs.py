"""Input normalisation — report.json v1.1 or an ola-sre-agent incident archive dir → Incident.

Archive form ports fixleg.go loadFixInputs (bugissue-draft.json + issue.draft.md are required, the
other files are metadata). Report form maps orchestrator/internal/report/report.go v1.1; evidence
excerpts are not in report.json, so a report-only input renders a reconstructed (degraded) 根因 section.
"""
import hashlib
import json
import os
import re

from .common import SuiteError, check_incident_id, nz, read_json, read_text

DRAFT_STR_FIELDS = [
    "title", "severity", "severity_basis", "impact_scope", "impact_magnitude", "impact_time_window",
    "repro_conditions", "repro_frequency", "root_cause_statement", "confidence", "confidence_basis",
    "cause_locus", "cause_locus_basis", "suggested_fix", "suspect_change", "duplicate_of",
    "needs_human_reason",
]
DRAFT_LIST_FIELDS = ["root_cause_chain", "evidence", "excluded_hypotheses", "data_gaps"]
DRAFT_FIELDS = DRAFT_STR_FIELDS + DRAFT_LIST_FIELDS + ["needs_human"]
EVIDENCE_KEYS = ("claim", "tool", "tool_call_id", "query", "time_window", "excerpt")
_EV_REF = re.compile(r"^ev://[^/]+/tool/(.+)$")


class Incident:
    def __init__(self):
        self.id = ""
        self.fingerprint = self.rule_uid = self.rid = self.rule_name = self.subject = self.title = ""
        self.eval_epoch = 0
        self.draft = {k: ([] if k in DRAFT_LIST_FIELDS else (False if k == "needs_human" else "")) for k in DRAFT_FIELDS}
        self.report_md = ""
        self.report_md_source = ""
        self.sufficiency = None
        self.degradations = []
        self.archive_dir = ""
        self.source_kind = ""
        self.review_summary = ""   # closed-PR review text → 返修 mode
        self.egress_blocked = False

    def to_dict(self):
        return {
            "id": self.id, "fingerprint": self.fingerprint, "rule_uid": self.rule_uid, "rid": self.rid,
            "rule_name": self.rule_name, "subject": self.subject, "title": self.title,
            "eval_epoch": self.eval_epoch, "draft": self.draft, "report_md_source": self.report_md_source,
            "sufficiency": self.sufficiency, "degradations": self.degradations,
            "archive_dir": self.archive_dir, "source_kind": self.source_kind,
            "review_summary": self.review_summary, "egress_blocked": self.egress_blocked,
        }

    @classmethod
    def from_dict(cls, d, report_md=""):
        inc = cls()
        for k in ("id", "fingerprint", "rule_uid", "rid", "rule_name", "subject", "title",
                  "report_md_source", "archive_dir", "source_kind", "review_summary"):
            setattr(inc, k, d.get(k, "") or "")
        inc.eval_epoch = int(d.get("eval_epoch") or 0)
        inc.draft.update(_normalise_draft(d.get("draft") or {}))
        inc.sufficiency = d.get("sufficiency")
        inc.degradations = list(d.get("degradations") or [])
        inc.egress_blocked = bool(d.get("egress_blocked"))
        inc.report_md = report_md
        return inc


def _normalise_draft(raw):
    out = {}
    for k in DRAFT_STR_FIELDS:
        v = raw.get(k, "")
        out[k] = "" if v is None else str(v)
    out["needs_human"] = bool(raw.get("needs_human", False))
    out["root_cause_chain"] = [str(x) for x in (raw.get("root_cause_chain") or [])]
    out["data_gaps"] = [str(x) for x in (raw.get("data_gaps") or [])]
    ev = []
    for e in raw.get("evidence") or []:
        if isinstance(e, dict):
            ev.append({k: str(e.get(k, "") or "") for k in EVIDENCE_KEYS})
    out["evidence"] = ev
    ex = []
    for h in raw.get("excluded_hypotheses") or []:
        if isinstance(h, dict):
            ex.append({"hypothesis": str(h.get("hypothesis", "") or ""),
                       "why_ruled_out": str(h.get("why_ruled_out", "") or "")})
    out["excluded_hypotheses"] = ex
    return out


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def detect_kind(path):
    """'archive' for a dir with bugissue-draft.json; 'report' for a report.json file (or a dir
    holding only report.json); a report.json sitting next to bugissue-draft.json upgrades to archive."""
    path = os.path.abspath(path)
    if os.path.isdir(path):
        if os.path.isfile(os.path.join(path, "bugissue-draft.json")):
            return "archive", path
        if os.path.isfile(os.path.join(path, "report.json")):
            return "report", os.path.join(path, "report.json")
        raise SuiteError("%s holds neither bugissue-draft.json (archive) nor report.json" % path, 2)
    if not os.path.isfile(path):
        raise SuiteError("input not found: %s" % path, 2)
    parent = os.path.dirname(path)
    if os.path.isfile(os.path.join(parent, "bugissue-draft.json")):
        return "archive", parent
    try:
        obj = json.loads(read_text(path) or "")
    except ValueError as e:
        raise SuiteError("%s is not JSON: %s" % (path, e), 2)
    if isinstance(obj, dict) and "report_version" in obj:
        return "report", path
    if isinstance(obj, dict) and "root_cause_statement" in obj:
        raise SuiteError("%s looks like a bare bugissue-draft.json; pass its archive directory "
                         "(issue.draft.md must sit next to it)" % path, 2)
    raise SuiteError("%s is not a report.json (no report_version)" % path, 2)


def load(path):
    kind, resolved = detect_kind(path)
    inc = from_archive(resolved) if kind == "archive" else from_report(resolved)
    inc.source_kind = kind
    return inc, kind, resolved


def from_archive(d):
    inc = Incident()
    draft = read_json(os.path.join(d, "bugissue-draft.json"))
    if not isinstance(draft, dict):
        raise SuiteError("读 bugissue-draft.json（这一腿的输入）失败：%s" % d, 2)
    md = read_text(os.path.join(d, "issue.draft.md"))
    if md is None:
        raise SuiteError("读 issue.draft.md 失败（归档目录必须带已过 Egress 的渲染件）：%s" % d, 2)
    inc.draft.update(_normalise_draft(draft))
    inc.report_md, inc.report_md_source = md, "issue.draft.md"
    st = read_json(os.path.join(d, "state.json"), {}) or {}
    al = read_json(os.path.join(d, "alert.json"), {}) or {}
    rt = read_json(os.path.join(d, "route.json"), {}) or {}
    inc.id = check_incident_id(st.get("id") or os.path.basename(os.path.normpath(d)))
    inc.fingerprint = str(al.get("fingerprint") or st.get("fingerprint") or "")
    inc.rule_uid = str(al.get("rule_uid") or st.get("rule_uid") or "")
    inc.subject = str(al.get("subject") or st.get("subject") or "")
    inc.title = str(al.get("title") or st.get("title") or inc.draft["title"])
    inc.eval_epoch = int(al.get("eval_epoch") or 0)
    inc.rid, inc.rule_name = str(rt.get("rid") or ""), str(rt.get("rule_name") or "")
    inc.degradations = [str(x) for x in (st.get("degradations") or [])]
    eg = read_json(os.path.join(d, "egress.json"), {}) or {}
    if isinstance(eg.get("sufficiency"), dict):
        inc.sufficiency = {"total": eg["sufficiency"].get("total", 0), "grade": eg["sufficiency"].get("grade", "")}
    inc.egress_blocked = bool(eg.get("blocked"))
    inc.archive_dir = d
    pr = read_json(os.path.join(d, "n2", "pr.json"), {}) or {}
    if pr.get("state") == "closed" and (pr.get("review_summary") or "").strip():
        inc.review_summary = pr["review_summary"].strip()
    return inc


def from_report(path):
    rep = read_json(path)
    if not isinstance(rep, dict):
        raise SuiteError("report.json is not an object: %s" % path, 2)
    inc = Incident()
    meta = rep.get("incident") or {}
    inc.id = check_incident_id(meta.get("id", ""))
    for k in ("fingerprint", "rule_uid", "rid", "rule_name", "subject", "title"):
        setattr(inc, k, str(meta.get(k) or ""))
    inc.eval_epoch = int(meta.get("eval_epoch") or 0)
    inc.archive_dir = str(meta.get("archive_dir") or "")
    rc = rep.get("root_cause")
    if not isinstance(rc, dict) or not (rc.get("statement") or "").strip():
        raise SuiteError("report.json has no root_cause — nothing to fix (incident %s)" % inc.id, 2)
    d = inc.draft
    d["title"] = inc.title or rc.get("statement", "")
    for k in ("statement", "confidence", "confidence_basis", "cause_locus", "cause_locus_basis",
              "severity", "severity_basis", "suggested_fix"):
        key = "root_cause_statement" if k == "statement" else k
        d[key] = str(rc.get(k) or "")
    d["root_cause_chain"] = [str(x) for x in (rc.get("chain") or [])]
    imp, rep_ = rc.get("impact") or {}, rc.get("repro") or {}
    d["impact_scope"], d["impact_magnitude"], d["impact_time_window"] = \
        str(imp.get("scope") or ""), str(imp.get("magnitude") or ""), str(imp.get("time_window") or "")
    d["repro_conditions"], d["repro_frequency"] = str(rep_.get("conditions") or ""), str(rep_.get("frequency") or "")
    ev = []
    for e in rep.get("evidence") or []:
        if not isinstance(e, dict):
            continue
        m = _EV_REF.match(str(e.get("ref") or ""))
        ev.append({"claim": str(e.get("claim") or ""), "tool": str(e.get("tool") or ""),
                   "tool_call_id": m.group(1) if m else "", "query": str(e.get("query") or ""),
                   "time_window": str(e.get("time_window") or ""), "excerpt": ""})
    d["evidence"] = ev
    d["excluded_hypotheses"] = _normalise_draft({"excluded_hypotheses": rep.get("excluded_hypotheses")})["excluded_hypotheses"]
    d["data_gaps"] = [str(x) for x in (rep.get("data_gaps") or [])]
    d["suspect_change"] = str(rep.get("suspect_change") or "")
    d["duplicate_of"] = str(rep.get("duplicate_of") or "")
    suff = rep.get("sufficiency")
    if isinstance(suff, dict):
        inc.sufficiency = {"total": suff.get("total", 0), "grade": suff.get("grade", "")}
    inc.degradations = [str(x) for x in (rep.get("degradations") or [])]
    inc.egress_blocked = bool((rep.get("scrub") or {}).get("egress_blocked"))
    fix = rep.get("fix") or {}
    pr = fix.get("pr") or {}
    if pr.get("state") == "closed" and (pr.get("review_summary") or "").strip():
        inc.review_summary = pr["review_summary"].strip()

    # attachments: upgrade to the archived draft (with excerpts) / rendered issue when reachable
    att = rep.get("attachments") or {}
    for base in (os.path.dirname(os.path.abspath(path)), inc.archive_dir):
        if not base:
            continue
        if att.get("draft"):
            full = read_json(os.path.join(base, att["draft"]))
            if isinstance(full, dict):
                d.update(_normalise_draft(full))
        if att.get("issue_md"):
            md = read_text(os.path.join(base, att["issue_md"]))
            if md:
                inc.report_md, inc.report_md_source = md, "issue.draft.md"
                break
    if not inc.report_md:
        inc.report_md, inc.report_md_source = reconstruct_issue_md(inc), "reconstructed-from-report.json"
        inc.degradations.append("根因节由 report.json 重建（无 issue.draft.md；证据摘录不在 report.json 中）")
    return inc


def reconstruct_issue_md(inc):
    """The 12-section issue render (egress.Render shape) rebuilt from report.json fields."""
    d = inc.draft
    L = ["> 本节由 report.json v1.1 重建，非归档渲染件（incident `%s`）。" % inc.id]
    if inc.sufficiency:
        L[0] += " 证据充分度 **%s/100（%s）**。" % (inc.sufficiency.get("total", 0), inc.sufficiency.get("grade", ""))
    L += ["", "## 1. 问题", "", nz(d["title"], "（未给出）"), "",
          "## 2. 影响面与时间窗", "",
          "- 影响范围：%s" % nz(d["impact_scope"], "未评估"),
          "- 影响量级：%s" % nz(d["impact_magnitude"], "未量化"),
          "- 时间窗：%s" % nz(d["impact_time_window"], "未给出"), "",
          "## 3. 严重程度", "", "**%s** —— %s" % (nz(d["severity"], "未定级"), nz(d["severity_basis"], "未给出定级依据")), "",
          "## 4. 复现条件", "",
          "- 条件：%s" % nz(d["repro_conditions"], "未给出"),
          "- 频率：%s" % nz(d["repro_frequency"], "未给出"), "",
          "## 5. 根因与推理链", "",
          "**根因**：%s" % nz(d["root_cause_statement"], "未定因"), "",
          "**置信度**：%s —— %s" % (nz(d["confidence"], "未评"), nz(d["confidence_basis"], "未说明")), ""]
    if d["cause_locus"]:
        L += ["**根因归属**：%s —— %s" % (d["cause_locus"], nz(d["cause_locus_basis"], "未给依据")), ""]
    if d["root_cause_chain"]:
        L += ["**推理链**：", ""] + ["%d. %s" % (i + 1, s) for i, s in enumerate(d["root_cause_chain"])] + [""]
    L += ["## 6. 证据引用", ""]
    if d["evidence"]:
        L += ["| # | 论断 | 工具 | 时间窗 | 引用 |", "|---|---|---|---|---|"]
        for i, e in enumerate(d["evidence"]):
            ref = "ev://%s/tool/%s" % (inc.id, nz(e["tool_call_id"], "unknown"))
            L.append("| %d | %s | `%s` | %s | `%s` |" % (i + 1, e["claim"].replace("|", "\\|"), e["tool"],
                                                       e["time_window"], ref))
        L += ["", "摘录不在 report.json 中，见归档 `%s`（查询语句：%s）。" % (
            nz(inc.archive_dir, "（未给出）"),
            "；".join("`%s`" % e["query"] for e in d["evidence"] if e["query"]) or "无")]
    else:
        L.append("（无证据条目）")
    L += ["", "## 7. 已排除的假设", ""]
    L += ["- **%s** → %s" % (h["hypothesis"], h["why_ruled_out"]) for h in d["excluded_hypotheses"]] or ["（无）"]
    L += ["", "## 8. 数据缺口", ""]
    L += ["- %s" % g for g in d["data_gaps"]] or ["（无）"]
    L += ["", "## 9. 修复建议（观测侧，仅作参考）", "", nz(d["suggested_fix"], "（无）"), "",
          "## 10. 关联与判重", "",
          "- 嫌疑变更：%s" % nz(d["suspect_change"], "none"),
          "- 疑似重复于：%s" % nz(d["duplicate_of"], "none"), "",
          "## 11. 机器标记", "",
          "<!-- sre-agent:incident=%s fingerprint=%s rule_uid=%s -->" % (inc.id, inc.fingerprint, inc.rule_uid), "",
          "## 12. 签收清单", "",
          "- [ ] 根因方向认可", "- [ ] 影响面评估认可", ""]
    return "\n".join(L)
