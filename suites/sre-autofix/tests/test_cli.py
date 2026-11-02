import json
import os
import subprocess
import unittest

from helpers import FIXTURES, HERE, INCIDENT, REPO_ID, SUITE, TempDir, apply_shipped_diff, assemble_archive, \
    make_fake_workspace, read, run_cli, shipped_config, write, write_outputs
from lib.state import RunDir


class DoctorTest(unittest.TestCase):
    def test_doctor_ready_on_fake_workspace(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            code, out, err = run_cli(root, "doctor")
            self.assertEqual(code, 0, err + out)
            for w in ("python3 >= 3.8", "config.yaml repos (no TODO", "demo-repo →", "git identity", "gh auth status",
                      "agent CLI on PATH", "interactive mode", "doctor: ready"):
                self.assertIn(w, out, w)
            self.assertNotIn("[MISS]", out)
            self.assertIn("config file in effect", out)
            # no repos[].checks in the fake config → a GATE warning, never a MISS — with a paste-ready
            # suggestion derived from the seed repo (composer.json, PHP 7.2 in lint.yml → php -l, flagged weak)
            self.assertIn("[WARN] GATE", out)
            self.assertIn("repos[%s].checks" % REPO_ID, out)
            self.assertIn('↳ suggested (PHP, from composer.json): checks: ["php -l {files}"]', out)
            self.assertIn("SYNTAX ONLY", out)
            self.assertIn("phpstan-new-errors.sh", out)

    def test_doctor_reports_check_binaries(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            cfg = os.path.join(root, "suites", "sre-autofix", "config.yaml")
            write(cfg, read(cfg).replace("    github:", "    checks: [\"sh -c true\", \"no-such-binary-xyz {files}\"]\n    github:"))
            code, out, err = run_cli(root, "doctor")
            self.assertEqual(code, 0, err + out)
            self.assertIn("[WARN] GATE", out)
            self.assertIn("NOT on PATH: no-such-binary-xyz", out)
            write(cfg, read(cfg).replace("no-such-binary-xyz {files}", "sh -c false"))
            code, out, _ = run_cli(root, "doctor")
            self.assertIn("[OK  ] GATE", out)

    def test_doctor_fails_on_shipped_todo_config(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            write(os.path.join(root, "suites", "sre-autofix", "config.yaml"), shipped_config())
            code, out, err = run_cli(root, "doctor")
            self.assertEqual(code, 1)
            self.assertIn("[MISS]", out)
            self.assertIn("TODO", out)


class ClaimTest(unittest.TestCase):
    def test_claim_passes_and_records(self):
        with TempDir() as tmp:
            root, clone, _ = make_fake_workspace(tmp)
            d = assemble_archive(tmp)
            code, out, err = run_cli(root, "claim", d)
            self.assertEqual(code, 0, err + out)
            self.assertIn("| 修复目标可定位 | ✅ |", out)
            rd = RunDir(root, INCIDENT)
            self.assertEqual(rd.phase(), "claimed")
            el = rd.read("eligibility")
            self.assertEqual(el["repo"], REPO_ID)
            self.assertEqual(el["files"], ["app/service/ExampleSrv.php"])
            self.assertEqual(el["base_ref"], "refs/remotes/origin/main")
            self.assertTrue(os.path.exists(rd.path("issue_md")))
            self.assertEqual(rd.read("input")["kind"], "archive")

    def test_claim_parks_dependency_failure(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            d = assemble_archive(tmp, "draft-dependency.json")
            code, out, err = run_cli(root, "claim", d)
            self.assertEqual(code, 3, err)
            self.assertIn("parked", err)
            rd = RunDir(root, INCIDENT)
            self.assertEqual(rd.phase(), "parked")
            self.assertFalse(os.path.exists(rd.worktree))

    def test_claim_dry_run_writes_nothing(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            code, out, _ = run_cli(root, "claim", assemble_archive(tmp), "--dry-run")
            self.assertEqual(code, 0)
            self.assertFalse(os.path.exists(os.path.join(root, "runs")))

    def test_claim_report_json(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            code, out, err = run_cli(root, "claim", os.path.join(FIXTURES, "report-v11.json"))
            self.assertEqual(code, 0, err)
            self.assertEqual(RunDir(root, INCIDENT).read("input")["kind"], "report")

    def test_claim_refuses_egress_blocked(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            with open(os.path.join(FIXTURES, "report-v11.json"), encoding="utf-8") as f:
                rep = json.load(f)
            rep["scrub"]["egress_blocked"] = True
            p = os.path.join(tmp, "r.json")
            write(p, json.dumps(rep))
            code, _, err = run_cli(root, "claim", p)
            self.assertEqual(code, 2)
            self.assertIn("egress_blocked", err)

    def test_claim_with_all_todo_config_parks_with_hint(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            write(os.path.join(root, "suites", "sre-autofix", "config.yaml"), shipped_config())
            code, out, err = run_cli(root, "claim", assemble_archive(tmp))
            self.assertEqual(code, 3)
            self.assertIn("TODO(owner)", out + err)


class LoopTest(unittest.TestCase):
    def test_plan_dry_run_creates_nothing(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            run_cli(root, "claim", assemble_archive(tmp))
            code, out, err = run_cli(root, "plan", INCIDENT, "--dry-run")
            self.assertEqual(code, 0, err)
            self.assertIn("# INCIDENT " + INCIDENT, out)
            self.assertIn("PHP 7.2（依据 .github/workflows/lint.yml", out)
            self.assertFalse(os.path.exists(RunDir(root, INCIDENT).worktree))

    def test_plan_refuses_todo_scope(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp, scope='"TODO(owner): app/"')
            run_cli(root, "claim", assemble_archive(tmp))
            code, _, err = run_cli(root, "plan", INCIDENT)
            self.assertEqual(code, 1)
            self.assertIn("TODO(owner)", err)

    def test_full_local_loop_to_dry_ship(self):
        with TempDir() as tmp:
            root, clone, origin = make_fake_workspace(tmp)
            self.assertEqual(run_cli(root, "claim", assemble_archive(tmp))[0], 0)
            code, out, err = run_cli(root, "plan", INCIDENT)
            self.assertEqual(code, 0, err)
            rd = RunDir(root, INCIDENT)
            self.assertTrue(os.path.isfile(os.path.join(rd.worktree, "INCIDENT.md")))
            self.assertEqual(rd.phase(), "planned")
            ws = rd.read("workspace")
            self.assertEqual(ws["branch"], "autofix/" + INCIDENT)
            # interactive fix hand-off only records
            code, out, _ = run_cli(root, "fix", INCIDENT)
            self.assertEqual(code, 0)
            self.assertIn("incident-fix", out)
            # gate before any edit → patch_empty
            code, out, err = run_cli(root, "gate", INCIDENT)
            self.assertEqual(code, 4)
            self.assertIn("patch_empty", err)
            # the (simulated) agent edits and writes its outputs
            apply_shipped_diff(rd.worktree)
            write_outputs(rd.worktree)
            code, out, err = run_cli(root, "gate", INCIDENT)
            self.assertEqual(code, 0, err + out)
            self.assertEqual(rd.phase(), "gate_passed")
            self.assertTrue(os.path.exists(rd.path("patch")))
            self.assertEqual(rd.read("gate")["files"], ["app/service/ExampleSrv.php"])
            # dry ship: renders body, prints the exact commands, pushes nothing
            code, out, err = run_cli(root, "ship", INCIDENT, "--dry-run", "--issue", "42")
            self.assertEqual(code, 0, err + out)
            self.assertIn("would run: git -C", out)
            self.assertIn("gh pr create --repo example-org/demo-repo --base main --head autofix/", out)
            body = read(rd.path("pr_body"))
            self.assertIn("Refs #42", body)
            self.assertIn("## 10 分钟评审路径", body)
            self.assertTrue(read(rd.path("pr_title")).startswith("fix(service): "))
            remote = subprocess.run(["git", "ls-remote", origin, "refs/heads/autofix/" + INCIDENT], capture_output=True, text=True).stdout
            self.assertEqual(remote.strip(), "")
            self.assertEqual(rd.phase(), "gate_passed")  # dry-run commits nothing
            # a real (non-dry) ship stops at the harness with no tty: commit happens, push does not
            code, out, err = run_cli(root, "ship", INCIDENT)
            self.assertEqual(code, 5, err + out)
            self.assertIn("harness", err)
            self.assertEqual(rd.phase(), "committed")
            log = read(os.path.join(root, "runs", "harness-log.jsonl"))
            self.assertIn('"decision":"blocked"', log)
            self.assertIn('"channel":"no-tty"', log)
            self.assertEqual(subprocess.run(["git", "ls-remote", origin, "refs/heads/autofix/" + INCIDENT],
                                            capture_output=True, text=True).stdout.strip(), "")
            # re-running ship resumes on the existing commit, still blocked, no second commit
            code, _, _ = run_cli(root, "ship", INCIDENT)
            self.assertEqual(code, 5)
            n = subprocess.run(["git", "rev-list", "--count", ws["base_sha"] + "..HEAD"], cwd=rd.worktree,
                               capture_output=True, text=True).stdout.strip()
            self.assertEqual(n, "1")
            # release cleans the worktree and the branch
            code, _, err = run_cli(root, "release", INCIDENT)
            self.assertEqual(code, 0, err)
            self.assertFalse(os.path.isdir(rd.worktree))
            self.assertEqual(rd.phase(), "released")

    def test_headless_fix_with_fake_agent_then_retry_path(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            cfg = read(os.path.join(root, "suites", "sre-autofix", "config.yaml"))
            cfg = cfg.replace("command: []", "command: [sh, %s, %s]" % (os.path.join(HERE, "fake-agent.sh"), FIXTURES))
            write(os.path.join(root, "suites", "sre-autofix", "config.yaml"), cfg)
            run_cli(root, "claim", assemble_archive(tmp))
            run_cli(root, "plan", INCIDENT)
            code, out, err = run_cli(root, "fix", INCIDENT, "--headless")
            self.assertEqual(code, 0, err + out)
            rd = RunDir(root, INCIDENT)
            self.assertEqual(rd.phase(), "gate_passed")
            att = rd.attempts()
            self.assertEqual(len(att), 1)
            self.assertTrue(att[0]["gate_passed"])
            self.assertEqual(att[0]["agent_cost_usd"], 0.0123)
            # a failing agent with retries=1 → two attempts, both classified, phase gate_failed, worktree kept
            cfg2 = cfg.replace("command: [sh, %s, %s]" % (os.path.join(HERE, "fake-agent.sh"), FIXTURES),
                               "command: [sh, %s, %s, fail]" % (os.path.join(HERE, "fake-agent.sh"), FIXTURES))
            write(os.path.join(root, "suites", "sre-autofix", "config.yaml"), cfg2)
            code, _, err = run_cli(root, "fix", INCIDENT, "--retry")   # --retry needs a recorded failure
            self.assertEqual(code, 2, err)
            code, out, err = run_cli(root, "fix", INCIDENT, "--headless")
            self.assertEqual(code, 4, err + out)
            att = rd.attempts()
            self.assertEqual([a.get("fail_class") for a in att[1:]], ["agent_error", "agent_error"])
            self.assertIn("上一轮为什么失败", read(rd.path("brief")))
            self.assertTrue(os.path.isdir(rd.worktree))

    def test_missing_agent_headless(self):
        with TempDir() as tmp:
            root, _, _ = make_fake_workspace(tmp)
            run_cli(root, "claim", assemble_archive(tmp))
            run_cli(root, "plan", INCIDENT)
            import shutil
            binx = os.path.join(tmp, "bin")
            os.makedirs(binx)
            for tool in ("git", "sh"):
                os.symlink(shutil.which(tool), os.path.join(binx, tool))
            code, _, err = run_cli(root, "fix", INCIDENT, "--headless", "--agent", "codex", env={"PATH": binx})
            self.assertEqual(code, 1, err)
            self.assertIn("agent_missing", err)


if __name__ == "__main__":
    unittest.main()


class RepoChecksGateTest(unittest.TestCase):
    """End to end: repos[].checks run in the worktree; {files} expands to the changed files; a failing
    command parks the gate with repo_check_failed and a log; a passing set is reported per command."""

    def _setup(self, checks):
        tmp = TempDir()
        t = tmp.__enter__()
        root, clone, _ = make_fake_workspace(t)
        cfg = os.path.join(root, "suites", "sre-autofix", "config.yaml")
        write(cfg, read(cfg).replace("    github:", "    checks: [%s]\n    github:" % checks).replace(
            "version: 1\n", "version: 1\nchecks_wall_sec: 20\n"))
        arch = assemble_archive(t)
        code, _, err = run_cli(root, "claim", arch)
        assert code == 0, err
        code, _, err = run_cli(root, "plan", INCIDENT)
        assert code == 0, err
        rd = RunDir(root, INCIDENT)
        return tmp, root, rd

    def test_brief_names_the_commands(self):
        tmp, root, rd = self._setup("\"sh -c true\"")
        try:
            self.assertIn("验证门将在本工作目录里执行的仓库自检命令：`sh -c true`", read(rd.path("brief")))
        finally:
            tmp.__exit__(None, None, None)

    def test_failing_command_parks_gate_with_log(self):
        tmp, root, rd = self._setup("\"echo checking {files}\", \"sh -c 'echo boom >&2; exit 3'\"")
        try:
            apply_shipped_diff(rd.worktree)
            write_outputs(rd.worktree)
            code, out, err = run_cli(root, "gate", INCIDENT)
            self.assertEqual(code, 4, err + out)
            self.assertIn("repo_check_failed", err)
            self.assertIn("退出 3：boom", out + err)
            log = read(rd.path("repo_checks"))
            self.assertIn("checking app/service/ExampleSrv.php", log)   # {files} expanded
            self.assertIn("exit 3", log)
            self.assertEqual(rd.read("gate")["checks"][4]["passed"], False)
        finally:
            tmp.__exit__(None, None, None)

    def test_passing_commands_report_each(self):
        tmp, root, rd = self._setup("\"test -f {worktree}/INCIDENT.md\", \"echo ok {files}\", \"test -f {root}/workspace.yaml\"")
        try:
            apply_shipped_diff(rd.worktree)
            write_outputs(rd.worktree)
            code, out, err = run_cli(root, "gate", INCIDENT)
            self.assertEqual(code, 0, err + out)
            row = rd.read("gate")["checks"][4]
            self.assertTrue(row["passed"])
            self.assertIn("3 条命令全部退出 0", row["detail"])   # incl. {root} resolving to the workspace
            self.assertIn("`test -f {worktree}/INCIDENT.md`", row["detail"])
        finally:
            tmp.__exit__(None, None, None)

