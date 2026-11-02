"""PR title / body / commit message — port of orchestrator/internal/egress/pr.go (+ Rate from
egress.go, commitMessage from fixleg.go). Local-form deltas: no cost ledger (cost line states n/a),
`Refs #<n>` only when the operator passes --issue, closing keywords are rewritten to `Refs`, and no
AI signature anywhere.
"""
import re

from . import scrub as _scrub
from .common import nz, one_line, one_line_trim
from .gate import gate_summary

FILE_RE = re.compile(r"^\+\+\+ b/(.+)$")
HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
CLOSING_RE = re.compile(r"(?im)^(\s*)(closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)(\s+#\d+)")


def rate(draft):
    """Sufficiency score v0 (egress.go Rate) — display only, never a gate."""
    total, detail = 0, []

    def add(pts, why):
        nonlocal total
        total += pts
        detail.append("%+d %s" % (pts, why))

    ev = draft.get("evidence") or []
    n = len(ev)
    if n >= 5:
        add(25, "证据 %d 条" % n)
    elif n >= 3:
        add(18, "证据 %d 条" % n)
    elif n >= 1:
        add(10, "证据仅 %d 条" % n)
    else:
        add(0, "无证据条目")
    if n:
        with_ref = sum(1 for e in ev if (e.get("tool_call_id") or "").strip() and (e.get("query") or "").strip())
        ratio = with_ref * 100 // n
        add(ratio * 20 // 100, "%d%% 的证据可回指（有 tool_call_id + 查询语句）" % ratio)
    chain = draft.get("root_cause_chain") or []
    if not chain:
        add(0, "无推理链")
    elif len(chain) <= 2:
        add(8, "推理链偏短")
    else:
        add(15, "推理链 %d 步" % len(chain))
    ex = len(draft.get("excluded_hypotheses") or [])
    if ex:
        add(min(ex * 5, 15), "排除了 %d 个假设" % ex)
    else:
        add(0, "没有记录被排除的假设")
    conf = (draft.get("confidence") or "").lower()
    if conf == "high":
        add(10, "自评置信度高")
    elif conf == "medium":
        add(6, "自评置信度中")
    else:
        add(2, "自评置信度低")
    mag = draft.get("impact_magnitude") or ""
    if mag.strip() and any(ch.isdigit() for ch in mag):
        add(10, "影响面有量级数字")
    else:
        add(0, "影响面缺量级数字")
    gaps = draft.get("data_gaps") or []
    if gaps:
        add(0, "申报了 %d 项数据缺口（不扣分，如实申报是加分项的前提）" % len(gaps))
    total = max(0, min(100, total))
    grade = "充分" if total >= 75 else "基本可评审" if total >= 50 else "偏薄" if total >= 25 else "不足"
    return {"total": total, "grade": grade, "detail": detail}


def locus_label(l):
    return {
        "code_defect": "代码缺陷（code_defect）", "dependency_failure": "依赖故障（dependency_failure）",
        "infra": "基础设施（infra）", "config": "配置（config）", "capacity": "容量（capacity）",
        "unknown": "未定（unknown）",
    }.get((l or "").strip().lower(), l)


def strip_hedge(s):
    for p in ("未定因。", "未定因，", "未定因:", "未定因：", "未定因"):
        if s.startswith(p):
            return s[len(p):].strip()
    return s


def pr_title(draft, files):
    scope = "fix"
    if len(files) == 1:
        parts = files[0].split("/")
        if len(parts) > 1:
            scope = "fix(%s)" % parts[-2]
    t = one_line((draft.get("title") or "").strip())
    if not t:
        t = one_line((draft.get("root_cause_statement") or "").strip())
    t = strip_hedge(t)
    if len(t) > 72:
        t = t[:72] + "…"
    return scope + ": " + t


def commit_message(draft, files):
    subject = (draft.get("root_cause_statement") or "").strip() or (draft.get("title") or "").strip()
    subject = one_line_trim(subject, 68).replace("\n", " ")
    out = subject + "\n\n"
    fix = (draft.get("suggested_fix") or "").strip()
    if fix:
        out += one_line_trim(fix, 400) + "\n\n"
    out += "Files: " + ", ".join(files) + "\n"
    return out


def fix_summary(fixnotes):
    fn = (fixnotes or "").strip()
    if not fn:
        return ""
    for h in ("## 改了什么", "## What changed", "## Changes"):
        i = fn.find(h)
        if i >= 0:
            body = fn[i + len(h):]
            j = body.find("\n## ")
            if j >= 0:
                body = body[:j]
            return body.strip()
    keep = []
    for l in fn.split("\n", 8)[:8]:
        l = l.strip().lstrip("#").strip()
        if l:
            keep.append(l)
        if len(keep) == 3:
            break
    return "\n".join(keep)


def diff_stat(diff):
    add = dele = 0
    for l in (diff or "").split("\n"):
        if l.startswith("+++") or l.startswith("---"):
            continue
        if l.startswith("+"):
            add += 1
        elif l.startswith("-"):
            dele += 1
    return add, dele


def hunk_list(diff):
    out, cur = [], ""
    lines = (diff or "").split("\n")
    for i, line in enumerate(lines):
        m = FILE_RE.match(line)
        if m:
            cur = m.group(1)
            continue
        m = HUNK_RE.match(line)
        if not m:
            continue
        span = m.group(1)
        if m.group(2) and m.group(2) != "0" and int(m.group(2)) > 1:
            span += "–%d" % (int(m.group(1)) + int(m.group(2)) - 1)
        first = ""
        for j in range(i + 1, min(len(lines), i + 40)):
            l = lines[j]
            if l.startswith("@@") or l.startswith("diff --git"):
                break
            if (l.startswith("+") or l.startswith("-")) and l[1:].strip():
                first = l.strip()
                break
        out.append({"file": cur, "lines": span, "first": first})
        if len(out) >= 20:
            break
    return out


def machine_tag(inc):
    parts = ["incident=" + inc.id, "fingerprint=" + inc.fingerprint, "rule_uid=" + inc.rule_uid,
             "eval_epoch=%d" % (inc.eval_epoch or 0)]
    return " ".join(sorted(parts))


def short_sha(s):
    return s[:8] if len(s) > 8 else (s or "（无）")


def render(inc, meta, extra_secrets=()):
    """meta: {repo, branch, base_sha, commit_sha, files, diff, checks, attempts, fixnotes,
    verification_summary, refs_issue, archive_dir}. Returns (body, blocked, block_reason, findings)."""
    d = inc.draft
    score = rate(d)
    b = []
    w = b.append
    w("## 10 分钟评审路径\n")
    w("本 PR 由 Agentic SRE 从一条线上告警产出：告警 → 验真 → 观测面深挖 → 根因报告 → 代码修复（本地 suites/sre-autofix）。")
    w("对应 incident `%s`，证据充分度 **%d/100（%s）**。\n" % (inc.id, score["total"], score["grade"]))
    w("| 检查 | 结果 | 说明 |\n|---|---|---|")
    for c in meta.get("checks") or []:
        w("| %s | %s | %s |" % (one_line(c["name"]), "✅" if c["passed"] else "❌", one_line(c["detail"])))
    add, dele = diff_stat(meta.get("diff"))
    w("| 补丁规模 | — | %d 个文件，+%d/-%d |" % (len(meta.get("files") or []), add, dele))
    w("| 本地验证口径 | — | 以修复 agent 自述为准；**语法/风格/编译由本仓库 CI 判定**，见上方 checks |")
    if (meta.get("attempts") or 1) > 1:
        w("| 尝试次数 | — | 第 %d 次才通过验证门 |" % meta["attempts"])
    w("\n**成本**：观测面调查见上游报告；代码修复由操作者本机 agent 执行（%s）\n" % (meta.get("cost_note") or "本地形态不计账"))
    if inc.degradations:
        w("\n> **降级口径**：%s\n" % "；".join(inc.degradations))
    if d.get("needs_human"):
        w("\n> **模型自评需要人工介入**：%s\n" % nz(d.get("needs_human_reason"), "未说明"))
    if meta.get("refs_issue"):
        w("\nRefs #%d\n" % int(meta["refs_issue"]))

    w("\n## 一、精简版：根因与修法\n")
    w("**问题**：%s\n" % d.get("title", ""))
    w("**严重程度**：%s\n" % nz(d.get("severity"), "未定级"))
    w("**根因**：%s\n" % nz(d.get("root_cause_statement"), "未定因"))
    w("**置信度**：%s\n" % nz(d.get("confidence"), "未评"))
    if (d.get("cause_locus") or "").strip():
        w("**根因归属**：%s\n" % locus_label(d["cause_locus"]))
    if (d.get("root_cause_statement") or "").strip().startswith("未定因"):
        w("> ⚠️ **深层未定因**：本修法是直接层处置。评审请优先判断修复方向是否成立，而不只是代码对不对。\n")
    w("**本次修法**：")
    for f in meta.get("files") or []:
        w("- `%s`" % f)
    fs = fix_summary(meta.get("fixnotes"))
    if fs:
        w("\n" + fs + "\n")
    hunks = hunk_list(meta.get("diff"))
    if hunks:
        w("\n改动位置（逐 hunk，便于对照推理链走查）：\n")
        w("| 文件 | 行 | 首行改动 |\n|---|---|---|")
        for h in hunks:
            w("| `%s` | %s | `%s` |" % (h["file"], h["lines"], one_line(h["first"])))

    w("\n## 二、完整证据链（供深查，默认折叠）\n")
    w("<details><summary>影响面、复现条件与完整推理链</summary>\n")
    w("**影响范围**：%s\n\n**影响量级**：%s\n\n**时间窗**：%s\n" % (
        nz(d.get("impact_scope"), "未评估"), nz(d.get("impact_magnitude"), "未量化"), nz(d.get("impact_time_window"), "未给出")))
    w("**定级依据**：%s\n" % nz(d.get("severity_basis"), "未给出"))
    w("**复现条件**：%s\n\n**复现频率**：%s\n" % (nz(d.get("repro_conditions"), "未给出"), nz(d.get("repro_frequency"), "未给出")))
    w("**置信度依据**：%s\n" % nz(d.get("confidence_basis"), "未说明"))
    chain = d.get("root_cause_chain") or []
    if chain:
        w("**推理链**（标注为数据支撑的步骤，其证据见下方证据表同名论断）：\n")
        for i, s in enumerate(chain):
            w("%d. %s" % (i + 1, s))
    w("\n</details>\n")
    w("<details><summary>证据引用（逐条可回指复算）、已排除的假设与数据缺口</summary>\n")
    ev = d.get("evidence") or []
    if not ev:
        w("（无证据条目——这本身是个问题，评审时请要求补充）")
    else:
        w("| # | 论断 | 工具 | 时间窗 | 引用 |\n|---|---|---|---|---|")
        for i, e in enumerate(ev):
            ref = "ev://%s/tool/%s" % (inc.id, nz(e.get("tool_call_id"), "unknown"))
            w("| %d | %s | `%s` | %s | `%s` |" % (i + 1, one_line(e.get("claim")), e.get("tool", ""), one_line(e.get("time_window")), ref))
        w("")
        for i, e in enumerate(ev):
            w("**%d. %s**\n\n- 查询：`%s`\n- 摘录：%s\n" % (i + 1, one_line(e.get("claim")), one_line(e.get("query")),
                                                   e.get("excerpt") or "（摘录不在 report.json 中，见归档）"))
    ex = d.get("excluded_hypotheses") or []
    if ex:
        w("**已排除的假设**：\n")
        for h in ex:
            w("- **%s** → %s" % (one_line(h.get("hypothesis")), one_line(h.get("why_ruled_out"))))
        w("")
    gaps = d.get("data_gaps") or []
    if gaps:
        w("**数据缺口**：\n")
        for g in gaps:
            w("- %s" % g)
        w("")
    w("全量原始证据（SSE 全事件、工具调用逐条、超限件全量）在归档目录 `%s`，**不外发**；上表引用可逐条抽检复算。" % nz(meta.get("archive_dir") or inc.archive_dir, "（未给出）"))
    w("\n</details>\n")
    fn = (meta.get("fixnotes") or "").strip()
    if fn:
        w("<details><summary>修复说明全文（由产出补丁的代码运行时撰写）</summary>\n")
        w(fn)
        w("\n</details>\n")
    else:
        w("（未产出修复说明——评审时请要求补充改动理由）\n")

    w("### 验证方式\n")
    w("- 编排层确定性验证门：%s" % gate_summary(meta.get("checks") or []))
    w("- 测试证据：%s" % nz(meta.get("verification_summary"), "未申报"))
    w("- **语法、风格与编译正确性以本仓库 CI 的结论为准**——本 suite 不复刻 CI，也不读它的结果，请直接看 PR 上方的检查状态。")
    w("- 回归验证不在本 PR 范围（属于后续环节），因此**这个补丁没有跑过端到端回归**。")

    w("\n### 关联与判重\n")
    dup = nz(d.get("duplicate_of"), "")
    w("疑似重复于：%s" % dup if dup else "未发现重复（判断不可得时默认新建，宁重勿漏）。")
    w("\n- 告警规则：%s %s（`%s`）\n- 主体：`%s`\n- 指纹：`%s`\n- 评估时刻：epoch %d" % (
        inc.rid, inc.rule_name, inc.rule_uid, inc.subject, inc.fingerprint, inc.eval_epoch or 0))
    w("- 分支：`%s`｜基线：`%s`｜提交：`%s`" % (meta.get("branch", ""), short_sha(meta.get("base_sha", "")), short_sha(meta.get("commit_sha", ""))))

    w("\n### 机器标记\n")
    w("<!-- sre-agent:%s -->" % machine_tag(inc))
    w("（上面这行 HTML 注释是幂等标记，请勿删除）")

    w("\n### 签收清单\n")
    w("- [ ] 根因方向认可（不认可请在评论区写明分歧点，会据此重查）")
    w("- [ ] 补丁方向认可（若认为应改在别处，请写明，下一轮会换方向）")
    w("- [ ] 影响面评估认可")
    w("- [ ] 或：不要自动修复这类问题（评论区说明即可，后续同类不再自动提 PR）")
    w("\n<sub>充分度评分明细：%s</sub>" % "；".join(score["detail"]))

    body = "\n".join(b) + "\n"
    # never let a closing keyword auto-close an issue on merge — the PR is not the issue's state carrier
    body = CLOSING_RE.sub(lambda m: m.group(1) + "Refs" + m.group(3), body)
    scrubbed, findings = _scrub.scrub(body, extra_secrets)
    blocked = any(f.get("blocked") for f in findings)
    reason = ""
    if blocked:
        name = next(f["name"] for f in findings if f.get("blocked"))
        reason = "PR 正文命中密钥模式（%s），已阻断外发并转人工" % name
    return scrubbed, blocked, reason, findings
