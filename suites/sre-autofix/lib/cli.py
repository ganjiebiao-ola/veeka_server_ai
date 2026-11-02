#!/usr/bin/env python3
"""suites/sre-autofix CLI — verbs: doctor | claim | plan | fix | gate | ship | release.

Exit codes: 0 ok · 1 error · 2 usage · 3 parked (eligibility not passed — legal, not an error) ·
4 gate failed · 5 blocked (harness denied / no tty, or PR body egress-blocked).
"""
import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import brief, config as _config, eligibility, gate as _gate, headless, inputs, prbody, repocheck, ship as _ship, suggest as _suggest  # noqa: E402
from lib import scrub as _scrub  # noqa: E402
from lib.common import SuiteError, first_line, read_text, require_python, utc_now  # noqa: E402
from lib.state import RunDir  # noqa: E402
from lib.workspace import Worktree  # noqa: E402

EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_PARKED, EXIT_GATE_FAILED, EXIT_BLOCKED = 0, 1, 2, 3, 4, 5


def say(msg):
    print(msg, flush=True)


def warn(msg):
    print(msg, file=sys.stderr, flush=True)


class Ctx:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.cfg = _config.load(self.root)
        self.ws_repos = _config.load_workspace_repos(self.root)
        self.extra_secrets = _scrub.load_extra_secrets(os.environ.get("SRE_AUTOFIX_EXTRA_SECRETS_FILE"))

    def usable(self):
        return _config.usable_repos(self.cfg, self.ws_repos)

    def worktree_for(self, rd, repo_id):
        rc = self.cfg.repo(repo_id)
        if rc is None or repo_id not in self.ws_repos:
            raise SuiteError("repo %s is not configured in config.yaml / registered in workspace.yaml" % repo_id)
        return rc, Worktree(self.ws_repos[repo_id], rd.worktree, "autofix/" + rd.incident_id, rd.path("git_exclude"),
                            remote=rc.remote, base=rc.base, scaffold=self.cfg.scaffold, extra_secrets=self.extra_secrets)


# ---------------------------------------------------------------- doctor
def cmd_doctor(ctx, a):
    """One-shot readiness check: what the runbook's prerequisites table asks, as a command."""
    from lib.common import run
    rows = []          # (level, name, ok, detail, extra_lines)   level: MUST | GATE | SHIP | HEADLESS

    def row(level, name, ok, detail, extra=None):
        rows.append((level, name, bool(ok), detail, list(extra or [])))

    row("MUST", "python3 >= 3.8", sys.version_info >= (3, 8), "%d.%d.%d" % sys.version_info[:3])
    cfg_file, cfg_why = _config.config_source(ctx.root)
    row("MUST", "config file in effect", os.path.isfile(cfg_file), "%s — %s" % (os.path.relpath(cfg_file, ctx.root) if cfg_file.startswith(ctx.root) else cfg_file, cfg_why))
    row("MUST", "git", shutil.which("git") is not None, shutil.which("git") or "not on PATH")
    row("MUST", "scripts/lib/harness.sh", os.path.isfile(os.path.join(ctx.root, "scripts", "lib", "harness.sh")),
        "destructive-action gate used by ship")
    row("MUST", "skills/incident-fix/SKILL.md contract block",
        os.path.isfile(brief.contract_path(ctx.root)) and _contract_ok(ctx.root), brief.contract_path(ctx.root))
    usable, notes = ctx.usable()
    row("MUST", "config.yaml repos (no TODO, registered, mounted)", bool(usable),
        "、".join("%s → %s" % (r.id, p) for r, p in usable) or "; ".join(notes) or "none configured")
    for r, p in usable:
        row("MUST", "config.yaml repos[%s].scope" % r.id, r.scope_ok(), "、".join(r.scope) or "empty")
        if r.checks_configured():
            bins = repocheck.binaries(r.checks)
            missing = [b for b in bins if not shutil.which(b)]
            row("GATE", "config.yaml repos[%s].checks" % r.id, not missing,
                "%d command(s): %s" % (len(r.checks), "; ".join(r.checks)) +
                ("; NOT on PATH: " + ", ".join(missing) if missing else ""))
        else:
            # not configured → say what THIS repo suggests, from its own CI and toolchain markers
            read, lst = _suggest.fs_readers(p)
            sg = _suggest.suggest(read, lst, brief.detect_runtime(read, lst))
            row("GATE", "config.yaml repos[%s].checks" % r.id, False,
                "not configured — gate row 5 only records 『未配置』; a compile/runtime error passes through. "
                "Paste one of these into config.yaml and re-run doctor:", _suggest.render_lines(sg, r.id))
        gh_ok = bool(r.github) and not _config.is_placeholder(r.github)
        row("SHIP", "config.yaml repos[%s].github" % r.id, True,
            r.github if gh_ok else "TODO → will be derived from `git remote get-url %s`" % r.remote)
    # read the operator's own identity unscrubbed: this is a self-check shown only to them
    import subprocess
    def _gitcfg(key):
        if not shutil.which("git"):
            return ""
        return subprocess.run(["git", "config", key], capture_output=True, text=True).stdout.strip()
    name, email = _gitcfg("user.name"), _gitcfg("user.email")
    row("SHIP", "git identity (user.name / user.email)", bool(name and email), "%s <%s>" % (name or "?", email or "?"))
    gh = shutil.which("gh")
    gh_auth = run(["gh", "auth", "status"], wall=20).code == 0 if gh else False
    row("SHIP", "gh auth status", gh_auth, "logged in" if gh_auth else ("gh not on PATH" if not gh else "run `gh auth login`"))
    agents = headless.available_agents()
    hl = ctx.cfg.headless
    row("HEADLESS", "agent CLI on PATH (claude / codex / opencode)", bool(agents) or bool(hl.get("command")),
        (", ".join(agents) or "none") + ("; config.yaml headless.command set" if hl.get("command") else "") +
        "; selected: " + (("custom" if hl.get("command") else headless.detect_agent(hl.get("agent"))) or "none"))
    row("HEADLESS", "interactive mode", True, "always available — the agent session you are in reads INCIDENT.md")

    width = max(len(n) for _, n, _, _, _ in rows)
    bad_must = 0
    for level, name_, ok, detail, extra in rows:
        mark = "OK  " if ok else ("MISS" if level == "MUST" else "WARN")
        if not ok and level == "MUST":
            bad_must += 1
        say("  [%s] %-8s %-*s  %s" % (mark, level, width, name_, detail))
        for line in extra:
            say("  %s ↳ %s" % (" " * 15, line))
    if bad_must:
        warn("doctor: %d MUST item(s) missing — claim/plan/gate will not work until fixed" % bad_must)
        return EXIT_ERROR
    say("doctor: ready (GATE/SHIP/HEADLESS warnings, if any, only affect gate strictness / ship / --headless)")
    return EXIT_OK


def _contract_ok(root):
    try:
        brief.load_contract(root)
        return True
    except SuiteError:
        return False


# ---------------------------------------------------------------- claim
def cmd_claim(ctx, a):
    inc, kind, resolved = inputs.load(a.input)
    if inc.egress_blocked:
        raise SuiteError("上游报告标记 scrub.egress_blocked=true（命中密钥模式），拒收——请上游清理后再交", EXIT_USAGE)
    rd = RunDir(ctx.root, inc.id)
    if rd.exists() and rd.phase_at_least("planned") and not a.reclaim:
        raise SuiteError("%s 已经 plan 过（phase=%s）；重新认领会改变目标仓，需要 --reclaim（并先 release）" % (inc.id, rd.phase()))

    usable, notes = ctx.usable()
    trees = {}
    for rc, path in usable:
        wt = Worktree(path, rd.worktree, "autofix/" + inc.id, rd.path("git_exclude"), remote=rc.remote, base=rc.base,
                      scaffold=ctx.cfg.scaffold, extra_secrets=ctx.extra_secrets)
        try:
            _, _, note = wt.resolve_base_ref()
            if note:
                notes.append("%s：%s" % (rc.id, note))
            trees[rc.id] = wt
        except SuiteError as e:
            notes.append("%s：%s" % (rc.id, e))

    def find(repo_id, basename):
        wt = trees.get(repo_id)
        if wt is None:
            return []
        from lib.workspace import match_basename
        return match_basename(wt.list_files_at_base(), basename)

    dup_pr = None
    dup = (inc.draft.get("duplicate_of") or "").strip()
    if dup and dup.lower() != "none":
        drd = RunDir(ctx.root, dup)
        dup_pr = drd.read("pr") if drd.exists() else None
    el = eligibility.check(inc, a.min_confidence or ctx.cfg.min_confidence, sorted(trees.keys()), find,
                           dup_pr=dup_pr, forced_files=a.file or None, forced_repo=a.repo or "")
    if el.get("passed"):
        el["base_ref"] = trees[el["repo"]].base_ref
        el["base_sha"] = trees[el["repo"]].base_sha
    el["notes"] = notes

    say("incident %s（输入：%s %s）" % (inc.id, kind, resolved))
    say(eligibility.render_table(el))
    for n in notes:
        say("- 注：" + n)
    if a.dry_run:
        return EXIT_OK if el["passed"] else EXIT_PARKED

    rd.ensure()
    rd.write("input", {"kind": kind, "path": resolved, "claimed_at": utc_now(),
                       "sha256": inputs.sha256_file(resolved) if os.path.isfile(resolved) else ""})
    rd.write("incident", inc.to_dict())
    with open(rd.path("issue_md"), "w", encoding="utf-8") as f:
        f.write(inc.report_md)
    rd.write("eligibility", el)
    if not el["passed"]:
        rd.set_phase("parked", el["blocked_reason"])
        warn("parked: " + el["blocked_reason"])
        return EXIT_PARKED
    rd.set_phase("claimed", "目标 %s %s" % (el["repo"], "、".join(el["files"])), repo=el["repo"])
    say("下一步：suites/sre-autofix/run plan %s" % inc.id)
    return EXIT_OK


# ---------------------------------------------------------------- plan
def load_incident(rd):
    d = rd.read("incident")
    if not d:
        raise SuiteError("%s 没有 claim 记录（runs/sre-autofix/%s/incident.json 不存在）" % (rd.incident_id, rd.incident_id))
    return inputs.Incident.from_dict(d, read_text(rd.path("issue_md"), ""))


def render_brief(ctx, rd, inc, el, wt, rc, review, last_fail=None, attempt_n=1):
    contract = brief.load_contract(ctx.root)
    runtime_note = brief.detect_runtime(wt.read_file_at_base, wt.list_files_at_base)
    style_note = brief.detect_file_style(wt.read_file_at_base, el.get("files") or [])
    checks_note = repocheck.describe(rc.checks) if rc.checks_configured() else ""
    return brief.render(inc, el, "repos/%s（%s）" % (rc.id, wt.github_repo() or rc.github or "remote unknown"),
                        contract, runtime_note, style_note, review, last_fail, attempt_n, checks_note)


def cmd_plan(ctx, a):
    rd = RunDir(ctx.root, a.incident)
    inc = load_incident(rd)
    el = rd.read("eligibility") or {}
    if not el.get("passed"):
        raise SuiteError("%s 未通过资格闸（%s），没有可 plan 的目标" % (a.incident, el.get("blocked_reason", "未 claim")), EXIT_PARKED)
    rc, wt = ctx.worktree_for(rd, el["repo"])
    if not rc.scope_ok():
        raise SuiteError("config.yaml repos[%s].scope 为空或仍是 TODO(owner)：空白名单会让每个补丁都判越界，先填好" % rc.id)
    if not a.no_fetch and not a.dry_run:
        try:
            wt.fetch_base()
        except SuiteError as e:
            warn("fetch %s %s 失败（%s）；退化为本地基线" % (rc.remote, rc.base, first_line(str(e))))
    ref, sha, note = wt.resolve_base_ref()
    review = ""
    if a.review:
        review = read_text(a.review)
        if review is None:
            raise SuiteError("--review 文件不存在：%s" % a.review, EXIT_USAGE)
    elif inc.review_summary:
        review = inc.review_summary
    if a.dry_run:
        md = render_brief(ctx, rd, inc, el, wt, rc, review)
        say("[dry-run] would create worktree %s on branch autofix/%s at %s (%s)" % (rd.worktree, rd.incident_id, ref, sha[:8]))
        say("[dry-run] INCIDENT.md:\n")
        say(md)
        return EXIT_OK
    status = rd.status()
    allow_existing = status.get("phase") in ("planned", "fixing", "gate_failed", "gate_passed") and bool(rd.read("workspace"))
    how = wt.prepare(allow_existing_branch=allow_existing)
    rd.write("workspace", {"repo_id": rc.id, "repo_dir": wt.repo_dir, "github": rc.github or wt.github_repo(),
                           "remote": rc.remote, "base": rc.base, "base_ref": ref, "base_sha": sha,
                           "worktree": wt.dir, "branch": wt.branch, "scope": rc.scope, "prepared_at": utc_now()})
    if note:
        say("注：" + note)
    attempts = rd.attempts()
    if how == "created" or not attempts or a.rewrite_brief or review:
        md = render_brief(ctx, rd, inc, el, wt, rc, review)
        wt.write_file("INCIDENT.md", md)
        with open(rd.path("brief"), "w", encoding="utf-8") as f:
            f.write(md)
    rd.set_phase("planned", "worktree %s (%s) @ %s" % (how, wt.branch, sha[:8]), repo=rc.id)
    say("worktree %s：%s（分支 %s，基线 %s %s）" % (how, wt.dir, wt.branch, ref, sha[:8]))
    say("INCIDENT.md 已写入 worktree。下一步二选一：")
    say("  交互（默认）：在当前 agent 会话里直接按 %s/INCIDENT.md 修复（incident-fix 契约；不要 commit/push），改完 run gate %s"
        % (wt.dir, rd.incident_id))
    say("  无人值守：suites/sre-autofix/run fix %s --headless" % rd.incident_id)
    return EXIT_OK


# ---------------------------------------------------------------- fix / gate
def run_gate(ctx, rd, wt, rc, committed=False):
    """committed=True gates the already-committed range base..HEAD (ship resume after a commit)."""
    if committed:
        diff, changed = wt.diff_committed(), wt.committed_files()
    else:
        diff, changed = wt.diff(), wt.changed_files()
    untracked = wt.untracked()
    ok, why = wt.apply_check_reverse(diff)
    verification = wt.read_file(".sre-evidence/verification.json")
    repo_checks = None
    if rc.checks_configured():
        repo_checks = {"configured": True, "results": []}
        if diff.strip():
            say("仓库自检：在 worktree 里执行 %d 条命令（每条上限 %ds）…" % (len(rc.checks), ctx.cfg.checks_wall_sec))
            results = repocheck.run_all(rc.checks, wt.dir, changed, ctx.cfg.checks_wall_sec, ctx.extra_secrets, root=ctx.root)
            with open(rd.path("repo_checks"), "w", encoding="utf-8") as f:
                f.write(repocheck.log_text(results))
            repo_checks["results"] = repocheck.trim(results)
    res = _gate.evaluate({"diff": diff, "reverse_applies": ok, "reverse_err": why, "changed_files": changed,
                          "untracked": untracked, "verification_json": verification,
                          "extra_secrets": ctx.extra_secrets, "repo_checks": repo_checks},
                         {"include": rc.scope, "scaffold": ctx.cfg.scaffold, "repo_id": rc.id})
    rd.write("gate", res)
    with open(rd.path("patch"), "w", encoding="utf-8") as f:
        f.write(diff)
    fn = wt.read_file("FIXNOTES.md")
    if fn is not None:
        with open(rd.path("fixnotes"), "w", encoding="utf-8") as f:
            f.write(fn)
    if verification is not None:
        with open(rd.path("verification"), "w", encoding="utf-8") as f:
            f.write(verification)
    return res, diff


def require_planned(ctx, rd):
    ws = rd.read("workspace")
    if not ws:
        raise SuiteError("%s 还没有 plan（无 workspace.json）" % rd.incident_id)
    rc, wt = ctx.worktree_for(rd, ws["repo_id"])
    wt.base_ref, wt.base_sha = ws["base_ref"], ws["base_sha"]
    if not os.path.isdir(wt.dir):
        raise SuiteError("worktree %s 已不在——请重新 plan" % wt.dir)
    return rc, wt


def cmd_gate(ctx, a):
    rd = RunDir(ctx.root, a.incident)
    rc, wt = require_planned(ctx, rd)
    res, _ = run_gate(ctx, rd, wt, rc)
    if not a.quiet:
        rd.append_attempt({"mode": "gate-only", "gate_passed": res["passed"],
                           "fail_class": res.get("fail_class", ""), "reason": res.get("reason", "")})
    say(_gate.render_table(res))
    if res["passed"]:
        rd.set_phase("gate_passed", "files=" + "、".join(res["files"]))
        say("验证门全绿。下一步：suites/sre-autofix/run ship %s [--issue N]" % rd.incident_id)
        return EXIT_OK
    rd.set_phase("gate_failed", res["reason"])
    warn("gate failed [%s]: %s" % (res["fail_class"], res["reason"]))
    return EXIT_GATE_FAILED


def cmd_fix(ctx, a):
    rd = RunDir(ctx.root, a.incident)
    rc, wt = require_planned(ctx, rd)
    inc = load_incident(rd)
    el = rd.read("eligibility") or {}
    attempts = rd.attempts()
    last = next((x for x in reversed(attempts) if x.get("fail_class")), None)

    if a.retry:
        if not last:
            raise SuiteError("--retry 需要有一次失败记录（attempts.jsonl 里没有 fail_class）", EXIT_USAGE)
        wt.reset()
        md = render_brief(ctx, rd, inc, el, wt, rc, inc.review_summary, last, len(attempts) + 1)
        wt.write_file("INCIDENT.md", md)
        with open(rd.path("brief"), "w", encoding="utf-8") as f:
            f.write(md)
        say("worktree 已重置到基线；INCIDENT.md 已附上一轮失败原因（%s）" % last.get("fail_class"))

    if not a.headless:
        rd.append_attempt({"mode": "interactive", "started": True})
        rd.set_phase("fixing", "interactive")
        say("交互模式：在当前 agent 会话里按 %s/INCIDENT.md 修复（incident-fix 契约；不要 commit/push）" % wt.dir)
        say("改完后：suites/sre-autofix/run gate %s" % rd.incident_id)
        return EXIT_OK

    hl = dict(ctx.cfg.headless)
    if a.agent:
        hl["agent"] = a.agent
    retries = a.retries if a.retries is not None else int(hl.get("retries") or 0)
    wall = a.wall or int(hl.get("wall_sec") or 3600)
    n = 0
    while True:
        n += 1
        rd.set_phase("fixing", "headless attempt %d" % n)
        att = headless.run_agent(wt.dir, rd, hl, wall_sec=wall, agent=a.agent or None, extra_secrets=ctx.extra_secrets)
        if att.get("fail_class"):
            att["gate_passed"] = False
            rd.append_attempt(att)
            warn("agent [%s]: %s" % (att["fail_class"], att.get("reason", "")))
            if att["fail_class"] == _gate.FAIL_AGENT_MISSING:
                return EXIT_ERROR
        else:
            res, _ = run_gate(ctx, rd, wt, rc)
            att.update({"gate_passed": res["passed"], "fail_class": res.get("fail_class", ""), "reason": res.get("reason", "")})
            rd.append_attempt(att)
            say(_gate.render_table(res))
            if res["passed"]:
                rd.set_phase("gate_passed", "files=" + "、".join(res["files"]))
                say("验证门全绿（第 %d 次）。下一步：suites/sre-autofix/run ship %s [--issue N]" % (n, rd.incident_id))
                return EXIT_OK
            warn("gate failed [%s]: %s" % (res["fail_class"], res["reason"]))
        if n > retries:
            rd.set_phase("gate_failed", att.get("reason", ""))
            warn("修复腿失败，工作现场保留在 %s 供人工判读；判读完 run release %s" % (wt.dir, rd.incident_id))
            return EXIT_GATE_FAILED
        wt.reset()
        md = render_brief(ctx, rd, inc, el, wt, rc, inc.review_summary,
                          {"fail_class": att.get("fail_class"), "reason": att.get("reason")}, n + 1)
        wt.write_file("INCIDENT.md", md)
        with open(rd.path("brief"), "w", encoding="utf-8") as f:
            f.write(md)
        say("回炉重试 %d/%d：工作目录已重置，INCIDENT.md 附上一轮失败原因" % (n, retries))


# ---------------------------------------------------------------- ship
def cmd_ship(ctx, a):
    rd = RunDir(ctx.root, a.incident)
    rc, wt = require_planned(ctx, rd)
    inc = load_incident(rd)
    ws = rd.read("workspace")
    dry = a.dry_run or os.environ.get("DRY_RUN") == "1"

    resumed = rd.phase_at_least("committed") and len(wt.commits_since_base()) == 1
    res, diff = run_gate(ctx, rd, wt, rc, committed=resumed)   # never trust an old gate result
    if not res["passed"]:
        rd.set_phase("gate_failed", res["reason"])
        say(_gate.render_table(res))
        raise SuiteError("现场补丁未通过验证门（%s：%s）——不 ship" % (res["fail_class"], res["reason"]), EXIT_GATE_FAILED)
    files = res["files"]
    fixnotes = wt.read_file("FIXNOTES.md") or ""
    ver_summary = next((c["detail"] for c in res["checks"] if "验证证据" in c["name"]), "")

    name, email = wt.identity()
    if not name or not email:
        raise SuiteError("git 身份未设置（user.name / user.email）——suite 永不代填身份；请 git config 后重试")

    github = rc.github if rc.github and not _config.is_placeholder(rc.github) else wt.github_repo()
    if not github:
        raise SuiteError("无法确定 GitHub 仓库：config.yaml repos[%s].github 仍是 TODO(owner)，且 remote %s 的 URL 不是 github 形态" % (rc.id, rc.remote))

    sha = _ship.existing_commit_matches(wt, files)
    if sha:
        say("复用已有提交 %s" % sha[:8])
    else:
        if dry:
            say("[dry-run] would commit %s with the operator identity %s <%s>" % ("、".join(files), name, email))
            sha = wt.head_sha()
        else:
            sha = wt.commit_only(files, prbody.commit_message(inc.draft, files), no_verify=a.no_verify)
            rd.set_phase("committed", sha)
            say("已提交 %s（%d 文件）" % (sha[:8], len(files)))
    if not dry:
        recheck = _ship.recheck_after_commit(wt, wt.committed_files(), rc.scope, ctx.cfg.scaffold, ctx.extra_secrets)
        if not recheck["passed"]:
            raise SuiteError("commit 后范围复核未通过（未推送）：%s" % recheck["reason"], EXIT_GATE_FAILED)

    attempts_n = len([x for x in rd.attempts() if x.get("mode") != "gate-only"]) or 1
    body, blocked, reason, _ = prbody.render(inc, {
        "repo": github, "branch": wt.branch, "base_sha": ws["base_sha"], "commit_sha": sha, "files": files,
        "diff": diff, "checks": res["checks"], "attempts": attempts_n, "fixnotes": fixnotes,
        "verification_summary": ver_summary, "refs_issue": a.issue, "archive_dir": inc.archive_dir,
    }, ctx.extra_secrets)
    title = prbody.pr_title(inc.draft, files)
    with open(rd.path("pr_body"), "w", encoding="utf-8") as f:
        f.write(body)
    with open(rd.path("pr_title"), "w", encoding="utf-8") as f:
        f.write(title + "\n")
    if blocked:
        raise SuiteError("PR 正文 Egress 阻断（未推送）：%s" % reason, EXIT_BLOCKED)

    push_target = "%s:%s" % (github, wt.branch)
    if dry:
        say("[dry-run] title: " + title)
        say("[dry-run] body:  " + rd.path("pr_body"))
        say("[dry-run] would run: git -C %s push %s %s:%s" % (wt.dir, rc.remote, wt.branch, wt.branch))
        say("[dry-run] would run: gh pr create --repo %s --base %s --head %s --title %r --body-file %s"
            % (github, rc.base, wt.branch, title, rd.path("pr_body")))
        return EXIT_OK

    if not rd.phase_at_least("pushed"):
        remote = wt.remote_head()
        if remote and remote != sha:
            raise SuiteError("远端分支 %s 已存在且不是本提交（%s）——不 force push；请人工删除远端分支或换 incident id" % (wt.branch, remote[:8]))
        if not remote:
            if not _ship.guard(ctx.root, "git push %s %s" % (rc.remote, wt.branch), push_target):
                raise SuiteError("push 未获批准（harness 阻断）。在真实终端重跑 ship，或手工从分支 %s 开 PR" % wt.branch, EXIT_BLOCKED)
            wt.push()
        rd.set_phase("pushed", sha)
        say("已推送 %s → %s" % (wt.branch, github))

    if not _ship.guard(ctx.root, "gh pr create", "%s:pr:%s" % (github, wt.branch)):
        raise SuiteError("建 PR 未获批准（harness 阻断）。分支已推送；可手工 gh pr create --repo %s --head %s" % (github, wt.branch), EXIT_BLOCKED)
    url, info = _ship.gh_create_pr(ctx.root, github, rc.base, wt.branch, title, rd.path("pr_body"), ctx.extra_secrets)
    rec = {"repo": github, "number": info.get("number", 0), "url": url, "state": (info.get("state") or "open").lower(),
           "branch": wt.branch, "commit_sha": sha, "base_sha": ws["base_sha"], "created_at": utc_now(),
           "workspace_sha": rd.status().get("workspace_sha", "")}
    rd.write("pr", rec)
    rd.set_phase("shipped", url)
    say("修复 PR 已创建：%s（人类评审，永不自动合并）" % url)
    if not a.keep_worktree:
        try:
            wt.release()
            rd.set_phase("released", "worktree removed after ship")
        except SuiteError as e:
            warn("回收 worktree 失败（需人工清理）：%s" % e)
    return EXIT_OK


# ---------------------------------------------------------------- release
def cmd_release(ctx, a):
    rd = RunDir(ctx.root, a.incident)
    ws = rd.read("workspace")
    if not ws:
        raise SuiteError("%s 没有 worktree 记录" % a.incident)
    rc, wt = ctx.worktree_for(rd, ws["repo_id"])
    wt.base_sha = ws.get("base_sha", "")
    wt.release()
    rd.set_phase("released", "manual release")
    say("已回收 worktree %s 与分支 %s" % (wt.dir, wt.branch))
    return EXIT_OK


# ---------------------------------------------------------------- main
def build_parser():
    p = argparse.ArgumentParser(prog="suites/sre-autofix/run", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", required=True, help="workspace root")
    sub = p.add_subparsers(dest="verb")

    d = sub.add_parser("doctor", help="readiness check: git / gh / python3 / agent CLIs / config.yaml / mounted repos")
    d.set_defaults(fn=cmd_doctor)

    c = sub.add_parser("claim", help="normalise a report.json / archive dir and run the eligibility gate (offline)")
    c.add_argument("input")
    c.add_argument("--repo", default="", help="restrict the target to this mounted repo id")
    c.add_argument("--file", action="append", help="repo-relative fix target (bypasses locate; repeatable)")
    c.add_argument("--min-confidence", default="", choices=["", "low", "medium", "high"])
    c.add_argument("--dry-run", action="store_true")
    c.add_argument("--reclaim", action="store_true")
    c.set_defaults(fn=cmd_claim)

    pl = sub.add_parser("plan", help="fetch base, create the worktree, render INCIDENT.md")
    pl.add_argument("incident")
    pl.add_argument("--no-fetch", action="store_true")
    pl.add_argument("--dry-run", action="store_true")
    pl.add_argument("--rewrite-brief", action="store_true")
    pl.add_argument("--review", default="", help="file with reviewer feedback → 人工评审意见 section (返修)")
    pl.set_defaults(fn=cmd_plan)

    fx = sub.add_parser("fix", help="run the fix (interactive hand-off by default; --headless runs claude/codex)")
    fx.add_argument("incident")
    fx.add_argument("--headless", action="store_true")
    fx.add_argument("--agent", default="", choices=["", "claude", "codex", "opencode"])
    fx.add_argument("--retries", type=int, default=None)
    fx.add_argument("--wall", type=int, default=0)
    fx.add_argument("--retry", action="store_true", help="reset the worktree and carry the last failure into INCIDENT.md")
    fx.set_defaults(fn=cmd_fix)

    g = sub.add_parser("gate", help="harvest the worktree and run the four hygiene checks")
    g.add_argument("incident")
    g.add_argument("--quiet", action="store_true", help="do not append an attempts.jsonl line")
    g.set_defaults(fn=cmd_gate)

    s = sub.add_parser("ship", help="commit → recheck → PR body → guarded push → guarded gh pr create")
    s.add_argument("incident")
    s.add_argument("--issue", type=int, default=0, help="add `Refs #N` to the PR body (never Closes)")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--keep-worktree", action="store_true")
    s.add_argument("--no-verify", action="store_true", help="skip the repo's commit hooks")
    s.set_defaults(fn=cmd_ship)

    r = sub.add_parser("release", help="remove the worktree and delete the local autofix branch")
    r.add_argument("incident")
    r.set_defaults(fn=cmd_release)
    return p


def main(argv=None):
    require_python()
    p = build_parser()
    a = p.parse_args(argv)
    if not a.verb:
        p.print_help()
        return EXIT_USAGE
    try:
        ctx = Ctx(a.root)
        rc = a.fn(ctx, a)
    except SuiteError as e:
        warn("sre-autofix %s: %s" % (a.verb, e))
        rc = e.code
    except KeyboardInterrupt:
        warn("interrupted")
        rc = EXIT_ERROR
    try:
        inc_id = getattr(a, "incident", None)
        if inc_id:
            RunDir(os.path.abspath(a.root), inc_id).log_run(a.verb + " " + inc_id, rc)
    except Exception:  # noqa: BLE001 — logging must never mask the verb's exit code
        pass
    return rc


if __name__ == "__main__":
    sys.exit(main())
