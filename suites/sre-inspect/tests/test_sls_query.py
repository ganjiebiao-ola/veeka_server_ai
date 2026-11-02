import io
import json
import os
import unittest
from unittest import mock

from tests.helpers import FIXTURES, fixture  # noqa: F401
import sls_query as sq


class FakeResp(io.BytesIO):
    def __init__(self, status, payload, headers=None):
        super().__init__(json.dumps(payload).encode() if not isinstance(payload, (bytes, str)) else (payload if isinstance(payload, bytes) else payload.encode()))
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_for(routes):
    """routes: (method, path-prefix) -> (status, payload) or callable(req) -> (status, payload)."""
    seen = []

    def _open(req, timeout=0):
        seen.append(req)
        path = req.full_url.split("://", 1)[1].split("/", 1)[1]
        for (m, p), out in routes.items():
            if req.get_method() == m and ("/" + path).startswith(p):
                out = out(req) if callable(out) else out
                status, payload = out
                if status >= 400:
                    import urllib.error
                    raise urllib.error.HTTPError(req.full_url, status, "x", {}, io.BytesIO(json.dumps(payload).encode()))
                return FakeResp(status, payload)
        raise AssertionError("unexpected request %s %s" % (req.get_method(), path))
    _open.seen = seen
    return _open


ENV = {"GRAFANA_URL": "https://g.example/", "GRAFANA_SERVICE_ACCOUNT_TOKEN": "t"}


class TimeTests(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(sq.parse_time_ms("1787760000"), 1787760000000)
        self.assertEqual(sq.parse_time_ms("1787760000000"), 1787760000000)
        self.assertEqual(sq.parse_time_ms(1787760000.5), 1787760000500)
        self.assertEqual(sq.parse_time_ms("2026-08-28T07:40:00Z"), 1787902800000)
        self.assertEqual(sq.parse_time_ms("2026-08-28T15:40:00+08:00"), 1787902800000)
        self.assertEqual(sq.parse_time_ms("2026-08-28T15:40:00+0800"), 1787902800000)
        self.assertEqual(sq.parse_time_ms("now", now=100), 100000)
        self.assertEqual(sq.parse_time_ms("now-30m", now=3600), 1800000)
        self.assertEqual(sq.parse_time_ms("now-1d", now=90000), 3600000)
        for bad in ("", "yesterday", "12:00"):
            with self.assertRaises(ValueError):
                sq.parse_time_ms(bad)


class BuildTests(unittest.TestCase):
    def test_limit_clamp(self):
        self.assertEqual(sq.clamp_limit(""), sq.DEFAULT_LIMIT)
        self.assertEqual(sq.clamp_limit(None), sq.DEFAULT_LIMIT)
        self.assertEqual(sq.clamp_limit("0"), sq.DEFAULT_LIMIT)
        self.assertEqual(sq.clamp_limit(20), 20)
        self.assertEqual(sq.clamp_limit(9999), sq.MAX_LIMIT)
        with self.assertRaises(ValueError):
            sq.clamp_limit("many")

    def test_query_model(self):
        q = sq.build_query("uid1", "status >= 500 | select count(*) as c", limit=150)
        self.assertEqual(q["datasource"], {"uid": "uid1"})
        self.assertEqual((q["totalLogs"], q["logsPerPage"], q["currentPage"]), (150, 100, 1))
        self.assertEqual((q["type"], q["queryType"], q["xcol"], q["ycol"], q["powerSql"]), ("all", "range", "", "", False))
        self.assertNotIn("logStore", q)
        q2 = sq.build_query("uid1", "*", logstore="app", limit=20, power_sql=True)
        self.assertEqual((q2["logStore"], q2["logsPerPage"], q2["powerSql"]), ("app", 20, True))

    def test_context_query_never_quotes_colon_key(self):
        self.assertEqual(sq.context_query("app-host-003"), '__tag__:__hostname__: "app-host-003"')
        self.assertEqual(sq.context_query("h", 'status >= 500'), '__tag__:__hostname__: "h" and status >= 500')
        with self.assertRaises(ValueError):
            sq.context_query("  ")


class ParseTests(unittest.TestCase):
    def test_logs_frame_to_rows(self):
        cols, rows, info = sq.parse_result(fixture("ds_query_logs.json")["results"]["A"])
        self.assertEqual(cols[:2], ["time", "message"])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0][3], "500")
        c2, r2 = sq.drop_columns(cols, rows, {"message"})
        self.assertNotIn("message", c2)
        self.assertEqual(r2[1], [1787902923000, "/v1/orders", "200", "app-host-004"])

    def test_error_passthrough(self):
        with self.assertRaises(sq.QueryError) as cm:
            sq.parse_result({"status": 500, "error": '{"errorCode":"ParameterInvalid","errorMessage":"key (x) is not config"}'})
        self.assertIn("ParameterInvalid", str(cm.exception))
        with self.assertRaises(sq.QueryError):
            sq.parse_result(None)

    def test_multi_frame_aligns_by_name(self):
        res = {"frames": [
            {"schema": {"fields": [{"name": "a"}, {"name": "b"}]}, "data": {"values": [[1], [2]]}},
            {"schema": {"fields": [{"name": "b"}, {"name": "a"}]}, "data": {"values": [[4], [3]]}},
        ]}
        cols, rows, _ = sq.parse_result(res)
        self.assertEqual(cols, ["a", "b"])
        self.assertEqual(rows, [[1, 2], [3, 4]])

    def test_tsv_escaping(self):
        out = sq.to_tsv(["a", "b"], [["x\ty", "l1\nl2"], [None, {"k": 1}]])
        self.assertEqual(out.split("\n")[1], "x y\tl1\\nl2")
        self.assertEqual(out.split("\n")[2], '\t{"k": 1}')


class ClientTests(unittest.TestCase):
    def test_env_required(self):
        with self.assertRaises(sq.GrafanaError):
            sq.Grafana.from_env({})

    def test_resolve_and_header(self):
        op = opener_for({("GET", "/api/datasources"): (200, fixture("datasources.json"))})
        c = sq.Grafana("https://g.example", "t", opener=op)
        self.assertEqual(sq.resolve_datasource(c, "log_app")["uid"], "dssls000000002")
        self.assertEqual(sq.resolve_datasource(c, "dssls000000001")["name"], "log_nginx_access")
        self.assertEqual(sq.resolve_datasource(c, "LOG_APP")["uid"], "dssls000000002")
        with self.assertRaises(sq.GrafanaError):
            sq.resolve_datasource(c, "prom-cms")       # not SLS
        with self.assertRaises(sq.GrafanaError):
            sq.resolve_datasource(c, "")
        h = sq.header(sq.resolve_datasource(c, "log_app"), None, 1000, 2000, 50, 50, 0.5)
        self.assertIn("project=app-logs", h)
        self.assertIn("logstore=app", h)
        self.assertIn("truncated=true", h)
        self.assertTrue(all(r.get_header("Authorization") == "Bearer t" for r in op.seen))

    def test_auth_errors_map_to_grafana_error(self):
        op = opener_for({("GET", "/api/datasources"): (401, {"message": "invalid token"})})
        c = sq.Grafana("https://g.example", "t", opener=op)
        with self.assertRaises(sq.GrafanaError) as cm:
            c.datasources()
        self.assertEqual(cm.exception.status, 401)

    def test_run_query_drops_message_and_times(self):
        def dsq(req):
            body = json.loads(req.data.decode())
            q = body["queries"][0]
            assert q["logStore"] == "app" and body["from"] == "1000000" and body["to"] == "2000000"
            return 200, fixture("ds_query_logs.json")
        op = opener_for({("GET", "/api/datasources"): (200, fixture("datasources.json")), ("POST", "/api/ds/query"): dsq})
        c = sq.Grafana("https://g.example", "t", opener=op)
        ds = sq.resolve_datasource(c, "log_nginx_access")
        cols, rows, info, el = sq.run_query(c, ds, "*", "app", 1000000, 2000000, 10)
        self.assertNotIn("message", cols)
        self.assertEqual(len(rows), 2)

    def test_logstores_resource_posts_project(self):
        def res(req):
            assert req.get_method() == "POST" and json.loads(req.data.decode()) == {"Project": "app-logs"}
            return 200, {"data": ["nginx-access", "app"], "message": ""}
        op = opener_for({("GET", "/api/datasources"): (200, fixture("datasources.json")),
                         ("POST", "/api/datasources/uid/dssls000000001/resources/api/getLogstoreList"): res})
        c = sq.Grafana("https://g.example", "t", opener=op)
        self.assertEqual(sq.list_logstores(c, sq.resolve_datasource(c, "log_nginx_access")), ["nginx-access", "app"])


class CliTests(unittest.TestCase):
    def run_cli(self, argv, routes, env=ENV):
        op = opener_for(routes)
        out = io.StringIO()
        with mock.patch.object(sq.urllib.request, "urlopen", op), mock.patch("sys.stdout", out):
            code = sq.main(argv, env=env)
        return code, out.getvalue(), op

    def test_missing_env_is_one_error_line(self):
        code, out, _ = self.run_cli(["datasources"], {}, env={})
        self.assertEqual(code, 1)
        self.assertTrue(out.startswith("error: grafana"))

    def test_datasources_lists_only_sls(self):
        code, out, _ = self.run_cli(["datasources"], {("GET", "/api/datasources"): (200, fixture("datasources.json"))})
        self.assertEqual(code, 0)
        self.assertIn("log_app", out)
        self.assertNotIn("prom-cms", out)
        self.assertTrue(out.startswith("# 2 datasource(s)"))

    def test_query_tsv_header_and_error(self):
        def dsq(req):
            q = json.loads(req.data.decode())["queries"][0]
            if "nosuch" in q["query"]:
                return 200, {"results": {"A": {"status": 500, "error": '{"errorCode":"ParameterInvalid","errorMessage":"key (nosuch) is not config"}'}}}
            return 200, {"results": {"A": {"frames": [{"schema": {"fields": [{"name": "c", "type": "string"}]}, "data": {"values": [["42"]]}}]}}}
        routes = {("GET", "/api/datasources"): (200, fixture("datasources.json")), ("POST", "/api/ds/query"): dsq}
        code, out, op = self.run_cli(["query", "--datasource", "log_app", "--query", "* | select count(*) as c",
                                      "--from", "1787760000", "--to", "1787761800", "--limit", ""], routes)
        self.assertEqual(code, 0, out)
        first, second, third = out.strip().split("\n")
        self.assertTrue(first.startswith("# datasource=log_app uid=dssls000000002 project=app-logs logstore=app from=1787760000000 to=1787761800000 rows=1 truncated=false"))
        self.assertEqual((second, third), ("c", "42"))
        code, out, _ = self.run_cli(["query", "--datasource", "log_app", "--query", "nosuch: 1 | select count(*)",
                                     "--from", "now-30m", "--to", "now"], routes)
        self.assertEqual(code, 1)
        self.assertIn("error: ", out)
        self.assertIn("ParameterInvalid", out)
        code, out, _ = self.run_cli(["query", "--datasource", "log_app", "--query", "*", "--from", "2000", "--to", "1000"], routes)
        self.assertEqual(code, 2)

    def test_context_synthesises_window_and_filter(self):
        def dsq(req):
            body = json.loads(req.data.decode())
            q = body["queries"][0]
            assert q["query"] == '__tag__:__hostname__: "app-host-003"', q["query"]
            assert body["from"] == str((1787760000 - 10) * 1000) and body["to"] == str((1787760000 + 30) * 1000)
            assert q["totalLogs"] == 100
            return 200, fixture("ds_query_logs.json")
        routes = {("GET", "/api/datasources"): (200, fixture("datasources.json")), ("POST", "/api/ds/query"): dsq}
        code, out, _ = self.run_cli(["context", "--datasource", "log_nginx_access", "--logstore", "", "--hostname", "app-host-003",
                                     "--ts", "1787760000", "--before", "10", "--after", ""], routes)
        self.assertEqual(code, 0, out)
        self.assertIn("query=", out.split("\n")[0])
        self.assertNotIn("Bearer", out)


if __name__ == "__main__":
    unittest.main()
