import os
import unittest

from tests.helpers import SUITE, make_root, read, rmtree, write
from lib import tenant as T, yamlmini


class YamlMiniTests(unittest.TestCase):
    def test_shapes(self):
        d = yamlmini.parse("a: 1\nb: [x, y]\nc: {k: v, l: [1, 2]}\nd:\n  - name: n1\n    v: 2\n  - name: n2\ne: \"q # not comment\"\nf: true\ng: ~\nh:\n  - {name: inline, project: p}\n")
        self.assertEqual(d["a"], 1)
        self.assertEqual(d["b"], ["x", "y"])
        self.assertEqual(d["c"], {"k": "v", "l": [1, 2]})
        self.assertEqual(d["d"], [{"name": "n1", "v": 2}, {"name": "n2"}])
        self.assertEqual(d["e"], "q # not comment")
        self.assertIs(d["f"], True)
        self.assertIsNone(d["g"])
        self.assertEqual(d["h"], [{"name": "inline", "project": "p"}])

    def test_quoted_value_followed_by_comment(self):
        # first Mac run: `- datasource: "Metrics of X"   # cms` kept the quotes as content
        d = yamlmini.parse('a: "x y" # c\nb:\n  - datasource: "M of X"   # cms\n  - datasource: plain # c\nc: \'q\' #z\n')
        self.assertEqual(d["a"], "x y")
        self.assertEqual(d["b"], [{"datasource": "M of X"}, {"datasource": "plain"}])
        self.assertEqual(d["c"], "q")

    def test_example_parses(self):
        d = yamlmini.parse(read(os.path.join(SUITE, "tenant.yaml.example")))
        self.assertEqual(d["schema_version"], 1)
        self.assertEqual(d["grafana"]["datasources"]["logs"][0]["logstore"], "nginx-access")
        self.assertEqual(d["alert_source"]["filter"]["exclude_labels"], {"severity": ["info"]})
        self.assertEqual(d["deploys"][0]["workflow"], "Production Deploy")
        r = yamlmini.parse(read(os.path.join(SUITE, "routes.yaml.example")))
        self.assertEqual(len(r["rules"]), 3)
        self.assertEqual(r["rules"][1]["known_bug"]["match"], "[no value]")


class TenantTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.suite = os.path.join(self.root, "suites", "sre-inspect")

    def tearDown(self):
        rmtree(self.root)

    def test_example_validates(self):
        t = T.load(self.suite)
        self.assertEqual(T.validate(t), [])
        self.assertEqual(t.cooldown, 1800)
        self.assertEqual(t.recurrence, 14 * 86400)
        self.assertEqual(t.datasource_names(), ["log_nginx_access", "log_app", "prom-cms", "prom-app"])
        routes, path = T.load_routes(self.suite, t)
        self.assertEqual(sorted(routes), ["changeme00000001", "changeme00000002", "changeme00000003"])
        self.assertEqual(T.validate_routes(routes, self.suite, t), [])
        self.assertEqual(routes["changeme00000002"].known_bug_match, "[no value]")

    def test_datasource_key_only(self):
        t = T.load(self.suite)                      # the example uses `datasource:`
        self.assertEqual(t.logs[0]["name"], "log_nginx_access")
        self.assertEqual(T.validate(t), [])
        text = read(os.path.join(self.suite, "tenant.yaml")).replace("datasource: log_app", "name: log_app")
        write(os.path.join(self.suite, "tenant.yaml"), text)
        probs = T.validate(T.load(self.suite))
        self.assertTrue(any("renamed to `datasource:`" in x for x in probs), probs)

    def test_local_overrides(self):
        write(os.path.join(self.suite, "tenant.local.yaml"), read(os.path.join(self.suite, "tenant.yaml")).replace("id: example", "id: local"))
        self.assertEqual(T.load(self.suite).id, "local")
        write(os.path.join(self.suite, "routes.local.yaml"), "rules:\n  - rule_uid: onlylocal000001\n    rid: R-99\n    name: x\n    layer: L1\n    template: _template.md\n")
        routes, path = T.load_routes(self.suite, T.load(self.suite))
        self.assertEqual(list(routes), ["onlylocal000001"])
        self.assertTrue(path.endswith("routes.local.yaml"))

    def test_problems_reported(self):
        text = read(os.path.join(self.suite, "tenant.yaml"))
        text = text.replace("schema_version: 1", "schema_version: 2").replace("url: https://grafana.example.internal", "url: grafana.example")
        text = text.replace("metrics_datasource: prom-cms", "metrics_datasource: nope").replace("timezone: Asia/Singapore", "timezone: Mars/Olympus")
        write(os.path.join(self.suite, "tenant.yaml"), text)
        probs = T.validate(T.load(self.suite))
        joined = "\n".join(probs)
        for needle in ("schema_version", "grafana.url", "probe.metrics_datasource", "timezone"):
            self.assertIn(needle, joined)

    def test_missing_template_is_a_routes_problem(self):
        t = T.load(self.suite)
        write(os.path.join(self.suite, "routes.yaml"), "rules:\n  - rule_uid: r1\n    rid: R-1\n    name: n\n    layer: L2\n    template: missing.md\n")
        routes, _ = T.load_routes(self.suite, t)
        self.assertEqual(len(T.validate_routes(routes, self.suite, t)), 1)

    def test_missing_tenant_is_usage_error(self):
        os.remove(os.path.join(self.suite, "tenant.yaml"))
        from lib.common import SuiteError
        with self.assertRaises(SuiteError) as cm:
            T.load(self.suite)
        self.assertEqual(cm.exception.code, 2)


class EnvfileTests(unittest.TestCase):
    def test_parse_and_placeholders(self):
        from lib import envfile
        text = read(os.path.join(SUITE, "env", "holmes-env.example"))
        v = envfile.parse(text)
        self.assertEqual(v["GRAFANA_URL"], "https://grafana.example.internal")
        self.assertEqual(v["GRAFANA_SERVICE_ACCOUNT_TOKEN"], "")      # <placeholder> == unset
        self.assertEqual(envfile.describe(v)["GRAFANA_SERVICE_ACCOUNT_TOKEN"], "missing")
        v2 = envfile.parse('export A="x y" # c\nB=v # comment\n# C=1\nBAD LINE\n')
        self.assertEqual(v2, {"A": "x y", "B": "v"})


if __name__ == "__main__":
    unittest.main()
