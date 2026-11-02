"""`run spike` — the #146 G0 checklist as one read-only command, written to runs/sre-inspect/spike-<ts>.md.

Items (numbering = the ticket's): 1 health/edition/RBAC · 2 datasource inventory + token scope ·
3 SLS /api/ds/query (count, logStore/logstore keys, raw pull timing, error shape) · 4 getLogstoreList ·
5 mcp-grafana sidecar (docker stdio) · 6 slow query / powerSql (only with --slow: it scans 30 days).
Everything written is tenant-specific and stays under runs/ (gitignored).
"""
import json
import os
import sys
import time

from . import grafana, mcp
from .common import SuiteError, utc_now, which

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "grafana-sls"))
import sls_query  # noqa: E402


def _t(fn):
    t0 = time.time()
    try:
        return fn(), time.time() - t0, None
    except Exception as e:  # noqa: BLE001 - spike records failures as findings
        return None, time.time() - t0, "%s: %s" % (type(e).__name__, str(e)[:300])


def run_spike(ctx, slow=False, with_mcp=True):
    t = ctx.tenant()
    client = grafana.from_env()
    now = int(time.time())
    out = ["# G0 spike — %s — %s" % (t.display_name, utc_now()), "", "Grafana: %s" % t.grafana_url, ""]

    # 1
    h, dt, err = _t(client.health)
    bi = {} if err else client.build_info()
    fs = {} if err else client.frontend_settings()
    out += ["## 1. /api/health + edition", "", "- health: %s (%.2fs)%s" % (json.dumps(h), dt, (" ERROR " + err) if err else ""),
            "- version %s edition %s rbac %s license %s" % (bi.get("version"), bi.get("edition"), fs.get("rbacEnabled"),
                                                            (fs.get("licenseInfo") or {}).get("stateInfo")), ""]
    # 2
    ds = client.datasources()
    perms = client.permissions()
    q = perms.get("datasources:query") or []
    out += ["## 2. datasources (%d) — token %s" % (len(ds), client.whoami().get("login")), "",
            "| type | name | uid | project/logstore or url | query? |", "|---|---|---|---|---|"]
    for d in sorted(ds, key=lambda x: (x.get("type", ""), x.get("name", ""))):
        jd = d.get("jsonData") or {}
        detail = "%s/%s" % (jd.get("project"), jd.get("logstore")) if d.get("type") == sls_query.SLS_TYPE else (d.get("url") or "")[:80]
        can = "datasources:*" in q or ("datasources:uid:%s" % d.get("uid")) in q
        out.append("| %s | %s | %s | %s | %s |" % (d.get("type"), d.get("name"), d.get("uid"), detail, "yes" if can else "NO"))
    want = set(t.datasource_names())
    have = set(d.get("name") for d in ds)
    out += ["", "- tenant datasources missing in Grafana: %s" % (sorted(want - have) or "none"),
            "- notification policy tree: `%s`" % json.dumps(client.policies(), ensure_ascii=False)[:600], ""]
    # 3
    by_name = {d.get("name"): d for d in ds}
    l = by_name.get(t.probe.get("logs_datasource"))
    out += ["## 3. SLS via /api/ds/query (%s)" % (l.get("name") if l else "probe.logs_datasource missing"), ""]
    if l:
        frm_ms, to_ms = (now - 1800) * 1000, now * 1000
        for label, kw in (("count (default logstore)", {}),
                          ("count with logStore override = same logstore", {"logStore": (l.get("jsonData") or {}).get("logstore")}),
                          ("count with logstore (lowercase) override", {"logstore": (l.get("jsonData") or {}).get("logstore")})):
            qd = sls_query.build_query(l["uid"], "* | select count(*) as c", limit=1)
            qd.update(kw)
            res, dt, err = _t(lambda: sls_query.parse_result(client.ds_query([qd], frm_ms, to_ms).get("A")))
            out.append("- %s: %s (%.2fs)" % (label, err or ("rows=%s first=%s" % (len(res[1]), res[1][0] if res[1] else None)), dt))
        for n in (200, 20):
            res, dt, err = _t(lambda: sls_query.run_query(client, l, "*", None, frm_ms, to_ms, n))
            out.append("- raw pull totalLogs=%d: %s (%.2fs)" % (n, err or ("rows=%d cols=%d" % (len(res[1]), len(res[0]))), dt))
        for label, qs in (("bad search key", 'nosuchfield_xyz: "1" | select count(*) as c'),
                          ("bad SQL column", "* | select nosuchcol_xyz, count(*) as c group by nosuchcol_xyz")):
            res, dt, err = _t(lambda: sls_query.run_query(client, l, qs, None, frm_ms, to_ms, 5))
            out.append("- error shape (%s): %s" % (label, (err or "no error?!")[:300]))
        res, dt, err = _t(lambda: client.ds_query([sls_query.build_query("nosuchuid000", "* | select count(*) as c", limit=1)], frm_ms, to_ms))
        out.append("- bad datasource uid: %s" % (err or json.dumps(res)[:200]))
    out.append("")
    # 4
    out += ["## 4. getLogstoreList", ""]
    if l:
        res, dt, err = _t(lambda: sls_query.list_logstores(client, l))
        out.append("- POST resources/api/getLogstoreList {Project}: %s (%.2fs)" % (err or ("%d logstores: %s" % (len(res), ", ".join(res[:20]))), dt))
    out.append("")
    # 5
    out += ["## 5. mcp-grafana sidecar (%s)" % mcp.IMAGE, ""]
    if with_mcp and which("docker"):
        res, dt, err = _t(lambda: mcp.stdio_probe(os.environ, wall=90))
        out.append("- stdio initialize/tools/list_datasources: %s (%.1fs)" % (err or ("server=%s tools=%d datasources=%d" % (res["server"], len(res["tools"]), res["datasources"])), dt))
        if not err:
            out.append("- tools: %s" % ", ".join(res["tools"]))
    else:
        out.append("- skipped (docker missing or --no-mcp)")
    m = by_name.get(t.probe.get("metrics_datasource"))
    if m:
        res, dt, err = _t(lambda: client.prom_query(m["uid"], "up", (now - 3600) * 1000, now * 1000, instant=True))
        out.append("- Prometheus `up` via /api/ds/query on %s: %s (%.2fs)" % (m["name"], err or ("%d rows" % len(res[1])), dt))
    out.append("")
    # 6
    out += ["## 6. timeouts / slow query", ""]
    if slow and l:
        for ps in (False, True):
            res, dt, err = _t(lambda: sls_query.run_query(client, l, "* | select count(*) as c", None, (now - 30 * 86400) * 1000, now * 1000, 1, power_sql=ps))
            out.append("- 30d count(*) powerSql=%s: %s (%.2fs)" % (ps, err or ("rows=%d first=%s" % (len(res[1]), res[1][0] if res[1] else None)), dt))
    else:
        out.append("- skipped (pass --slow to run a 30-day count(*) with and without powerSql)")
    out += ["", "Datasource jsonData.timeout: %s" % {d.get("name"): (d.get("jsonData") or {}).get("timeout") for d in ds if (d.get("jsonData") or {}).get("timeout")}, ""]
    return "\n".join(out)
