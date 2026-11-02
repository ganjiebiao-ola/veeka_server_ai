"""ship: commit → post-commit scope recheck → PR body → guarded push → guarded `gh pr create`.

Port of fixleg.go shipFix, local form: the operator's own git identity commits, the operator's own
`gh auth` opens the PR, and both outward actions are gated by scripts/lib/harness.sh harness_guard
(approval on /dev/tty; no terminal → BLOCKED). Never force-pushes; never auto-merges.
"""
import json
import os
import subprocess

from . import gate as _gate
from . import prbody
from .common import SuiteError, output, run

GUARD_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guard.sh")


def guard(root, action, target):
    """Run harness_guard with cwd = workspace root (so the log lands in <root>/runs/). Returns True
    when approved. stderr/tty prompts are inherited on purpose — the human answers there."""
    proc = subprocess.run(["sh", GUARD_SH, root, action, target], cwd=root)
    return proc.returncode == 0


def recheck_after_commit(wt, files_committed, include, scaffold, extra_secrets):
    """fixleg.go:435-449 — the gate ran on a dirty tree; after commit make sure only the gate's
    files (and no scaffold) made it in."""
    synthetic = json.dumps({"all_passed": True, "checks": [{"name": "scope recheck", "passed": True}]})
    return _gate.evaluate({
        "diff": "x", "reverse_applies": True, "changed_files": files_committed, "untracked": [],
        "verification_json": synthetic, "extra_secrets": extra_secrets,
    }, {"include": include, "scaffold": scaffold})


def existing_commit_matches(wt, files):
    """Resume rule: exactly one commit since base whose file list equals the gate files."""
    shas = wt.commits_since_base()
    if len(shas) != 1:
        return None
    if sorted(wt.committed_files()) == sorted(files):
        return shas[0]
    return None


def gh_create_pr(root, repo, base, head, title, body_path, extra_secrets):
    out = output(["gh", "pr", "create", "--repo", repo, "--base", base, "--head", head,
                  "--title", title, "--body-file", body_path], cwd=root, wall=120, extra_secrets=extra_secrets)
    url = ""
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("https://") and "/pull/" in line:
            url = line
    if not url:
        raise SuiteError("gh pr create returned no PR URL: %s" % out.strip()[:200])
    res = run(["gh", "pr", "view", url, "--json", "number,url,state"], cwd=root, wall=60, extra_secrets=extra_secrets)
    info = {}
    if res.code == 0:
        try:
            info = json.loads(res.stdout)
        except ValueError:
            info = {}
    return url, info
