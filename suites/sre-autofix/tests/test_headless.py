import json
import os
import unittest

from helpers import FIXTURES, HERE, INCIDENT, TempDir, make_temp_repo
from lib import headless as H
from lib.gate import FAIL_AGENT_ERROR, FAIL_AGENT_MISSING, FAIL_TIMEOUT
from lib.state import RunDir
from lib.workspace import Worktree

FAKE = os.path.join(HERE, "fake-agent.sh")


class ArgvTest(unittest.TestCase):
    def test_claude_argv_shape(self):
        a = H.build_claude_argv("p", model="", max_budget_usd=5)
        self.assertEqual(a[:3], ["claude", "-p", "p"])
        self.assertIn("stream-json", a)
        self.assertIn("acceptEdits", a)
        self.assertNotIn("bypassPermissions", " ".join(a))
        self.assertNotIn("--dangerously-skip-permissions", a)
        self.assertIn("Bash(git commit*)", a[a.index("--disallowedTools"):])
        self.assertIn("Bash(git push*)", a)
        self.assertIn("--max-budget-usd", a)
        self.assertNotIn("--model", a)
        self.assertIn("--model", H.build_claude_argv("p", model="opus"))

    def test_codex_argv_shape(self):
        a = H.build_codex_argv("p", "/wt", "/r.md", "m")
        self.assertEqual(a[:2], ["codex", "exec"])
        self.assertIn("workspace-write", a)
        self.assertEqual(a[-1], "p")

    def test_opencode_argv_shape(self):
        a = H.build_opencode_argv("p", model="x/y")
        self.assertEqual(a, ["opencode", "run", "-m", "x/y", "p"])
        self.assertEqual(H.build_argv("opencode", "p", "/wt", "/r", {}), ["opencode", "run", "p"])
        self.assertEqual(H.KNOWN_AGENTS, ("claude", "codex", "opencode"))
        self.assertEqual(H.detect_agent("nonexistent-cli"), "")

    def test_custom_command_placeholders(self):
        a = H.build_argv("custom", "P", "/wt", "/r", {"command": ["x", "{prompt}", "{worktree}", "{response}"]})
        self.assertEqual(a, ["x", "P", "/wt", "/r"])


def prepare(tmp):
    clone, _ = make_temp_repo(tmp)
    rd = RunDir(tmp, INCIDENT)
    rd.ensure()
    wt = Worktree(clone, rd.worktree, "autofix/" + INCIDENT, rd.path("git_exclude"))
    wt.resolve_base_ref()
    wt.prepare()
    return rd, wt


class RunAgentTest(unittest.TestCase):
    def test_fake_agent_produces_outputs_and_events(self):
        with TempDir() as tmp:
            rd, wt = prepare(tmp)
            att = H.run_agent(wt.dir, rd, {"command": ["sh", FAKE, FIXTURES]}, wall_sec=30)
            self.assertEqual(att["agent_status"], "completed", att)
            self.assertEqual(att["agent_cost_usd"], 0.0123)
            self.assertEqual(att["agent_turns"], 3)
            self.assertNotIn("fail_class", att)
            self.assertTrue(os.path.exists(rd.path("agent_events")))
            self.assertTrue(os.path.exists(rd.path("agent_prompt")))
            self.assertIn("Fix applied", open(rd.path("agent_response"), encoding="utf-8").read())
            self.assertTrue(os.path.exists(os.path.join(wt.dir, "FIXNOTES.md")))
            self.assertNotEqual(wt.diff(), "")
            last = rd.read("last_run")
            self.assertEqual(last["agent"], "custom")
            self.assertEqual(json.loads(open(rd.path("agent_events"), encoding="utf-8").read().splitlines()[-1])["type"], "result")

    def test_timeout(self):
        with TempDir() as tmp:
            rd, wt = prepare(tmp)
            att = H.run_agent(wt.dir, rd, {"command": ["sh", FAKE, FIXTURES, "sleep"]}, wall_sec=1)
            self.assertEqual(att["fail_class"], FAIL_TIMEOUT)

    def test_agent_error(self):
        with TempDir() as tmp:
            rd, wt = prepare(tmp)
            att = H.run_agent(wt.dir, rd, {"command": ["sh", FAKE, FIXTURES, "fail"]}, wall_sec=10)
            self.assertEqual(att["fail_class"], FAIL_AGENT_ERROR)
            self.assertIn("boom", att["reason"])

    def test_missing_agent(self):
        with TempDir() as tmp:
            rd, wt = prepare(tmp)
            att2 = H.run_agent(wt.dir, rd, {"agent": "nonexistent-cli"}, wall_sec=1)
            self.assertEqual(att2["fail_class"], FAIL_AGENT_MISSING)
            self.assertIn("交互模式", att2["reason"])


if __name__ == "__main__":
    unittest.main()
