import os
import unittest

from helpers import FIXTURES, REPO_ID, TempDir, make_fake_workspace, shipped_config, write
from lib import config as C


class ParserTest(unittest.TestCase):
    def test_parses_suite_shapes(self):
        obj = C.parse_simple_yaml(
            "version: 1\nmin_confidence: high\nscaffold: [A.md, B/]\nrepos:\n  - id: r1\n    scope: [\"app/\", cli/]\n"
            "    base: main\n  - id: \"TODO(owner): x\"\n    scope: []\nheadless:\n  agent: auto\n  model: \"\"\n  retries: 2\n  command: []\n")
        self.assertEqual(obj["version"], 1)
        self.assertEqual(obj["min_confidence"], "high")
        self.assertEqual(obj["scaffold"], ["A.md", "B/"])
        self.assertEqual(obj["repos"][0], {"id": "r1", "scope": ["app/", "cli/"], "base": "main"})
        self.assertEqual(obj["repos"][1]["scope"], [])
        self.assertEqual(obj["headless"], {"agent": "auto", "model": "", "retries": 2, "command": []})

    def test_trailing_comments_and_quotes(self):
        obj = C.parse_simple_yaml("a: main  # comment\nb: \"x # not a comment\"\nc: true\n")
        self.assertEqual(obj, {"a": "main", "b": "x # not a comment", "c": True})

    def test_shipped_config_parses_and_is_all_todo(self):
        cfg = C.Config(C.parse_simple_yaml(shipped_config()))
        self.assertEqual(cfg.min_confidence, "medium")
        self.assertEqual(cfg.scaffold, ["INCIDENT.md", "FIXNOTES.md", ".sre-evidence/"])
        self.assertEqual(len(cfg.repos), 1)
        self.assertTrue(C.is_placeholder(cfg.repos[0].id))
        self.assertFalse(cfg.repos[0].scope_ok())
        self.assertEqual(cfg.headless["retries"], 1)
        self.assertEqual(cfg.checks_wall_sec, 600)
        self.assertFalse(cfg.repos[0].checks_configured())   # shipped config: checks: []

    def test_repo_checks_parse_and_placeholders(self):
        cfg = C.Config(C.parse_simple_yaml(
            "checks_wall_sec: 45\nrepos:\n  - id: go1\n    scope: [internal/]\n"
            "    checks: [\"go build ./...\", 'go vet ./...']\n"
            "  - id: php1\n    scope: [app/]\n    checks: [\"php -l {files}\", \"docker run --rm -v {worktree}:/app x analyse {files}\"]\n"
            "  - id: todo\n    scope: [a/]\n    checks: [\"TODO(owner): go vet\"]\n"
            "  - id: none\n    scope: [a/]\n"))
        self.assertEqual(cfg.checks_wall_sec, 45)
        go1, php1, todo, none = cfg.repos
        self.assertEqual(go1.checks, ["go build ./...", "go vet ./..."])
        self.assertTrue(go1.checks_configured())
        self.assertEqual(php1.checks[1], "docker run --rm -v {worktree}:/app x analyse {files}")
        self.assertFalse(todo.checks_configured())    # placeholder ≠ configured
        self.assertEqual(none.checks, [])
        self.assertFalse(none.checks_configured())
        self.assertEqual(go1.as_dict()["checks"], go1.checks)
        bad = C.Config({"checks_wall_sec": "abc"})
        self.assertEqual(bad.checks_wall_sec, 600)


class ConfigPathTest(unittest.TestCase):
    def test_local_copy_wins_then_template_then_env(self):
        with TempDir() as tmp:
            root = os.path.join(tmp, "ws")
            d = os.path.join(root, "suites", "sre-autofix")
            write(os.path.join(d, "config.yaml"), "version: 1\n")
            env_backup = os.environ.pop("SRE_AUTOFIX_CONFIG", None)
            try:
                self.assertEqual(C.config_path(root), os.path.join(d, "config.yaml"))
                self.assertIn("template", C.config_source(root)[1])
                write(os.path.join(d, "config.local.yaml"), "version: 1\n")
                self.assertEqual(C.config_path(root), os.path.join(d, "config.local.yaml"))
                self.assertIn("operator copy", C.config_source(root)[1])
                os.environ["SRE_AUTOFIX_CONFIG"] = "/elsewhere.yaml"
                self.assertEqual(C.config_path(root), "/elsewhere.yaml")
            finally:
                os.environ.pop("SRE_AUTOFIX_CONFIG", None)
                if env_backup is not None:
                    os.environ["SRE_AUTOFIX_CONFIG"] = env_backup


class WorkspaceReposTest(unittest.TestCase):
    def test_usable_repos_filters(self):
        with TempDir() as tmp:
            root, clone, _ = make_fake_workspace(tmp)
            write(os.path.join(root, "suites", "sre-autofix", "config.yaml"),
                  "repos:\n  - id: %s\n    scope: [app/]\n  - id: \"TODO(owner): <id>\"\n    scope: [app/]\n"
                  "  - id: not-registered\n    scope: [app/]\n" % REPO_ID)
            cfg = C.load(root)
            ws = C.load_workspace_repos(root)
            self.assertEqual(list(ws), [REPO_ID])
            usable, notes = C.usable_repos(cfg, ws)
            self.assertEqual([r.id for r, _ in usable], [REPO_ID])
            self.assertEqual(len(notes), 2)
            self.assertTrue(any("TODO" in n for n in notes))
            self.assertTrue(any("not-registered" in n for n in notes))

    def test_unmounted_repo_is_a_note_not_a_crash(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp, with_repo=False)
            cfg = C.load(root)
            usable, notes = C.usable_repos(cfg, C.load_workspace_repos(root))
            self.assertEqual(usable, [])
            self.assertTrue(any("未挂载" in n for n in notes))


if __name__ == "__main__":
    unittest.main()
