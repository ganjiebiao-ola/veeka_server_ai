"""Deterministic hygiene gate — port of orchestrator/internal/fixgate/fixgate.go.

Four zero-language-knowledge checks: patch non-empty and reverse-applies / diff confined to business
paths (scaffold untracked) / no secrets / verification evidence declared — plus a fifth, local-only
row: the repo's own check commands (`config.yaml repos[].checks`, run by cli.run_gate through
lib/repocheck.py; this module only judges their recorded results). It does NOT replicate CI and does
NOT run regression (fixgate.go:4-16). Pure data in, so it replays on archived fixtures.
"""
import json
import posixpath

from . import scrub as _scrub

FAIL_PATCH_EMPTY = "patch_empty"
FAIL_PATCH_NOT_APPLICABLE = "patch_not_applicable"
FAIL_DIFF_OUT_OF_SCOPE = "diff_out_of_scope"
FAIL_SCAFFOLD_TRACKED = "scaffold_tracked"
FAIL_SECRET_HIT = "secret_hit"
FAIL_VERIFICATION_FAILED = "verification_failed"
FAIL_AGENT_ERROR = "agent_error"      # upstream: codesec_error
FAIL_AGENT_MISSING = "agent_missing"  # local only
FAIL_TIMEOUT = "timeout"
FAIL_REPO_CHECK = "repo_check_failed"  # local only: a `repos[].checks` command exited non-zero
FAIL_CLASSES = (FAIL_PATCH_EMPTY, FAIL_PATCH_NOT_APPLICABLE, FAIL_DIFF_OUT_OF_SCOPE, FAIL_SCAFFOLD_TRACKED,
                FAIL_SECRET_HIT, FAIL_VERIFICATION_FAILED, FAIL_AGENT_ERROR, FAIL_AGENT_MISSING, FAIL_TIMEOUT,
                FAIL_REPO_CHECK)

CHECK_PATCH = "补丁非空且能干净应用"
CHECK_SCOPE = "改动限定在业务路径"
CHECK_SECRET = "补丁不含密钥"
CHECK_VERIFY = "验证证据已申报"
CHECK_REPO = "仓库自检命令通过"


def first_line(s, limit=200):
    line = (s or "").strip().split("\n", 1)[0]
    return line[:limit] + "…" if len(line) > limit else line


def diff_size(diff):
    add = dele = 0
    for l in (diff or "").split("\n"):
        if l.startswith("+++") or l.startswith("---"):
            continue
        if l.startswith("+"):
            add += 1
        elif l.startswith("-"):
            dele += 1
    return "+%d/-%d" % (add, dele)


def in_scope(file, include):
    f = posixpath.normpath(file)
    for p in include or []:
        p = (p or "").strip()
        if not p:
            continue
        if p.endswith("/"):
            if f.startswith(posixpath.normpath(p) + "/"):
                return True
            continue
        if f == posixpath.normpath(p) or f.startswith(posixpath.normpath(p) + "/"):
            return True
    return False


def out_of_scope(files, include):
    return [f for f in files if not in_scope(f, include)]


def match_scaffold(files, scaffold):
    hit = []
    for f in files:
        fc = posixpath.normpath(f)
        for s in scaffold or []:
            sc = posixpath.normpath(s.rstrip("/"))
            if fc == sc or fc.startswith(sc + "/"):
                hit.append(f)
                break
    return hit


def verification_ok(raw):
    """Tolerant parse: only all_passed + checks[].{name,passed} are mandatory (fixgate.go:176-220)."""
    if not (raw or "").strip():
        return "修复 agent 没有产出 .sre-evidence/verification.json", False
    try:
        v = json.loads(raw)
    except ValueError as e:
        return "verification.json 不是合法 JSON：" + first_line(str(e)), False
    if not isinstance(v, dict):
        return "verification.json 顶层不是对象", False
    if "all_passed" not in v or not isinstance(v.get("all_passed"), bool):
        return "verification.json 缺 all_passed 字段", False
    checks = v.get("checks")
    if not isinstance(checks, list) or len(checks) == 0:
        return "verification.json 里 checks 为空——没有任何可核对的验证项", False
    failed = []
    for i, c in enumerate(checks):
        name = (c.get("name") if isinstance(c, dict) else "") or ""
        if not name.strip():
            name = "#%d" % (i + 1)
        passed = c.get("passed") if isinstance(c, dict) else None
        if passed is not True:
            failed.append(name)
    if failed:
        return "验证项未通过：" + "、".join(failed), False
    if not v["all_passed"]:
        return "逐项均通过但 all_passed=false，以 agent 的总结论为准", False
    return "%d 项验证全部通过（口径以修复 agent 自述为准，不代表已过目标仓库 CI）" % len(checks), True


def repo_checks_ok(rc, repo_id, patch_empty):
    """rc: {configured: bool, results: [{cmd, code, elapsed_sec, output}]} or None (not configured).
    Returns (detail, ok). Not configured is a pass with a loud detail — the operator chose to have no
    compile/static step; an empty patch is a fail (nothing was checked)."""
    if not rc or not rc.get("configured"):
        return ("未配置（config.yaml repos[%s].checks 为空）——只有修复 agent 自述的验证证据，"
                "编译期/运行期错误可穿透；`run doctor` 会按本仓给出建议" % (repo_id or "?")), True
    if patch_empty:
        return "未执行：补丁为空，无可检", False
    results = rc.get("results") or []
    if not results:
        return "已配置但没有任何执行记录", False
    bad = [r for r in results if r.get("code") != 0]
    if bad:
        b = bad[0]
        why = first_line(b.get("output") or "")
        code = b.get("code")
        return "`%s` 退出 %s%s%s" % (b.get("cmd"), code, "（超时被杀）" if code == 124 else "",
                                    ("：" + why) if why else ""), False
    return "%d 条命令全部退出 0：%s" % (
        len(results), "、".join("`%s`（%.1fs）" % (r.get("cmd"), r.get("elapsed_sec") or 0.0) for r in results)), True


def evaluate(inp, policy):
    """inp: {diff, reverse_applies, reverse_err, changed_files, untracked, verification_json,
    extra_secrets, repo_checks}. policy: {include: [...], scaffold: [...], repo_id}. Non-short-circuit."""
    checks = []
    first = [None, None]  # (check, fail_class)

    def rec(c, cls):
        checks.append(c)
        if not c["passed"] and first[0] is None:
            first[0], first[1] = c, cls

    diff = inp.get("diff") or ""
    changed = list(inp.get("changed_files") or [])
    include = policy.get("include") or []
    scaffold = policy.get("scaffold") or []

    c1 = {"name": CHECK_PATCH, "passed": False, "detail": ""}
    if not diff.strip():
        c1["detail"] = "工作目录没有任何改动——修复 agent 没能产出补丁"
        rec(c1, FAIL_PATCH_EMPTY)
    elif not inp.get("reverse_applies"):
        c1["detail"] = "补丁无法反向干净应用：" + first_line(inp.get("reverse_err") or "")
        rec(c1, FAIL_PATCH_NOT_APPLICABLE)
    else:
        c1["passed"] = True
        c1["detail"] = "%d 个文件、%s" % (len(changed), diff_size(diff))
        rec(c1, "")

    c2 = {"name": CHECK_SCOPE, "passed": False, "detail": ""}
    sc = match_scaffold(changed, scaffold)
    oos = out_of_scope(changed, include)
    if sc:
        c2["detail"] = "SRE 交接件被纳入改动，必须留未跟踪：" + "、".join(sc)
        rec(c2, FAIL_SCAFFOLD_TRACKED)
    elif oos:
        c2["detail"] = "越界文件 %s（允许范围 %s）" % ("、".join(oos), "、".join(include) or "（空）")
        rec(c2, FAIL_DIFF_OUT_OF_SCOPE)
    else:
        c2["passed"] = True
        c2["detail"] = "全部落在 " + "、".join(include)
        untracked = list(inp.get("untracked") or [])
        if untracked:
            c2["detail"] += "；另有 %d 个新建文件未纳入提交（%s）" % (len(untracked), "、".join(untracked))
        rec(c2, "")

    c3 = {"name": CHECK_SECRET, "passed": False, "detail": ""}
    hits = _scrub.scan_secrets(diff, inp.get("extra_secrets") or ())
    if hits:
        c3["detail"] = "命中 " + "、".join(hits)
        rec(c3, FAIL_SECRET_HIT)
    else:
        c3["passed"] = True
        c3["detail"] = "未命中任何密钥模式"
        rec(c3, "")

    c4 = {"name": CHECK_VERIFY, "passed": False, "detail": ""}
    detail, ok = verification_ok(inp.get("verification_json"))
    c4["passed"], c4["detail"] = ok, detail
    rec(c4, "" if ok else FAIL_VERIFICATION_FAILED)

    c5 = {"name": CHECK_REPO, "passed": False, "detail": ""}
    detail, ok = repo_checks_ok(inp.get("repo_checks"), policy.get("repo_id"), not diff.strip())
    c5["passed"], c5["detail"] = ok, detail
    rec(c5, "" if ok else FAIL_REPO_CHECK)

    res = {"checks": checks, "passed": first[0] is None}
    if res["passed"]:
        res["files"] = changed
    else:
        res["fail_class"] = first[1]
        res["reason"] = first[0]["name"] + "：" + first[0]["detail"]
        res["files"] = []
    return res


def gate_summary(checks):
    if not checks:
        return "未运行"
    n = sum(1 for c in checks if c.get("passed"))
    names = "补丁可干净应用 / 改动限定业务路径 / 无密钥 / 测试证据已申报"
    if any(c.get("name") == CHECK_REPO for c in checks):
        names += " / 仓库自检命令"
    return "%d/%d 项通过（%s）" % (n, len(checks), names)


def render_table(res):
    rows = ["| 检查 | 结果 | 说明 |", "|---|---|---|"]
    for c in res["checks"]:
        rows.append("| %s | %s | %s |" % (c["name"], "✅" if c["passed"] else "❌", c["detail"].replace("|", "\\|")))
    return "\n".join(rows)
