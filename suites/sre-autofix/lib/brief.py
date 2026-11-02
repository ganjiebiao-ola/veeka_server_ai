"""INCIDENT.md renderer — port of cmd/sre-orchestrator/fixbrief.go (contract v4).

The static contract (环境约束 / 任务 1–10 / 产出契约) has ONE source: the marker-delimited block in
skills/incident-fix/SKILL.md. This module splices it verbatim between the incident-specific sections
so a headless agent that cannot discover workspace skills still receives the same contract.
"""
import os
import re
from math import gcd

from .common import SuiteError, read_text

CONTRACT_BEGIN = "<!-- BEGIN incident-fix:contract -->"
CONTRACT_END = "<!-- END incident-fix:contract -->"

# Thin prompt for headless runs (fixbrief.go codesecPrompt): the heavy lifting is INCIDENT.md.
HEADLESS_PROMPT = (
    "按工作目录根下的 INCIDENT.md 执行。那份文件是你唯一的事实来源——\n"
    "你没有任何观测系统的访问权，不要臆造日志或指标。\n\n"
    "不要 commit、不要 push、不要切换/重置分支（push 与建 PR 由外部编排层在人工批准后代做）。"
    "改完把文件留在工作目录即可。\n"
)

PHP_CI_VER = re.compile(r"php-version:\s*['\"]?(\d+\.\d+)")
GO_MOD_VER = re.compile(r"(?m)^go\s+(\d+\.\d+(?:\.\d+)?)")
COMPOSER_RE = re.compile(r"\"php\"\s*:\s*\"([^\"]+)\"")
NODE_ENGINE_RE = re.compile(r"\"node\"\s*:\s*\"([^\"]+)\"")
NODE_CI_VER = re.compile(r"node-version:\s*['\"]?([0-9][\w.]*)")
PY_REQ_RE = re.compile(r"requires-python\s*=\s*['\"]([^'\"]+)['\"]")
PY_CI_VER = re.compile(r"python-version:\s*['\"]?(\d+\.\d+)")


def contract_path(root):
    return os.path.join(root, "skills", "incident-fix", "SKILL.md")


def load_contract(root):
    """The text between the contract markers in skills/incident-fix/SKILL.md (each exactly once)."""
    text = read_text(contract_path(root))
    if text is None:
        raise SuiteError("skills/incident-fix/SKILL.md not found — the suite embeds its contract block")
    if text.count(CONTRACT_BEGIN) != 1 or text.count(CONTRACT_END) != 1:
        raise SuiteError("skills/incident-fix/SKILL.md must contain the contract markers exactly once each")
    body = text.split(CONTRACT_BEGIN, 1)[1].split(CONTRACT_END, 1)[0]
    return body.strip("\n") + "\n"


def detect_runtime(read_at_base, list_files):
    """Deterministic runtime-version probe, trust order as fixbrief.go:181-218 (+ Node/Python).
    Returns "" when nothing is found — never guess a version for the agent."""
    files = list_files() or []
    for f in files:
        if f.startswith(".github/workflows/") and (f.endswith(".yml") or f.endswith(".yaml")):
            c = read_at_base(f)
            if not c:
                continue
            m = PHP_CI_VER.search(c)
            if m:
                return "PHP %s（依据 %s 的 php-version）" % (m.group(1), f)
    c = read_at_base("composer.json")
    if c:
        m = COMPOSER_RE.search(c)
        if m:
            return "PHP %s（依据 composer.json 的 require.php）" % m.group(1)
    c = read_at_base("go.mod")
    if c:
        m = GO_MOD_VER.search(c)
        if m:
            return "Go %s（依据 go.mod）" % m.group(1)
    for f in files:
        if f.startswith(".github/workflows/") and (f.endswith(".yml") or f.endswith(".yaml")):
            c = read_at_base(f)
            if not c:
                continue
            m = NODE_CI_VER.search(c)
            if m:
                return "Node %s（依据 %s 的 node-version）" % (m.group(1), f)
            m = PY_CI_VER.search(c)
            if m:
                return "Python %s（依据 %s 的 python-version）" % (m.group(1), f)
    c = read_at_base(".nvmrc")
    if c and c.strip():
        return "Node %s（依据 .nvmrc）" % c.strip().lstrip("v")
    c = read_at_base("package.json")
    if c:
        m = NODE_ENGINE_RE.search(c)
        if m:
            return "Node %s（依据 package.json 的 engines.node）" % m.group(1)
    c = read_at_base(".python-version")
    if c and c.strip():
        return "Python %s（依据 .python-version）" % c.strip()
    c = read_at_base("pyproject.toml")
    if c:
        m = PY_REQ_RE.search(c)
        if m:
            return "Python %s（依据 pyproject.toml 的 requires-python）" % m.group(1)
    return ""


def style_of(content):
    """(indent, eof_newline, ok) — fixbrief.go styleOf: ≥3 lines of evidence, docblock ' *' lines
    excluded, space width = gcd of leading-space counts (reported only when 2..8)."""
    tabs = spaces = unit = 0
    for line in content.split("\n"):
        if line.startswith("\t"):
            tabs += 1
        elif line.startswith(" "):
            rest = line.lstrip(" ")
            if rest.startswith("*"):
                continue
            spaces += 1
            unit = gcd(unit, len(line) - len(rest))
    eof = content.endswith("\n")
    if tabs >= 3 and tabs > spaces:
        return "tab", eof, True
    if spaces >= 3 and spaces > tabs:
        if 2 <= unit <= 8:
            return "空格×%d" % unit, eof, True
        return "空格", eof, True
    return "", eof, False


def detect_file_style(read_at_base, files):
    notes = []
    for f in list(files or [])[:3]:
        c = read_at_base(f)
        if not c:
            continue
        indent, eof, ok = style_of(c)
        if not ok:
            continue
        notes.append("`%s` 缩进=%s、结尾换行=%s" % (f, indent, "有" if eof else "无"))
    return "；".join(notes)


def render(inc, elig, repo_label, contract, runtime_note="", style_note="", review="",
           last_fail=None, attempt_n=1, checks_note=""):
    """inc: inputs.Incident; elig: eligibility dict (repo/files); repo_label: e.g. 'repos/<id>'.
    last_fail: {"fail_class", "reason"} of the previous attempt (retry) or None."""
    L = ["# INCIDENT %s" % inc.id, ""]
    L += ["## 告警", "",
          "- 规则：%s（%s）｜rule_uid `%s`" % (inc.rid or "—", inc.rule_name or "—", inc.rule_uid or "—"),
          "- 主体：`%s`" % (inc.subject or "—"),
          "- 标题：%s" % (inc.title or inc.draft.get("title") or "—"),
          "- 指纹：`%s`" % (inc.fingerprint or "—"),
          "- 评估时刻：epoch %d" % (inc.eval_epoch or 0), ""]
    L += ["## 根因结论、证据与影响（来自观测面深挖，已过 Egress 脱敏闸口）", "",
          "下面整段是编排层渲染的结构化 bug 报告。**这是你唯一的事实来源**——",
          "你在这个工作目录里没有任何观测系统的访问权，不要臆造日志或指标。",
          "注意「事实来源」指的是**观测事实**（日志、指标、故障链）；报告里若出现",
          "修复建议，那是观测侧的参考输入，**不构成实现约束**——见下方任务 3。", "", "---", "",
          inc.report_md.rstrip("\n"), "", "---", ""]
    L += ["## 修复目标", "", "仓库 `%s`，根因点名的源文件已定位到：" % repo_label]
    L += ["- `%s`" % f for f in (elig.get("files") or [])]
    L += ["", "以上是定位结果，不是限制——如果读代码后判断该改别处，改别处并在 FIXNOTES.md 里说明理由。", ""]
    if (review or "").strip():
        L += ["## 人工评审意见（必须遵照，优先级高于上文的根因结论与修复建议）", "",
              "上一版补丁已提交 PR 并被人工评审**否决**。评审结论如下，逐字引用：", "",
              "> " + review.strip().replace("\n", "\n> "), "",
              "**这次按评审给的方向重写**：",
              "- 被否掉的做法绝不要重复（哪怕你认为它更好——分歧写进 FIXNOTES.md，代码按评审的来）。",
              "- 工作目录已重置回干净基线，上一版改动不在树上；不要试图找回或参考它。",
              "- FIXNOTES.md 里说明新方案与评审意见的对应关系。", ""]
    L += ["## 环境事实（探测自仓库基线；探不到的项按下方环境约束自行核对）", ""]
    L.append("- 目标运行时版本：%s" % (runtime_note or "未探测到——请自己从仓库的 CI 配置或依赖声明里读出来，并在 FIXNOTES.md 里写明你按哪个版本写的"))
    L.append("- 目标文件风格：%s" % (style_note or "未探测到——动手前先确认目标文件用 tab 还是空格缩进、结尾有没有换行"))
    if (checks_note or "").strip():
        L.append("- 验证门将在本工作目录里执行的仓库自检命令：%s ——全部退出码 0 才能过门；"
                 "本机能跑就先自己跑一遍并把结果写进 verification.json 的 `checks[]`（跑不了就如实进 `not_verified[]`）" % checks_note)
    else:
        L.append("- 验证门的仓库自检命令：未配置——门不会替你编译或做静态检查，"
                 "你对签名、引用传参、类型约束这类运行期才暴露的细节的逐行核对是唯一防线")
    L += ["", contract.rstrip("\n"), ""]
    if last_fail and (last_fail.get("fail_class") or last_fail.get("reason")):
        L += ["## 上一轮为什么失败（这是第 %d 次尝试）" % attempt_n, "",
              "- 失败分类：`%s`" % (last_fail.get("fail_class") or "未分类"),
              "- 原因：%s" % (last_fail.get("reason") or "未记录"), "",
              "工作目录已重置回干净基线。**不要原样再做一遍**——先针对上面这条原因调整做法。", ""]
    return "\n".join(L)
