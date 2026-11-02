"""`run discover` — turn "how do I find the value for this tenant.yaml field?" into a command.

Everything here is read-only and prints a paste-ready snippet; the human decides what enters
tenant.yaml / routes.yaml (tracked in a department instance, `.local` twins on a template checkout).

  discover rules               Grafana alert rules (uid, title, folder, datasource uids) with a routed?
                               column against routes.yaml, plus routes.yaml stanzas for the unrouted ones
  discover deploys <owner/repo> the repo's GitHub Actions workflows with 30-day success counts, the likely
                               production-deploy workflow, and the deploys[] lines to paste
  discover datasources          alias of `run sls datasources --all-types`
"""
import datetime as _dt
import json
import re

from .common import run, which
from .intake import rfc_to_epoch

DEPLOY_NAME_RE = re.compile(r"(deploy|release|production|prod\b|发布|上线)", re.I)


# ----------------------------------------------------------------------------- rules
def rules(client, routes):
    """-> (rows, unrouted_snippet)."""
    rows = []
    for r in client.alert_rules():
        ds = sorted({q.get("datasourceUid") for q in (r.get("data") or []) if q.get("datasourceUid") not in (None, "", "__expr__", "-100")})
        rows.append({"uid": r.get("uid", ""), "title": r.get("title", ""), "folder": r.get("folderUID", ""),
                     "group": r.get("ruleGroup", ""), "datasource_uids": ds, "routed": r.get("uid") in routes})
    rows.sort(key=lambda x: (x["routed"], x["title"]))
    unrouted = [x for x in rows if not x["routed"]]
    lines = []
    if unrouted:
        lines.append("# routes.yaml — one stanza per rule you want triaged (fill rid / layer / template; delete the rest)")
        lines.append("rules:")
        for x in unrouted:
            lines += ["  - rule_uid: %s" % x["uid"], "    rid: TODO(R-xx)", "    name: %s" % json.dumps(x["title"], ensure_ascii=False),
                      "    layer: TODO(L1-L7)", "    template: TODO(<file under triage/>)"]
    return rows, "\n".join(lines)


def format_rules(rows, snippet, ds_names=None):
    ds_names = ds_names or {}
    out = ["# %d alert rules (%d routed, %d unrouted)" % (len(rows), sum(1 for r in rows if r["routed"]), sum(1 for r in rows if not r["routed"])),
           "routed\tuid\ttitle\tgroup\tdatasources"]
    for r in rows:
        names = ", ".join(ds_names.get(u, u) for u in r["datasource_uids"]) or "-"
        out.append("%s\t%s\t%s\t%s\t%s" % ("yes" if r["routed"] else "NO", r["uid"], r["title"], r["group"], names))
    if snippet:
        out += ["", snippet]
    return "\n".join(out)


# ----------------------------------------------------------------------------- deploys
def deploys(repo, runner=None, days=30, now=None):
    """-> dict(workflows=[{name,state,path,success_runs,last_run,events}], candidates=[names], snippet=str, note=str)."""
    if "/" not in (repo or ""):
        return {"workflows": [], "candidates": [], "snippet": "", "note": "repo must be owner/name"}
    runner = runner or (lambda argv: run(argv, wall=60))
    if runner is None or (runner.__name__ == "<lambda>" and not which("gh")):
        return {"workflows": [], "candidates": [], "snippet": "", "note": "gh is not on PATH"}
    wf = runner(["gh", "api", "repos/%s/actions/workflows" % repo])
    if wf.code != 0:
        return {"workflows": [], "candidates": [], "snippet": "", "note": "gh api workflows failed: %s" % (wf.stderr or wf.stdout).strip().split("\n")[0][:160]}
    try:
        workflows = [{"name": w.get("name", ""), "state": w.get("state", ""), "path": w.get("path", ""), "success_runs": 0, "last_run": None, "events": set()}
                     for w in (json.loads(wf.stdout) or {}).get("workflows", []) if not str(w.get("path", "")).startswith("dynamic/")]
    except ValueError:
        return {"workflows": [], "candidates": [], "snippet": "", "note": "gh api returned non-JSON"}
    now = int(now or _dt.datetime.now(_dt.timezone.utc).timestamp())
    since = _dt.datetime.fromtimestamp(now - days * 86400, _dt.timezone.utc).strftime("%Y-%m-%d")
    rr = runner(["gh", "api", "repos/%s/actions/runs?status=success&per_page=100&created=>=%s" % (repo, since)])
    if rr.code == 0:
        try:
            for r in (json.loads(rr.stdout) or {}).get("workflow_runs", []):
                for w in workflows:
                    if w["name"] == r.get("name"):
                        w["success_runs"] += 1
                        w["events"].add(r.get("event", ""))
                        t = rfc_to_epoch(r.get("updated_at")) or 0
                        w["last_run"] = max(w["last_run"] or 0, t)
        except ValueError:
            pass
    for w in workflows:
        w["events"] = sorted(e for e in w["events"] if e)
    cands = [w for w in workflows if w["state"] == "active" and DEPLOY_NAME_RE.search(w["name"])]
    cands.sort(key=lambda w: (-w["success_runs"], w["name"]))
    snippet = ""
    if cands:
        best = cands[0]
        snippet = "deploys:\n  - repo: %s\n    workflow: %s" % (repo, json.dumps(best["name"], ensure_ascii=False))
    note = "" if cands else "no workflow name matches deploy/release/production — pick one from the table by hand"
    return {"workflows": workflows, "candidates": [w["name"] for w in cands], "snippet": snippet, "note": note}


def format_deploys(repo, d):
    out = ["# %s — GitHub Actions workflows (success runs in the last 30d; the deploy candidate is what production_build-style workflows look like)" % repo,
           "candidate\tname\tstate\tsuccess_30d\tevents\tlast_run_utc"]
    for w in d["workflows"]:
        last = _dt.datetime.fromtimestamp(w["last_run"], _dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ") if w["last_run"] else "-"
        out.append("%s\t%s\t%s\t%d\t%s\t%s" % ("*" if w["name"] in d["candidates"] else "", w["name"], w["state"], w["success_runs"], ",".join(w["events"]) or "-", last))
    if d["snippet"]:
        out += ["", "# paste into tenant.yaml (append to the deploys list):", d["snippet"]]
    if d["note"]:
        out += ["", "note: " + d["note"]]
    return "\n".join(out)
