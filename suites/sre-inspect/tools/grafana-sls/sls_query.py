#!/usr/bin/env python3
"""sls_query.py — query Aliyun SLS (Log Service) THROUGH the department Grafana.

Why this exists: grafana/mcp-grafana has no generic datasource-query tool, and the Aliyun SLS Grafana
plugin (`aliyun-log-service-datasource`) is a backend plugin whose only query surface is Grafana's
`POST /api/ds/query`. This script wraps that surface so any agent — HolmesGPT (custom toolset),
Claude Code / Codex (Bash) — talks to SLS with ONE credential: the Grafana service-account token.

Rules this file keeps (do not loosen):
  * stdlib only (urllib/json/argparse) — it runs unchanged inside the holmes image (python 3.11)
    and on an operator's laptop (python >= 3.8);
  * credentials come from the environment ONLY (GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN,
    optional GRAFANA_ORG_ID) — never from argv, never printed, never written;
  * results are never truncated by this script (the caller's spill/paging discipline decides);
  * every failure is one `error: …` line on stdout + non-zero exit, with the upstream message kept
    verbatim (SLS `ParameterInvalid` details are what the skill's error table keys on).

Measured behaviour of the plugin (2026-08-28, plugin backend pkg/sls-plugin.go + live probes):
  * query keys `logStore` and `logstore` are BOTH accepted (Go json unmarshal is case-insensitive);
    we send `logStore` (the backend's declared tag);
  * `totalLogs` is clamped to [1, 5000] and paged by `logsPerPage` (forced to 100) with Reverse=true;
  * a query without `|` returns a "logs" frame (time + message + one column per field);
    a query with `|` returns a table frame; every SQL column comes back typed `string`;
  * `Progress != Complete` is surfaced as the error `incomplete logs, you can switch to powerSql`;
  * the logstore list is a plugin resource: POST /resources/api/getLogstoreList with {"Project": …};
  * in the search segment a key containing ':' must NOT be double-quoted through this path
    (`__tag__:__hostname__: "host"` matches; `"__tag__:__hostname__": "host"` returns 0 rows).
"""
import argparse
import datetime as _dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

SLS_TYPE = "aliyun-log-service-datasource"
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
PAGE = 100
DEFAULT_TIMEOUT = 60


class GrafanaError(Exception):
    """HTTP-level failure talking to Grafana (auth, missing datasource, 5xx)."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class QueryError(Exception):
    """The datasource plugin answered with an error (SLS ParameterInvalid etc.)."""


# ----------------------------------------------------------------------------- client
class Grafana:
    """Minimal Grafana HTTP client. Token is held in memory only; never logged."""

    def __init__(self, url, token, org_id=None, timeout=DEFAULT_TIMEOUT, opener=None):
        if not url or not token:
            raise GrafanaError(0, "GRAFANA_URL and GRAFANA_SERVICE_ACCOUNT_TOKEN must be set in the environment")
        self.url = url.rstrip("/")
        self._token = token
        self.org_id = str(org_id) if org_id else None
        self.timeout = timeout
        self._open = opener or urllib.request.urlopen

    @classmethod
    def from_env(cls, env=None, timeout=DEFAULT_TIMEOUT):
        env = os.environ if env is None else env
        return cls(env.get("GRAFANA_URL", ""), env.get("GRAFANA_SERVICE_ACCOUNT_TOKEN", ""),
                   env.get("GRAFANA_ORG_ID") or None, timeout=timeout)

    def request(self, method, path, body=None):
        data = None
        headers = {"Authorization": "Bearer " + self._token, "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.org_id:
            headers["X-Grafana-Org-Id"] = self.org_id
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with self._open(req, timeout=self.timeout) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as e:
            raw = e.read()
            status = e.code
        except urllib.error.URLError as e:
            raise GrafanaError(0, "cannot reach %s: %s" % (self.url, getattr(e, "reason", e)))
        text = raw.decode("utf-8", "replace") if raw else ""
        try:
            payload = json.loads(text) if text else None
        except ValueError:
            payload = text
        return status, payload

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, body):
        return self.request("POST", path, body)

    # --- endpoints -----------------------------------------------------------
    def health(self):
        status, payload = self.get("/api/health")
        if status != 200:
            raise GrafanaError(status, "GET /api/health -> %s %s" % (status, _short(payload)))
        return payload

    def datasources(self):
        status, payload = self.get("/api/datasources")
        if status == 401 or status == 403:
            raise GrafanaError(status, "GET /api/datasources -> %s (token rejected or lacks datasources:read)" % status)
        if status != 200 or not isinstance(payload, list):
            raise GrafanaError(status, "GET /api/datasources -> %s %s" % (status, _short(payload)))
        return payload

    def ds_query(self, queries, frm, to):
        """POST /api/ds/query. frm/to are epoch-ms strings (or Grafana relative like now-30m)."""
        body = {"from": str(frm), "to": str(to), "queries": queries}
        status, payload = self.post("/api/ds/query", body)
        if status in (401, 403):
            raise GrafanaError(status, "POST /api/ds/query -> %s (token rejected or lacks datasources:query)" % status)
        if status == 404:
            raise GrafanaError(status, "POST /api/ds/query -> 404 %s" % _short(payload))
        if not isinstance(payload, dict) or "results" not in payload:
            raise GrafanaError(status, "POST /api/ds/query -> %s %s" % (status, _short(payload)))
        return payload["results"]

    def resource(self, uid, path, body=None):
        """Datasource plugin resource endpoint: /api/datasources/uid/<uid>/resources/<path>."""
        full = "/api/datasources/uid/%s/resources/%s" % (uid, path.lstrip("/"))
        status, payload = self.post(full, body if body is not None else {})
        if status != 200:
            raise GrafanaError(status, "%s -> %s %s" % (full, status, _short(payload)))
        return payload


def _short(payload, limit=300):
    s = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    s = (s or "").strip().replace("\n", " ")
    return s[:limit] + ("…" if len(s) > limit else "")


# ----------------------------------------------------------------------------- datasources
def sls_datasources(client):
    return [d for d in client.datasources() if d.get("type") == SLS_TYPE]


def describe(ds):
    jd = ds.get("jsonData") or {}
    return {
        "name": ds.get("name", ""), "uid": ds.get("uid", ""), "type": ds.get("type", ""),
        "project": jd.get("project", ""), "logstore": jd.get("logstore", ""),
        "endpoint": ds.get("url", ""), "default": bool(ds.get("isDefault")),
    }


def resolve_datasource(client, ref, only_sls=True):
    """`ref` = uid or name (exact, then case-insensitive). Raises GrafanaError(404) if absent."""
    ref = (ref or "").strip()
    if not ref:
        raise GrafanaError(400, "datasource is required (uid or name; see `datasources`)")
    pool = sls_datasources(client) if only_sls else client.datasources()
    for d in pool:
        if d.get("uid") == ref or d.get("name") == ref:
            return d
    low = ref.lower()
    hits = [d for d in pool if (d.get("name") or "").lower() == low or (d.get("uid") or "").lower() == low]
    if len(hits) == 1:
        return hits[0]
    names = ", ".join(sorted(d.get("name", "") for d in pool))[:400]
    raise GrafanaError(404, "no %sdatasource named/uid %r (known: %s)" % ("SLS " if only_sls else "", ref, names))


# ----------------------------------------------------------------------------- time
_RFC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
_REL = re.compile(r"^now(?:-(\d+)([smhd]))?$")
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_time_ms(value, now=None):
    """epoch seconds | epoch ms | RFC3339 | now | now-30m  ->  epoch milliseconds (int)."""
    s = str(value if value is not None else "").strip()
    if not s:
        raise ValueError("empty time")
    now = int(time.time()) if now is None else int(now)
    m = _REL.match(s)
    if m:
        delta = int(m.group(1)) * _UNIT[m.group(2)] if m.group(1) else 0
        return (now - delta) * 1000
    if re.match(r"^-?\d+(\.\d+)?$", s):
        f = float(s)
        return int(f) if f >= 1e11 else int(f * 1000)     # < 1e11 => seconds (until year 5138)
    if _RFC.match(s):
        t = s.replace("Z", "+00:00")
        if re.search(r"[+-]\d{4}$", t):
            t = t[:-2] + ":" + t[-2:]
        if not re.search(r"[+-]\d{2}:\d{2}$", t):
            t += "+00:00"
        return int(_dt.datetime.fromisoformat(t).timestamp() * 1000)
    raise ValueError("unrecognised time %r (use epoch s/ms, RFC3339, now, now-30m)" % s)


# ----------------------------------------------------------------------------- query building
def clamp_limit(limit):
    try:
        n = int(limit) if limit is not None and str(limit).strip() else DEFAULT_LIMIT
    except (TypeError, ValueError):
        raise ValueError("limit must be an integer, got %r" % (limit,))
    if n <= 0:
        n = DEFAULT_LIMIT
    return min(n, MAX_LIMIT)


def build_query(uid, query, logstore=None, limit=DEFAULT_LIMIT, power_sql=False, ref_id="A"):
    """The aliyun-log-service-datasource query model (pkg/models.go QueryInfo), logs/table mode."""
    n = clamp_limit(limit)
    q = {
        "refId": ref_id, "datasource": {"uid": uid},
        "type": "all", "mode": "", "query": query, "xcol": "", "ycol": "",
        "logsPerPage": min(n, PAGE), "currentPage": 1, "totalLogs": n,
        "queryType": "range", "powerSql": bool(power_sql),
    }
    if logstore:
        q["logStore"] = logstore
    return q


def context_query(hostname, extra=None):
    """Synthesised 'context logs' search: the plugin has no GetContextLogs resource.
    Colon-keys are NOT double-quoted on this path (measured: the quoted form returns 0 rows)."""
    host = (hostname or "").strip()
    if not host:
        raise ValueError("hostname is required")
    q = '__tag__:__hostname__: "%s"' % host.replace('"', '\\"')
    if extra and str(extra).strip():
        q += " and " + str(extra).strip()
    return q


# ----------------------------------------------------------------------------- result parsing
def parse_result(res):
    """results.<refId> -> (columns, rows, info). Raises QueryError with the plugin's message."""
    if not isinstance(res, dict):
        raise QueryError("malformed result: %s" % _short(res))
    err = res.get("error")
    if err:
        msg = err if isinstance(err, str) else json.dumps(err, ensure_ascii=False)
        raise QueryError(msg.strip())
    frames = res.get("frames") or []
    columns, rows = [], []
    for fr in frames:
        fields = (fr.get("schema") or {}).get("fields") or []
        values = (fr.get("data") or {}).get("values") or []
        names = [f.get("name") or "" for f in fields]
        if not columns:
            columns = names
        elif names != columns:
            # a second frame with a different shape: keep the first shape, append what aligns by name
            idx = [names.index(c) if c in names else None for c in columns]
            n = max((len(v) for v in values), default=0)
            for i in range(n):
                rows.append([values[j][i] if (j is not None and i < len(values[j])) else None for j in idx])
            continue
        n = max((len(v) for v in values), default=0)
        for i in range(n):
            rows.append([values[j][i] if i < len(values[j]) else None for j in range(len(columns))])
    info = {"frames": len(frames), "status": res.get("status")}
    return columns, rows, info


def drop_columns(columns, rows, names):
    keep = [i for i, c in enumerate(columns) if c not in names]
    return [columns[i] for i in keep], [[r[i] for i in keep] for r in rows]


def to_tsv(columns, rows):
    def cell(v):
        if v is None:
            return ""
        s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
        return s.replace("\t", " ").replace("\r", " ").replace("\n", "\\n")
    out = ["\t".join(cell(c) for c in columns)]
    for r in rows:
        out.append("\t".join(cell(v) for v in r))
    return "\n".join(out)


def header(ds, logstore, frm_ms, to_ms, rows, limit, elapsed, extra=None):
    d = describe(ds)
    parts = [
        "datasource=%s" % d["name"], "uid=%s" % d["uid"], "project=%s" % d["project"],
        "logstore=%s" % (logstore or d["logstore"]), "from=%d" % frm_ms, "to=%d" % to_ms,
        "rows=%d" % rows, "truncated=%s" % ("true" if limit is not None and rows >= limit else "false"),
        "elapsed=%.2fs" % elapsed,
    ]
    if extra:
        parts.extend(extra)
    return "# " + " ".join(parts)


# ----------------------------------------------------------------------------- high-level ops
def run_query(client, ds, query, logstore, frm_ms, to_ms, limit, power_sql=False, keep_message=False):
    q = build_query(ds["uid"], query, logstore=logstore, limit=limit, power_sql=power_sql)
    t0 = time.time()
    results = client.ds_query([q], frm_ms, to_ms)
    elapsed = time.time() - t0
    columns, rows, info = parse_result(results.get("A"))
    if not keep_message and "message" in columns and len(columns) > 1:
        columns, rows = drop_columns(columns, rows, {"message"})
    return columns, rows, info, elapsed


def list_logstores(client, ds):
    project = (ds.get("jsonData") or {}).get("project", "")
    if not project:
        raise GrafanaError(400, "datasource %s has no project in jsonData" % ds.get("name"))
    payload = client.resource(ds["uid"], "api/getLogstoreList", {"Project": project})
    data = payload.get("data") if isinstance(payload, dict) else payload
    if isinstance(data, list):
        return [x if isinstance(x, str) else (x.get("logstoreName") or x.get("name") or json.dumps(x)) for x in data]
    raise GrafanaError(500, "unexpected getLogstoreList payload: %s" % _short(payload))


# ----------------------------------------------------------------------------- CLI
def _opt(v):
    """Holmes renders omitted optional params as '' — treat empty as unset."""
    return None if v is None or str(v).strip() == "" else v


def cmd_datasources(client, a):
    pool = client.datasources() if a.all_types else sls_datasources(client)
    rows = [describe(d) for d in pool]
    rows.sort(key=lambda r: r["name"].lower())
    if a.format == "json":
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        return 0
    print("# %d datasource(s)%s" % (len(rows), "" if a.all_types else " of type " + SLS_TYPE))
    cols = ["name", "uid", "type", "project", "logstore", "endpoint", "default"]
    print(to_tsv(cols, [[r[c] for c in cols] for r in rows]))
    return 0


def cmd_logstores(client, a):
    ds = resolve_datasource(client, a.datasource)
    names = list_logstores(client, ds)
    d = describe(ds)
    print("# datasource=%s uid=%s project=%s logstores=%d" % (d["name"], d["uid"], d["project"], len(names)))
    for n in names:
        print(n)
    return 0


def cmd_query(client, a):
    ds = resolve_datasource(client, a.datasource)
    frm_ms, to_ms = parse_time_ms(a.frm), parse_time_ms(a.to)
    if to_ms <= frm_ms:
        raise ValueError("--to (%d) must be after --from (%d)" % (to_ms, frm_ms))
    limit = clamp_limit(_opt(a.limit) or DEFAULT_LIMIT)
    columns, rows, info, elapsed = run_query(client, ds, a.query, _opt(a.logstore), frm_ms, to_ms, limit,
                                             power_sql=a.power_sql, keep_message=a.keep_message)
    if a.format == "json":
        print(json.dumps({"header": describe(ds), "logstore": _opt(a.logstore) or describe(ds)["logstore"],
                          "from": frm_ms, "to": to_ms, "columns": columns, "rows": rows,
                          "elapsed": round(elapsed, 3)}, ensure_ascii=False))
        return 0
    print(header(ds, _opt(a.logstore), frm_ms, to_ms, len(rows), limit, elapsed, ["frames=%s" % info["frames"]]))
    print(to_tsv(columns, rows))
    return 0


def cmd_context(client, a):
    ds = resolve_datasource(client, a.datasource)
    ts_ms = parse_time_ms(a.ts)
    before = int(_opt(a.before) or 30)
    after = int(_opt(a.after) or 30)
    frm_ms, to_ms = ts_ms - before * 1000, ts_ms + after * 1000
    limit = clamp_limit(_opt(a.limit) or 100)
    q = context_query(a.hostname, _opt(a.extra))
    columns, rows, info, elapsed = run_query(client, ds, q, _opt(a.logstore), frm_ms, to_ms, limit,
                                             keep_message=a.keep_message)
    print(header(ds, _opt(a.logstore), frm_ms, to_ms, len(rows), limit, elapsed,
                 ["query=%s" % json.dumps(q, ensure_ascii=False)]))
    print(to_tsv(columns, rows))
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="sls_query.py", description=__doc__.split("\n\n")[0])
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="HTTP timeout seconds (default 60)")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("datasources", help="list SLS datasources (name/uid/project/default logstore)")
    s.add_argument("--all-types", action="store_true", help="list every datasource type, not only SLS")
    s.add_argument("--format", choices=["tsv", "json"], default="tsv")
    s = sub.add_parser("logstores", help="list logstores of a datasource's project")
    s.add_argument("--datasource", required=True, help="datasource uid or name")
    s = sub.add_parser("query", help="run a search | SQL query")
    s.add_argument("--datasource", required=True)
    s.add_argument("--logstore", default="", help="override the datasource's default logstore")
    s.add_argument("--query", required=True, help="SLS query: '<search> | <SQL>' or '<search>'")
    s.add_argument("--from", dest="frm", required=True, help="epoch s/ms, RFC3339, now-30m")
    s.add_argument("--to", required=True)
    s.add_argument("--limit", default="", help="total rows (default %d, max %d)" % (DEFAULT_LIMIT, MAX_LIMIT))
    s.add_argument("--power-sql", action="store_true")
    s.add_argument("--keep-message", action="store_true", help="keep the plugin's aggregated 'message' column")
    s.add_argument("--format", choices=["tsv", "json"], default="tsv")
    s = sub.add_parser("context", help="raw logs of one host around a timestamp (synthesised context)")
    s.add_argument("--datasource", required=True)
    s.add_argument("--logstore", default="")
    s.add_argument("--hostname", required=True, help="value of __tag__:__hostname__")
    s.add_argument("--ts", required=True, help="epoch s/ms or RFC3339")
    s.add_argument("--before", default="", help="seconds before ts (default 30)")
    s.add_argument("--after", default="", help="seconds after ts (default 30)")
    s.add_argument("--limit", default="", help="total rows (default 100, max %d)" % MAX_LIMIT)
    s.add_argument("--extra", default="", help="extra search terms ANDed to the host filter")
    s.add_argument("--keep-message", action="store_true")
    return p


def main(argv=None, env=None):
    p = build_parser()
    a = p.parse_args(argv)
    if not a.cmd:
        p.print_help()
        return 2
    try:
        client = Grafana.from_env(env, timeout=a.timeout)
        return {"datasources": cmd_datasources, "logstores": cmd_logstores,
                "query": cmd_query, "context": cmd_context}[a.cmd](client, a)
    except QueryError as e:
        print("error: %s" % e)
        return 1
    except GrafanaError as e:
        print("error: grafana %s: %s" % (e.status or "-", e.message))
        return 1
    except ValueError as e:
        print("error: %s" % e)
        return 2


if __name__ == "__main__":
    sys.exit(main())
