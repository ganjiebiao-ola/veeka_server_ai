"""Fix eligibility gate — port of orchestrator/internal/fixgate/eligibility.go, local form.

Not passing is **legal parking, not failure**. Reason names are byte-identical to upstream so
archived eligibility.json files and evals stay comparable. Non-short-circuit: every reason is recorded.
"""
import os
import posixpath
import re

from .common import utc_now

CONF_RANK = {"low": 1, "medium": 2, "high": 3}
SRC_FILE_RE = re.compile(r"[A-Za-z0-9_\-]+\.(php|go|java|py|ts|tsx|js|rb|kt|cs|c|cc|cpp|h|hpp|rs|scala|swift)\b")


def _nz(s, fb):
    return fb if not (s or "").strip() else s


def source_candidates(*texts):
    seen, out = set(), []
    for t in texts:
        for m in SRC_FILE_RE.finditer(t or ""):
            b = posixpath.basename(m.group(0))
            if b not in seen:
                seen.add(b)
                out.append(b)
    return out


def locate(cands, repo_ids, find):
    """find(repo_id, basename) -> [paths]. Returns (repo_id, files, detail)."""
    if not cands:
        return "", [], "根因与修复建议里没有点名任何源文件，无法定位修复目标"
    if not repo_ids:
        return "", [], "config.yaml repos 未配置（TODO(owner)）或均未挂载，没有任何仓库可写"
    if find is None:
        return "", [], "未提供仓库定位器"
    hits = {}
    for rid in repo_ids:
        for c in cands:
            try:
                paths = find(rid, c)
            except Exception as e:  # noqa: BLE001 — surface as a reason, never crash the gate
                return "", [], "在 %s 里查 %s 失败：%s" % (rid, c, e)
            hits.setdefault(rid, []).extend(paths or [])
    matched = sorted(r for r, ps in hits.items() if ps)
    if not matched:
        return "", [], "候选源文件 %s 不在任何已配置仓库（%s）里——够不着，如实停驻" % ("、".join(cands), "、".join(repo_ids))
    if len(matched) == 1:
        rid = matched[0]
        ps = sorted(set(hits[rid]))
        return rid, ps, "%s 命中 %s" % (rid, "、".join(ps))
    return "", [], "候选源文件在多个已配置仓库里都存在（%s），无法确定目标，转人工" % "、".join(matched)


def check(inc, min_confidence, repo_ids, find, dup_pr=None, forced_files=None, forced_repo=""):
    """inc: inputs.Incident. dup_pr: the local pr.json of the duplicate source, if any.
    forced_files/forced_repo: operator override (`claim --repo --file`)."""
    d = inc.draft
    reasons = []

    def add(name, ok, detail):
        reasons.append({"name": name, "ok": bool(ok), "detail": detail})

    mn = (min_confidence or "medium").strip().lower() or "medium"
    got = (d.get("confidence") or "").strip().lower()
    if CONF_RANK.get(got, 0) >= CONF_RANK.get(mn, 2):
        add("置信度达标", True, "%s ≥ %s" % (_nz(got, "未评"), mn))
    else:
        add("置信度达标", False, "%s < %s，根因还不够硬，先不动代码" % (_nz(got, "未评"), mn))

    locus = (d.get("cause_locus") or "").strip().lower()
    basis = (d.get("cause_locus_basis") or "").strip()
    if locus == "":
        add("根因归属=代码缺陷", True, "旧契约草稿未标注 cause_locus（08-19 前），按既有口径放行")
    elif locus == "code_defect":
        add("根因归属=代码缺陷", True, _nz(basis, "code_defect"))
    else:
        add("根因归属=代码缺陷", False,
            "根因归属 %s（%s）——代码只是传播路径，不开修复腿；上游问题只出报告，韧性改动属产品决策" % (locus, _nz(basis, "未给依据")))

    dup = (d.get("duplicate_of") or "").strip()
    if dup == "" or dup.lower() == "none":
        add("非重复件", True, "未判重")
    elif not dup_pr:
        add("非重复件", True, "重复于 %s，但本工作区没有为它开过修复 PR 的记录——本件是同根因第一次可修，不构成阻断；PR 正文应注明前次出现" % dup)
    else:
        add("非重复件", False, "重复于 %s，而本工作区已为它开过 PR %s（状态 %s）——不自动再开 PR，请人工去那条 PR 追记复发或决定返修"
            % (dup, dup_pr.get("url", "?"), dup_pr.get("state", "?")))

    add("预算预留充足", True, "本地形态无预算账本（上游 ledger 未移植）；headless 花费受 config.headless.max_budget_usd 限制")

    if forced_files:
        files = sorted(set(forced_files))
        missing = [f for f in files if not find or not find(forced_repo, posixpath.basename(f)) or f not in find(forced_repo, posixpath.basename(f))]
        if forced_repo and not missing:
            repo, det = forced_repo, "人工指定：%s %s" % (forced_repo, "、".join(files))
        else:
            repo, files, det = "", [], "人工指定的文件在 %s 基线上找不到：%s" % (forced_repo or "?", "、".join(missing or forced_files))
    else:
        cands = source_candidates(d.get("root_cause_statement"), d.get("suggested_fix"), d.get("suspect_change"))
        ids = [forced_repo] if forced_repo and forced_repo in repo_ids else repo_ids
        repo, files, det = locate(cands, ids, find)
    add("修复目标可定位", bool(repo), det)

    passed = all(r["ok"] for r in reasons)
    blocked = "" if passed else next("%s：%s" % (r["name"], r["detail"]) for r in reasons if not r["ok"])
    out = {"passed": passed, "reasons": reasons, "evaluated_at": utc_now(), "min_confidence": mn}
    if passed:
        out["repo"], out["files"] = repo, files
    else:
        out["blocked_reason"] = blocked
    return out


def render_table(el):
    rows = ["| 判据 | 结果 | 说明 |", "|---|---|---|"]
    for r in el["reasons"]:
        rows.append("| %s | %s | %s |" % (r["name"], "✅" if r["ok"] else "❌", r["detail"].replace("|", "\\|")))
    if el.get("passed"):
        rows.append("")
        rows.append("目标：%s → %s" % (el.get("repo"), "、".join(el.get("files") or [])))
    else:
        rows.append("")
        rows.append("停驻：" + el.get("blocked_reason", ""))
    return "\n".join(rows)
