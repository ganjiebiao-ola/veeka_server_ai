"""tenant.yaml + routes.yaml — the department's structured configuration (schema_version 1).

Precedence: `<name>.local.yaml` (gitignored; for running the template checkout against a real
Grafana) > `<name>.yaml` (the department instance's tracked copy). `tenant.yaml.example` is never
loaded — copying it is the operator's explicit act.
"""
import os

from . import yamlmini
from .common import SuiteError, parse_duration, read_text
from .window import tz_from

DEFAULT_SUBJECT_LABELS = ["instance", "api", "topic", "processGroup", "hostName", "host"]


def _first_existing(suite_dir, names):
    for n in names:
        p = os.path.join(suite_dir, n)
        if os.path.isfile(p):
            return p
    return None


def tenant_file(suite_dir):
    return _first_existing(suite_dir, ["tenant.local.yaml", "tenant.yaml"])


def routes_file(suite_dir, configured="routes.yaml"):
    base, ext = os.path.splitext(configured or "routes.yaml")
    return _first_existing(suite_dir, [base + ".local" + ext, configured or "routes.yaml"])


class Tenant:
    def __init__(self, raw, path):
        self.raw = raw or {}
        self.path = path
        t = self.raw.get("tenant") or {}
        self.id = str(t.get("id", "")).strip()
        self.display_name = str(t.get("display_name", self.id) or self.id)
        self.timezone = str(t.get("timezone", "UTC"))
        g = self.raw.get("grafana") or {}
        self.grafana_url = str(g.get("url", "")).strip().rstrip("/")
        self.org_id = g.get("org_id", 1)
        ds = g.get("datasources") or {}

        def _norm(entry):
            # the entry names a Grafana DATASOURCE (its display name, org-unique) — never a metric.
            # `datasource:` is the only accepted key; it is stored as `name` internally because that
            # is the field the Grafana API answers with.
            d = dict(entry)
            legacy = "name" in d and "datasource" not in d
            d["name"] = str(d.pop("datasource", "") or "").strip()
            if legacy:
                d["_legacy_key"] = True
            return d
        self.logs = [_norm(d) for d in (ds.get("logs") or []) if isinstance(d, dict)]
        self.metrics = [_norm(d) for d in (ds.get("metrics") or []) if isinstance(d, dict)]
        self.default_logs = str(g.get("default_logs_datasource", "") or "").strip()
        self.probe = g.get("probe") or {}
        a = self.raw.get("alert_source") or {}
        self.adapter = str(a.get("adapter", "grafana"))
        self.lookback = str(a.get("lookback", "24h"))
        self.subject_labels = list(a.get("subject_labels") or DEFAULT_SUBJECT_LABELS)
        self.filter = a.get("filter") or {}
        self.routes_file = str((self.raw.get("routing") or {}).get("file", "routes.yaml"))
        self.deploys = [d for d in (self.raw.get("deploys") or []) if isinstance(d, dict)]
        led = self.raw.get("ledger") or {}
        self.cooldown = parse_duration(led.get("cooldown", "30m"), 1800)
        self.recurrence = parse_duration(led.get("recurrence", "14d"), 14 * 86400)
        k = self.raw.get("knowledge") or {}
        self.triage_dir = str(k.get("triage_dir", "triage"))
        self.skills = list(k.get("skills") or ["grafana-sls"])
        self.background_skill = str(k.get("background_skill", "") or "")
        self.holmes = self.raw.get("holmes") or {}

    def tz(self):
        return tz_from(self.timezone)

    def datasource_names(self):
        return [str(d.get("name", "")) for d in self.logs + self.metrics if d.get("name")]

    def logs_ds(self, name):
        for d in self.logs:
            if d.get("name") == name:
                return d
        return None


def load(suite_dir):
    path = tenant_file(suite_dir)
    if not path:
        raise SuiteError("no tenant.yaml in %s — copy tenant.yaml.example to tenant.yaml (department instance) "
                         "or tenant.local.yaml (gitignored, for trying the template against a real Grafana)" % suite_dir, 2)
    try:
        raw = yamlmini.parse(read_text(path, ""))
    except Exception as e:
        raise SuiteError("cannot parse %s: %s" % (path, e), 2)
    return Tenant(raw, path)


def validate(t):
    """Return a list of problems (empty = ok). Structural only; live checks are `run doctor`."""
    p = []
    if str(t.raw.get("schema_version", "")) != "1":
        p.append("schema_version must be 1")
    if not t.id:
        p.append("tenant.id is required")
    _, tzname = t.tz()
    if "unavailable" in tzname:
        p.append("tenant.timezone %r not resolvable (use an IANA name or +08:00)" % t.timezone)
    if not t.grafana_url.startswith(("http://", "https://")):
        p.append("grafana.url must be an http(s) URL")
    names = t.datasource_names()
    if not t.logs:
        p.append("grafana.datasources.logs must list at least one SLS datasource {datasource, project, logstore}")
    for side, entries in (("logs", t.logs), ("metrics", t.metrics)):
        for d in entries:
            if d.get("_legacy_key"):
                p.append("grafana.datasources.%s: `name:` was renamed to `datasource:` — update the entry" % side)
            elif not d.get("name"):
                p.append("grafana.datasources.%s: every entry needs `datasource:` (the Grafana datasource display name)" % side)
    if not t.metrics:
        p.append("grafana.datasources.metrics must list at least one Prometheus datasource {datasource}")
    if len(names) != len(set(names)):
        p.append("datasource names must be unique")
    if t.default_logs and t.default_logs not in names:
        p.append("grafana.default_logs_datasource %r is not in datasources.logs (configured: %s)" % (t.default_logs, ", ".join(repr(n) for n in names)))
    for key in ("logs_datasource", "metrics_datasource"):
        v = t.probe.get(key)
        if not v:
            p.append("grafana.probe.%s is required (doctor D2/D3 target)" % key)
        elif v not in names:
            # repr on both sides on purpose: the usual cause is an invisible difference (curly quotes
            # from a chat/editor paste, a non-breaking space, a doubled space)
            p.append("grafana.probe.%s %r is not a configured datasource (configured: %s) — compare character by character"
                     % (key, v, ", ".join(repr(n) for n in names)))
    if t.adapter != "grafana":
        p.append("alert_source.adapter: only 'grafana' is implemented (got %r)" % t.adapter)
    for side in ("include_labels", "exclude_labels"):
        m = t.filter.get(side)
        if m is not None and not isinstance(m, dict):
            p.append("alert_source.filter.%s must be a map label -> [values]" % side)
    for d in t.deploys:
        if not d.get("repo") or "/" not in str(d.get("repo")):
            p.append("deploys[]: repo must be owner/name")
        if not d.get("workflow"):
            p.append("deploys[]: workflow (GitHub Actions workflow name) is required")
    try:
        parse_duration(t.lookback)
    except SuiteError:
        p.append("alert_source.lookback %r is not a duration" % t.lookback)
    return p


class Route:
    """One routes.yaml rule."""

    def __init__(self, d):
        self.rule_uid = str(d.get("rule_uid", "")).strip()
        self.title = str(d.get("title", "") or "").strip()
        self.rid = str(d.get("rid", "")).strip()
        self.name = str(d.get("name", "")).strip()
        self.layer = str(d.get("layer", "")).strip()
        self.template = str(d.get("template", "") or "").strip()
        kb = d.get("known_bug") or {}
        self.known_bug_match = str(kb.get("match", "") or "")
        self.known_bug_reason = str(kb.get("reason", "") or "")

    def as_dict(self):
        return {"rule_uid": self.rule_uid, "title": self.title, "rid": self.rid, "name": self.name,
                "layer": self.layer, "template": self.template,
                "known_bug": {"match": self.known_bug_match, "reason": self.known_bug_reason} if self.known_bug_match else None}


def load_routes(suite_dir, t):
    path = routes_file(suite_dir, t.routes_file)
    if not path:
        return {}, None
    raw = yamlmini.parse(read_text(path, ""))
    out = {}
    for d in raw.get("rules") or []:
        if isinstance(d, dict):
            r = Route(d)
            if r.rule_uid:
                out[r.rule_uid] = r
    return out, path


def validate_routes(routes, suite_dir, t):
    p = []
    tdir = os.path.join(suite_dir, t.triage_dir)
    for uid, r in routes.items():
        if not r.rid:
            p.append("routes: %s has no rid" % uid)
        if r.template and not os.path.isfile(os.path.join(tdir, r.template)):
            p.append("routes: %s template %s not found under %s/" % (uid, r.template, t.triage_dir))
    return p
