import io
import json
import os
import sys
import unittest
from unittest import mock

from tests.helpers import HERE, SUITE, FakeGrafana, make_root, read, rmtree, write
from lib import cli, mcp
from lib.common import SuiteError


def run_cli(root, *argv):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
        code = cli.main(["--root", root] + list(argv))
    return code, out.getvalue(), err.getvalue()


class McpTests(unittest.TestCase):
    def test_example_matches_generator_and_carries_no_secret(self):
        text = read(os.path.join(SUITE, "mcp", "mcp.json.example"))
        body = "\n".join(l for l in text.splitlines() if not l.startswith("//"))
        self.assertEqual(json.loads(body), mcp.claude_mcp_json())
        argv = mcp.docker_stdio_argv()
        self.assertNotIn("glsa_", " ".join(argv))
        self.assertIn("-e", argv)
        self.assertIn("--disable-write", argv)
        self.assertIn("datasource,prometheus,alerting,dashboard,navigation,search", argv)
        self.assertIn("mcp_servers.grafana", mcp.codex_toml())

    def test_stdio_probe_against_fake_server(self):
        argv = [sys.executable, os.path.join(HERE, "fake_mcp.py")]
        env = {"GRAFANA_URL": "https://g.example", "GRAFANA_SERVICE_ACCOUNT_TOKEN": "tok", "GRAFANA_ORG_ID": "1"}
        pr = mcp.stdio_probe(env, argv=argv, wall=20)
        self.assertEqual(pr["server"]["name"], "fake-mcp-grafana")
        self.assertIn("query_prometheus", pr["tools"])
        self.assertEqual(pr["datasources"], 2)
        with self.assertRaises(SuiteError) as cm:      # process dies before answering -> says so, no fake timeout
            mcp.stdio_probe(env, argv=[sys.executable, "-c", "import sys; sys.exit(3)"], wall=20)
        self.assertIn("exited with code 3", str(cm.exception))
        with mock.patch.dict(os.environ, {"GRAFANA_SERVICE_ACCOUNT_TOKEN": ""}):
            with self.assertRaises(SuiteError):
                mcp.stdio_probe({"GRAFANA_URL": "x"}, argv=argv, wall=20)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.suite = os.path.join(self.root, "suites", "sre-inspect")
        write(os.path.join(self.suite, "env", ".env.holmes"), "GRAFANA_URL=https://grafana.example.internal\nGRAFANA_SERVICE_ACCOUNT_TOKEN=tok!v7\n")
        os.chmod(os.path.join(self.suite, "env", ".env.holmes"), 0o600)
        self.env = mock.patch.dict(os.environ, {"GRAFANA_URL": "", "GRAFANA_SERVICE_ACCOUNT_TOKEN": "", "SRE_INSPECT_ENV_FILE": ""})
        self.env.start()
        for k in ("GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN", "SRE_INSPECT_ENV_FILE"):
            os.environ.pop(k, None)

    def tearDown(self):
        self.env.stop()
        rmtree(self.root)

    def test_validate_window_mcp_config(self):
        code, out, err = run_cli(self.root, "validate")
        self.assertEqual(code, 0, out + err)
        self.assertIn("OK: validate", out)
        code, out, _ = run_cli(self.root, "window", "--at", "2026-08-27T13:21:30Z", "--before", "5m", "--after", "5m", "--json")
        self.assertEqual(code, 0)
        self.assertIn("from=1787836590 to=1787837190", out)
        code, out, _ = run_cli(self.root, "mcp-config")
        self.assertIn('"grafana"', out)
        self.assertIn("mcp_servers.grafana", out)

    def test_mcp_config_write_merges_and_is_idempotent(self):
        path = os.path.join(self.root, ".mcp.json")
        write(path, json.dumps({"mcpServers": {"other": {"command": "x", "args": []}}}))
        code, out, _ = run_cli(self.root, "mcp-config", "--write")
        self.assertEqual(code, 0, out)
        self.assertIn("updated", out)
        doc = json.loads(read(path))
        self.assertIn("other", doc["mcpServers"])
        self.assertEqual(doc["mcpServers"]["grafana"], mcp.claude_mcp_json()["mcpServers"]["grafana"])
        code, out, _ = run_cli(self.root, "mcp-config", "--write")
        self.assertIn("unchanged", out)
        write(path, "{not json")
        code, out, err = run_cli(self.root, "mcp-config", "--write")
        self.assertEqual(code, 1)
        self.assertIn("not valid JSON", err)
        os.remove(path)
        code, out, _ = run_cli(self.root, "mcp-config", "--write")
        self.assertIn("created", out)

    def test_validate_catches_toolset_credentials(self):
        write(os.path.join(self.suite, "toolsets", "bad.custom_toolset.yaml"), "toolsets:\n  x:\n    tools:\n      - name: t\n        command: \"curl -H 'X-Token: {{ env.SOME_TOKEN }}' https://x\"\n")
        code, out, _ = run_cli(self.root, "validate")
        self.assertEqual(code, 2)
        self.assertIn("credential shape", out)

    def test_intake_dive_finish_roundtrip(self):
        fake = FakeGrafana()
        with mock.patch.object(cli.grafana, "from_env", return_value=fake):
            code, out, err = run_cli(self.root, "intake", "--from", "1787830000", "--to", "1787850000")
        self.assertEqual(code, 0, out + err)
        self.assertIn("候选 1 件", out)
        q = json.load(open(os.path.join(self.root, "runs", "sre-inspect", "queue", "latest.json")))
        n = [it["n"] for it in q["items"] if it["candidate"]][0]
        with mock.patch.object(cli._deploys, "fetch", return_value=([], "")):
            code, out, err = run_cli(self.root, "dive", str(n))
        self.assertEqual(code, 0, out + err)
        inc_id = [l for l in out.splitlines() if l.startswith("incident ")][0].split()[1]
        inc = os.path.join(self.root, "runs", "sre-inspect", inc_id)
        for f in ("INSPECT.md", "report.json", "alert.json", "route.json", "facts.json", "deploys.json"):
            self.assertTrue(os.path.isfile(os.path.join(inc, f)), f)
        md = read(os.path.join(inc, "INSPECT.md"))
        self.assertIn("R-01", md)
        self.assertIn("from=1787835990 to=1787837790", md)
        # second dive of the same alert is suppressed by the ledger
        code, out, _ = run_cli(self.root, "dive", str(n))
        self.assertEqual(code, 3)
        self.assertIn("冷却窗内", out)
        # finish: fill the report as the agent would
        rep = json.load(open(os.path.join(inc, "report.json")))
        rep["verdict"].update({"value": "PASS", "summary": "window verified: zero 5xx; alert was a rule artefact"})
        write(os.path.join(inc, "report.json"), json.dumps(rep))
        write(os.path.join(inc, "rca.md"), "# rca\n\n" + "verified with anchor query, zero rows " * 3)
        code, out, err = run_cli(self.root, "finish", inc_id)
        self.assertEqual(code, 0, out + err)
        self.assertIn("verdict=PASS", out)
        ledger = json.load(open(os.path.join(self.root, "runs", "sre-inspect", "ledger.json")))
        self.assertTrue(ledger["entries"]["a1b2c3d4e5f60718"]["closed"])

    def test_dive_manual_and_gates(self):
        with mock.patch.object(cli._deploys, "fetch", return_value=(None, "not configured")):
            code, out, _ = run_cli(self.root, "dive", "--rule-uid", "nope", "--at", "1787836890")
            self.assertEqual(code, 3)
            self.assertIn("unrouted", out)
            code, out, _ = run_cli(self.root, "dive", "--rule-uid", "changeme00000003", "--at", "1787836890", "--subject", "host-1")
            self.assertEqual(code, 0, out)
            code, out, _ = run_cli(self.root, "dive", "--rule-uid", "changeme00000002", "--at", "1787836890", "--title", "DTS [no value]")
            self.assertEqual(code, 3)
            self.assertIn("known_bug", out)
        code, out, err = run_cli(self.root, "dive")
        self.assertEqual(code, 2)

    def test_doctor_with_fake_grafana(self):
        from lib import doctor
        fake = FakeGrafana()
        with mock.patch.object(doctor.grafana, "from_env", return_value=fake):
            code, out, err = run_cli(self.root, "doctor", "--no-mcp")
        self.assertEqual(code, 0, out + err)
        self.assertIn("[ OK ] MUST D1 Grafana /api/health", out)
        self.assertIn("D2 query up @ prom-cms", out)
        self.assertIn("D3 sls count @ log_nginx_access", out)
        self.assertNotIn("tok!v7", out)
        fake2 = FakeGrafana(perms={"datasources:query": ["datasources:uid:dsprom00000001"]})
        with mock.patch.object(doctor.grafana, "from_env", return_value=fake2):
            code, out, _ = run_cli(self.root, "doctor", "--no-mcp")
        self.assertEqual(code, 1)
        self.assertIn("[MISS] MUST D1 token has datasources:query", out)

    def test_doctor_reports_missing_env(self):
        os.remove(os.path.join(self.suite, "env", ".env.holmes"))
        code, out, _ = run_cli(self.root, "doctor", "--no-mcp")
        self.assertEqual(code, 1)
        self.assertIn("[MISS] MUST env file", out)

    def test_sls_passthrough_loads_env(self):
        with mock.patch("sls_query.Grafana.datasources", return_value=[]):
            code, out, _ = run_cli(self.root, "sls", "datasources")
        self.assertEqual(code, 0)
        self.assertEqual(os.environ.get("GRAFANA_SERVICE_ACCOUNT_TOKEN"), "tok!v7")


if __name__ == "__main__":
    unittest.main()
