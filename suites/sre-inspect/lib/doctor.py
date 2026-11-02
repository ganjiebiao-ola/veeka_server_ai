"""`run doctor` — the local form of the reference engine's sre-probe: readiness of the ONE data plane.

  D0 config: tenant.yaml parses/validates, routes.yaml loads, env file present and 0600 (values never shown)
  D1 Grafana: /api/health, build info, every tenant datasource exists, the token has datasources:query on each
  D2 metrics: `up` on probe.metrics_datasource through /api/ds/query
  D3 logs: `* | select count(*)` on probe.logs_datasource, last 30 min, through sls_query
  D4 mcp-grafana (optional): docker stdio initialize + list_datasources with the same token
  D5 deploys (only when configured): gh auth status
"""
import os
import sys
import time

from . import envfile, grafana, mcp, tenant as _tenant
from .common import SuiteError, run, which

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "grafana-sls"))
import sls_query  # noqa: E402


class Report:
    def __init__(self):
        self.rows = []      # (level, name, ok, detail)

    def row(self, level, name, ok, detail=""):
        self.rows.append((level, name, bool(ok), detail))
        return bool(ok)

    def must_ok(self):
        return all(ok for lvl, _, ok, _ in self.rows if lvl == "MUST")

    def render(self):
        out = []
        for lvl, name, ok, detail in self.rows:
            mark = "[ OK ]" if ok else ("[MISS]" if lvl == "MUST" else "[WARN]")
            out.append("%s %-4s %-46s %s" % (mark, lvl, name, detail))
        out.append("doctor: %s" % ("all MUST checks passed" if self.must_ok() else "MUST check(s) failed — fix before intake/dive"))
        return "\n".join(out)


def run_doctor(ctx, with_mcp=True, since="30m"):
    rep = Report()
    # D0 ------------------------------------------------------------------------
    rep.row("MUST", "python3 >= 3.8", sys.version_info >= (3, 8), "%d.%d.%d" % sys.version_info[:3])
    try:
        t = ctx.tenant()
        probs = _tenant.validate(t)
        rep.row("MUST", "tenant.yaml", not probs, os.path.relpath(t.path, ctx.root) + ("" if not probs else " — " + "; ".join(probs)))
    except SuiteError as e:
        rep.row("MUST", "tenant.yaml", False, str(e))
        return rep
    routes, rpath = ctx.routes()
    rprobs = _tenant.validate_routes(routes, ctx.suite_dir, t)
    rep.row("MUST", "routes.yaml", rpath is not None and not rprobs,
            ("%s (%d rules)" % (os.path.relpath(rpath, ctx.root), len(routes)) if rpath else "missing — copy routes.yaml.example") + ("" if not rprobs else " — " + "; ".join(rprobs)))
    envp = ctx.env_path
    envd = envfile.describe(ctx.env_values)
    rep.row("MUST", "env file", os.path.isfile(envp), "%s: %s" % (os.path.relpath(envp, ctx.root), ", ".join("%s=%s" % kv for kv in envd.items() if kv[0] in envfile.REQUIRED)))
    if os.path.isfile(envp):
        rep.row("WARN", "env file mode 0600", envfile.mode_ok(envp), "" if envfile.mode_ok(envp) else "chmod 600 %s" % envp)
    env_url = (os.environ.get("GRAFANA_URL") or "").rstrip("/")
    rep.row("MUST", "GRAFANA_URL matches tenant.grafana.url", env_url == t.grafana_url, "%s vs %s" % (env_url or "<unset>", t.grafana_url))
    if not os.environ.get("GRAFANA_SERVICE_ACCOUNT_TOKEN"):
        rep.row("MUST", "GRAFANA_SERVICE_ACCOUNT_TOKEN set", False, "missing in env file / environment")
        return rep
    # D1 ------------------------------------------------------------------------
    try:
        client = grafana.from_env()
        h = client.health()
        bi = client.build_info()
        rep.row("MUST", "D1 Grafana /api/health", h.get("database") == "ok",
                "version %s edition %s" % (bi.get("version", h.get("version")), bi.get("edition", "?")))
        who = client.whoami()
        rep.row("WARN", "D1 token identity", bool(who.get("login")), "%s (orgId %s)" % (who.get("login"), who.get("orgId")))
        ds = client.datasources()
        by_name = {d.get("name"): d for d in ds}
        perms = client.permissions().get("datasources:query") or []
        missing, noquery = [], []
        for name in t.datasource_names():
            d = by_name.get(name)
            if not d:
                missing.append(name)
            elif "datasources:*" not in perms and ("datasources:uid:%s" % d.get("uid")) not in perms:
                noquery.append(name)
        rep.row("MUST", "D1 tenant datasources exist", not missing, "%d configured, %d in Grafana%s" % (len(t.datasource_names()), len(ds), (" — missing: " + ", ".join(missing)) if missing else ""))
        rep.row("MUST", "D1 token has datasources:query", not noquery, ("all" if not noquery else "missing on: " + ", ".join(noquery)))
        for d in t.logs:
            g = by_name.get(d.get("name"))
            if g:
                jd = g.get("jsonData") or {}
                ok = (not d.get("project") or jd.get("project") == d.get("project")) and (not d.get("logstore") or jd.get("logstore") == d.get("logstore"))
                rep.row("WARN", "D1 logs ds %s project/logstore" % d.get("name"), ok, "grafana=%s/%s tenant=%s/%s" % (jd.get("project"), jd.get("logstore"), d.get("project"), d.get("logstore")))
    except grafana.GrafanaError as e:
        rep.row("MUST", "D1 Grafana", False, "%s %s" % (e.status, e.message))
        return rep
    # D2 ------------------------------------------------------------------------
    now = int(time.time())
    m = by_name.get(t.probe.get("metrics_datasource"))
    if m:
        try:
            t0 = time.time()
            cols, rows, _ = client.prom_query(m["uid"], "up", (now - 3600) * 1000, now * 1000, instant=True)
            rep.row("MUST", "D2 query up @ %s" % m["name"], len(rows) > 0, "%d series, %.2fs" % (len(rows), time.time() - t0))
        except (grafana.GrafanaError, grafana.QueryError) as e:
            rep.row("MUST", "D2 query up @ %s" % m["name"], False, str(e)[:200])
    else:
        rep.row("MUST", "D2 metrics probe datasource", False, "probe.metrics_datasource not found in Grafana")
    # D3 ------------------------------------------------------------------------
    l = by_name.get(t.probe.get("logs_datasource"))
    if l:
        try:
            from .common import parse_duration
            frm_ms, to_ms = (now - parse_duration(since, 1800)) * 1000, now * 1000
            cols, rows, info, el = sls_query.run_query(client, l, "* | select count(*) as c", t.probe.get("logstore") or None, frm_ms, to_ms, 1)
            n = rows[0][0] if rows and rows[0] else "?"
            rep.row("MUST", "D3 sls count @ %s" % l["name"], True, "count=%s in last %s, %.2fs" % (n, since, el))
        except (grafana.GrafanaError, grafana.QueryError) as e:
            rep.row("MUST", "D3 sls count @ %s" % l["name"], False, str(e)[:200])
    else:
        rep.row("MUST", "D3 logs probe datasource", False, "probe.logs_datasource not found in Grafana")
    # D4 ------------------------------------------------------------------------
    if with_mcp:
        if which("docker"):
            try:
                pr = mcp.stdio_probe(os.environ, wall=90)
                rep.row("WARN", "D4 mcp-grafana stdio", "query_prometheus" in pr["tools"] and pr["datasources"] >= 0,
                        "%d tools, list_datasources=%d (%s)" % (len(pr["tools"]), pr["datasources"], mcp.IMAGE.split("@")[0]))
            except SuiteError as e:
                rep.row("WARN", "D4 mcp-grafana stdio", False, str(e)[:200])
        else:
            rep.row("WARN", "D4 mcp-grafana stdio", False, "docker not on PATH — Prometheus tools unavailable to Claude Code/Codex; SLS still works")
    # D5 ------------------------------------------------------------------------
    if t.deploys:
        if which("gh"):
            r = run(["gh", "auth", "status"], wall=20)
            rep.row("WARN", "D5 gh auth (deploys[] configured)", r.code == 0, "" if r.code == 0 else (r.stderr or r.stdout).strip().split("\n")[0][:120])
        else:
            rep.row("WARN", "D5 gh auth (deploys[] configured)", False, "gh not on PATH")
    return rep
