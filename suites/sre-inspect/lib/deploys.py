"""Deploy facts (L7 change surface) from GitHub Actions through the operator's own `gh`.

Not a trigger (the reference's post-deploy sweeps: 8 runs, zero findings) — a fact injected into a
dive, because 2 of 258 reference incidents reached a real deploy-caused root cause only with it.
"""
import datetime as _dt
import json

from .common import run, which
from .intake import rfc_to_epoch


def _gh(repo, since_date, runner):
    argv = ["gh", "api", "repos/%s/actions/runs?per_page=100&status=success&created=>=%s" % (repo, since_date)]
    return runner(argv)


def fetch(deploys_cfg, frm_s, to_s, runner=None):
    """-> (events | None, note). events sorted newest first."""
    if not deploys_cfg:
        return None, "tenant.yaml 未配置 deploys[]（L7 变更面未接入）"
    runner = runner or (lambda argv: run(argv, wall=60))
    if runner is run and not which("gh"):
        return None, "gh 不在 PATH（deploys[] 已配置但无法读取 GitHub Actions）"
    since = _dt.datetime.fromtimestamp(frm_s, _dt.timezone.utc).strftime("%Y-%m-%d")
    events, notes = [], []
    for d in deploys_cfg:
        repo, wf = str(d.get("repo", "")), str(d.get("workflow", ""))
        try:
            res = runner(["gh", "api", "repos/%s/actions/runs?per_page=100&status=success&created=>=%s" % (repo, since)])
        except Exception as e:  # gh missing / wall clock
            notes.append("%s: %s" % (repo, e))
            continue
        if res.code != 0:
            notes.append("%s: gh api 退出 %d（%s）" % (repo, res.code, (res.stderr or "").strip().split("\n")[0][:120]))
            continue
        try:
            runs = (json.loads(res.stdout) or {}).get("workflow_runs") or []
        except ValueError:
            notes.append("%s: gh api 返回非 JSON" % repo)
            continue
        for r in runs:
            if str(r.get("name", "")).lower() != wf.lower():
                continue
            done = rfc_to_epoch(r.get("updated_at")) or 0
            if done < frm_s or done > to_s:
                continue
            sha = str(r.get("head_sha", ""))
            events.append({"repo": repo, "workflow": wf, "sha": sha, "short_sha": sha[:12],
                           "title": r.get("display_title") or r.get("name"), "branch": r.get("head_branch"),
                           "event": r.get("event"), "completed_epoch": done,
                           "completed_utc": _dt.datetime.fromtimestamp(done, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                           "url": r.get("html_url")})
    events.sort(key=lambda e: -e["completed_epoch"])
    return events, "；".join(notes) if notes else ""
