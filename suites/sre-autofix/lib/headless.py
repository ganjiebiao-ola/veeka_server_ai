"""Headless executor: run the operator's own agent CLI (claude / codex) in the worktree.

This is the single insertion point for other executors — the codesec container backend documented
in docs/codesec-interface.md would implement `run_agent()` with the same signature. The agent gets
the thin HEADLESS_PROMPT; the contract lives in INCIDENT.md inside the worktree.
"""
import json
import os
import shutil
import signal
import subprocess
import threading
import time

from . import scrub as _scrub
from .brief import HEADLESS_PROMPT
from .common import SuiteError, utc_now
from .gate import FAIL_AGENT_ERROR, FAIL_AGENT_MISSING, FAIL_TIMEOUT

READ_ONLY_BASH = [
    "Bash(grep *)", "Bash(rg *)", "Bash(find *)", "Bash(ls *)", "Bash(cat *)", "Bash(sed -n *)",
    "Bash(awk *)", "Bash(wc *)", "Bash(head *)", "Bash(tail *)",
    "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git blame*)", "Bash(git show*)",
    "Bash(php -l *)", "Bash(go vet *)", "Bash(go build *)", "Bash(gofmt *)", "Bash(node --check *)",
    "Bash(python3 -m py_compile *)",
]
DISALLOWED = [
    "Bash(git commit*)", "Bash(git push*)", "Bash(git checkout*)", "Bash(git switch*)", "Bash(git reset*)",
    "Bash(git rebase*)", "Bash(git stash*)", "Bash(git branch*)", "Bash(git worktree*)", "Bash(gh *)",
    "Bash(rm -rf*)", "WebFetch", "WebSearch",
]


KNOWN_AGENTS = ("claude", "codex", "opencode")


def detect_agent(preferred="auto"):
    preferred = (preferred or "auto").strip().lower()
    if preferred in KNOWN_AGENTS:
        return preferred if shutil.which(preferred) else ""
    if preferred not in ("", "auto"):
        return ""  # unknown executor name: never silently fall back to another CLI
    for name in KNOWN_AGENTS:
        if shutil.which(name):
            return name
    return ""


def available_agents():
    return [n for n in KNOWN_AGENTS if shutil.which(n)]


def build_claude_argv(prompt, model="", max_budget_usd=5):
    argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose",
            "--permission-mode", "acceptEdits",
            "--allowedTools", "Read", "Edit", "Write", "MultiEdit", "Grep", "Glob"] + READ_ONLY_BASH
    argv += ["--disallowedTools"] + DISALLOWED
    if max_budget_usd:
        argv += ["--max-budget-usd", str(max_budget_usd)]
    argv += ["--no-session-persistence"]
    if model:
        argv += ["--model", model]
    return argv


def build_codex_argv(prompt, worktree, response_path, model=""):
    argv = ["codex", "exec", "--cd", worktree, "--sandbox", "workspace-write", "--json",
            "-o", response_path, "--skip-git-repo-check"]
    if model:
        argv += ["-m", model]
    argv.append(prompt)
    return argv


def build_opencode_argv(prompt, model=""):
    """opencode runs in cwd (= the worktree); flags kept minimal because this host cannot verify
    the installed version — use config.yaml headless.command for anything richer."""
    argv = ["opencode", "run"]
    if model:
        argv += ["-m", model]
    argv.append(prompt)
    return argv


def build_argv(agent, prompt, worktree, response_path, cfg):
    cmd = cfg.get("command") or []
    if cmd:
        return [str(a).replace("{prompt}", prompt).replace("{worktree}", worktree)
                .replace("{response}", response_path) for a in cmd]
    if agent == "claude":
        return build_claude_argv(prompt, cfg.get("model") or "", cfg.get("max_budget_usd") or 0)
    if agent == "codex":
        return build_codex_argv(prompt, worktree, response_path, cfg.get("model") or "")
    if agent == "opencode":
        return build_opencode_argv(prompt, cfg.get("model") or "")
    raise SuiteError("no executor for agent %r" % agent)


def _parse_result_event(line):
    """claude stream-json: the final {"type":"result"} carries the summary."""
    try:
        ev = json.loads(line)
    except ValueError:
        return None
    if isinstance(ev, dict) and ev.get("type") == "result":
        return ev
    return None


def run_agent(worktree, run_dir, cfg, wall_sec=3600, agent=None, extra_secrets=()):
    """Run the agent headlessly in `worktree`. Writes agent-prompt.txt / agent-events.jsonl /
    agent-response.md / last-run.json under run_dir. Returns a dict for attempts.jsonl:
    {agent, mode, agent_status, exit_code, fail_class?, reason?, agent_cost_usd?, agent_turns?, elapsed_sec}."""
    cfg = dict(cfg or {})
    if cfg.get("command"):
        agent = "custom"
    else:
        agent = detect_agent(agent or cfg.get("agent"))
    if not agent:
        return {"agent": "", "mode": "headless", "agent_status": "missing", "exit_code": -1,
                "fail_class": FAIL_AGENT_MISSING,
                "reason": "PATH 上没有可用的 agent CLI（claude / codex / opencode）；改用交互模式：在当前会话里按 INCIDENT.md（%s）修复，或 config.yaml headless.command 指定别的 CLI" % worktree,
                "elapsed_sec": 0.0}
    prompt = HEADLESS_PROMPT
    response_path = run_dir.path("agent_response")
    argv = build_argv(agent, prompt, worktree, response_path, cfg)
    with open(run_dir.path("agent_prompt"), "w", encoding="utf-8") as f:
        f.write(prompt)
    events_path = run_dir.path("agent_events")
    scrubbed_argv = [_scrub.scrub(a, extra_secrets)[0] for a in argv]
    run_dir.write("last_run", {"agent": agent, "argv": scrubbed_argv, "worktree": worktree,
                               "started_at": utc_now(), "wall_sec": wall_sec})

    start = time.monotonic()
    errf = open(events_path + ".stderr", "wb")
    try:
        proc = subprocess.Popen(argv, cwd=worktree, stdout=subprocess.PIPE, stderr=errf,
                                stdin=subprocess.DEVNULL, start_new_session=True)
    except FileNotFoundError as e:
        errf.close()
        return {"agent": agent, "mode": "headless", "agent_status": "error", "exit_code": -1,
                "fail_class": FAIL_AGENT_ERROR, "reason": "cannot start %s: %s" % (argv[0], e), "elapsed_sec": 0.0}
    timed_out = {"v": False}

    def watchdog():
        deadline = start + wall_sec
        while proc.poll() is None:
            if time.monotonic() > deadline:
                timed_out["v"] = True
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    return
                for _ in range(100):
                    if proc.poll() is not None:
                        return
                    time.sleep(0.1)
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                return
            time.sleep(0.5)

    t = threading.Thread(target=watchdog, daemon=True)
    t.start()
    result_ev = None
    with open(events_path, "a", encoding="utf-8") as ef:
        for raw in proc.stdout:
            line = _scrub.scrub(raw.decode("utf-8", "replace").rstrip("\n"), extra_secrets)[0]
            ef.write(line + "\n")
            ev = _parse_result_event(line)
            if ev:
                result_ev = ev
    proc.stdout.close()
    proc.wait()
    errf.close()
    t.join(timeout=1)
    elapsed = time.monotonic() - start
    att = {"agent": agent, "mode": "headless", "exit_code": proc.returncode, "elapsed_sec": round(elapsed, 3)}
    if result_ev:
        att["agent_cost_usd"] = result_ev.get("total_cost_usd")
        att["agent_turns"] = result_ev.get("num_turns")
        text = result_ev.get("result")
        if isinstance(text, str) and text.strip():
            with open(response_path, "w", encoding="utf-8") as f:
                f.write(_scrub.scrub(text, extra_secrets)[0])
    if timed_out["v"]:
        att.update({"agent_status": "timeout", "fail_class": FAIL_TIMEOUT,
                    "reason": "修复 agent 超过墙钟 %ss 被终止" % wall_sec})
        return att
    if proc.returncode != 0 or (result_ev and result_ev.get("is_error")):
        att.update({"agent_status": "error", "fail_class": FAIL_AGENT_ERROR,
                    "reason": "修复 agent 以 exit %d 结束%s" % (proc.returncode,
                             ("：" + str(result_ev.get("result"))[:200]) if result_ev and result_ev.get("is_error") else "")})
        return att
    att["agent_status"] = "completed"
    return att
