"""Repo-configured check commands — the gate's fifth check, with zero language knowledge in the suite.

`config.yaml repos[].checks` lists shell commands the operator wants run inside the worktree before a
patch may ship (Go: `go build ./...` / `go vet ./...`; PHP: `php -l {files}` plus a static analyser;
anything CI would run). The suite only expands two placeholders, runs each command with `sh -c` in the
worktree, and records exit code + output. What "correct" means for a language is the operator's call
— that is the whole point: the first drill shipped a PHP patch that passed every hygiene check and
died at runtime (`Cannot pass parameter 2 by reference`), which no language-agnostic check can see.

Placeholders:
  {files}     the changed files (relative to the worktree), shell-quoted, space-separated
  {worktree}  the worktree's absolute path, shell-quoted
  {root}      the workspace root's absolute path, shell-quoted — commands run with cwd = worktree, so
              anything that lives in the workspace (e.g. docs/examples/*.sh) must be addressed via {root}
"""
import shlex

from .common import SuiteError, run

TAIL_CHARS = 1200      # output kept per command in the gate record (full output goes to the log)
EXIT_WALL = 124        # coreutils `timeout` convention for "killed by the wall clock"


def expand(cmd, files, worktree, root=""):
    q_files = " ".join(shlex.quote(f) for f in (files or []))
    return ((cmd or "").replace("{files}", q_files).replace("{worktree}", shlex.quote(worktree or ""))
            .replace("{root}", shlex.quote(root or "")))


def binaries(cmds):
    """First real token of each command (env assignments skipped) — for doctor's PATH check."""
    out = []
    for c in cmds or []:
        try:
            toks = shlex.split(c)
        except ValueError:
            toks = (c or "").split()
        for t in toks:
            if "=" in t and not t.startswith("="):
                continue      # FOO=bar prefix
            if t not in out:
                out.append(t)
            break
    return out


def describe(cmds):
    return "；".join("`%s`" % c for c in (cmds or []))


def run_all(cmds, worktree, files, wall, extra_secrets=(), root=""):
    """Run every command (no short-circuit — the operator sees all of them). Returns
    [{cmd, expanded, code, elapsed_sec, output}] with output already scrubbed and tail-trimmed."""
    results = []
    for cmd in cmds or []:
        expanded = expand(cmd, files, worktree, root)
        rec = {"cmd": cmd, "expanded": expanded, "code": None, "elapsed_sec": 0.0, "output": ""}
        try:
            r = run(["sh", "-c", expanded], cwd=worktree, wall=wall, extra_secrets=extra_secrets)
            parts = [t.strip() for t in (r.stdout, r.stderr) if (t or "").strip()]
            rec.update(code=r.code, elapsed_sec=round(r.duration, 1), output="\n".join(parts))
        except SuiteError as e:
            # cannot start `sh`, or the wall clock fired — both are a failed check, not a crash
            rec.update(code=EXIT_WALL if "wall clock" in str(e) else 127, output=str(e))
        results.append(rec)
    return results


def log_text(results):
    """Human-readable log for runs/<id>/repo-checks.log (full output, not the trimmed tail)."""
    L = []
    for r in results:
        L.append("$ %s" % r["expanded"])
        L.append("  (cmd: %s | exit %s | %.1fs)" % (r["cmd"], r["code"], r.get("elapsed_sec") or 0.0))
        if r.get("output"):
            L.append(r["output"])
        L.append("")
    return "\n".join(L)


def trim(results):
    """Copy with output cut to TAIL_CHARS (the gate record must stay small)."""
    out = []
    for r in results:
        o = r.get("output") or ""
        if len(o) > TAIL_CHARS:
            o = "…" + o[-TAIL_CHARS:]
        out.append(dict(r, output=o))
    return out
