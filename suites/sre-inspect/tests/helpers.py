"""Test helpers: paths, a fake Grafana client, and a throwaway workspace root holding a copy of the suite."""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SUITE = os.path.dirname(HERE)
REAL_ROOT = os.path.dirname(os.path.dirname(SUITE))
FIXTURES = os.path.join(HERE, "fixtures")
sys.path.insert(0, SUITE)
sys.path.insert(0, os.path.join(SUITE, "tools", "grafana-sls"))


def fixture(name):
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8") as f:
        return json.load(f) if name.endswith(".json") else f.read()


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class FakeGrafana:
    """Duck-typed stand-in for lib.grafana.Client. Canned answers from fixtures; records calls."""

    def __init__(self, datasources=None, am=None, annotations=None, rules=None, perms=None, count=2135507):
        self.calls = []
        self._ds = datasources if datasources is not None else fixture("datasources.json")
        self._am = am if am is not None else fixture("am_alerts.json")
        self._ann = annotations if annotations is not None else fixture("annotations.json")
        self._rules = rules if rules is not None else fixture("rules.json")
        self._perms = perms if perms is not None else {"datasources:query": ["datasources:*"]}
        self._count = count
        self.url = "https://grafana.example.internal"

    def health(self):
        return {"database": "ok", "version": "12.1.1"}

    def build_info(self):
        return {"version": "12.1.1", "edition": "Enterprise"}

    def frontend_settings(self):
        return {"buildInfo": self.build_info(), "rbacEnabled": True, "licenseInfo": {"stateInfo": "Free & unlicensed"}}

    def whoami(self):
        return {"login": "sa-inspect", "orgId": 1}

    def datasources(self):
        self.calls.append("datasources")
        return self._ds

    def permissions(self):
        return self._perms

    def am_alerts(self):
        return self._am

    def annotations_alert(self, frm_ms, to_ms, limit=5000):
        return self._ann

    def alert_rules(self):
        return self._rules

    def policies(self):
        return {"receiver": "oncall", "routes": []}

    def resource(self, uid, path, body=None):
        self.calls.append(("resource", uid, path, body))
        return {"data": ["nginx-access", "app"], "message": ""}

    def ds_query(self, queries, frm, to):
        self.calls.append(("ds_query", queries, frm, to))
        q = queries[0]
        if "expr" in q:
            return {"A": {"status": 200, "frames": [{"schema": {"refId": "A", "fields": [{"name": "Time", "type": "time"}, {"name": "up", "type": "number"}]},
                                                     "data": {"values": [[1787902991000], [1]]}}]}}
        if "nosuch" in q.get("query", ""):
            return {"A": {"status": 500, "error": '{"httpCode": 400, "errorCode": "ParameterInvalid", "errorMessage": "key (nosuchfield_xyz) is not config as key value config"}', "errorSource": "plugin"}}
        if "|" in q.get("query", ""):
            return {"A": {"status": 200, "frames": [{"schema": {"refId": "A", "fields": [{"name": "c", "type": "string"}]},
                                                     "data": {"values": [[str(self._count)]]}}]}}
        return fixture("ds_query_logs.json")["results"]

    def prom_query(self, uid, expr, frm_ms, to_ms, instant=True, step_ms=60000):
        import sls_query
        return sls_query.parse_result(self.ds_query([{"refId": "A", "datasource": {"uid": uid}, "expr": expr}], frm_ms, to_ms).get("A"))

    def rule_history(self, uid, frm_s, to_s, limit=5000):
        return []


def make_root(with_tenant=True, with_routes=True, tenant_text=None):
    """A temp workspace root with a copy of the suite (no tests) + sre-autofix's scrub.py."""
    tmp = tempfile.mkdtemp(prefix="sre-inspect-test-")
    dst = os.path.join(tmp, "suites", "sre-inspect")
    shutil.copytree(SUITE, dst, ignore=shutil.ignore_patterns("tests", "__pycache__", ".holmes", "tool-results", "*.local.yaml", ".env.*"))
    os.makedirs(os.path.join(tmp, "suites", "sre-autofix", "lib"), exist_ok=True)
    shutil.copy(os.path.join(REAL_ROOT, "suites", "sre-autofix", "lib", "scrub.py"), os.path.join(tmp, "suites", "sre-autofix", "lib", "scrub.py"))
    write(os.path.join(tmp, "workspace.yaml"), "owner: test\nteam: t\nrepositories: []\nagent_suites: []\nrequired_local_permissions: []\n")
    if with_tenant:
        text = tenant_text if tenant_text is not None else read(os.path.join(SUITE, "tenant.yaml.example"))
        write(os.path.join(dst, "tenant.yaml"), text)
    if with_routes:
        write(os.path.join(dst, "routes.yaml"), read(os.path.join(SUITE, "routes.yaml.example")))
    return tmp


def rmtree(path):
    shutil.rmtree(path, ignore_errors=True)
