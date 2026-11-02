"""Behavior checks for map setup, registered mount freshness, and hook output."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from importlib.machinery import SourceFileLoader
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.mounts import registered_repos


def load(name):
    loader = SourceFileLoader(name.replace("-", "_"), str(ROOT / "scripts" / name))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return module


class MapChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.enterContext(patch.object(pathlib.Path, "home", return_value=self.root))

    def sidecar(self, text):
        (self.root / "workspace.local.yaml").write_text(text)

    def test_registered_paths_and_invalid_id(self):
        self.sidecar('repositories:\n  - id: alpha # note\n    path: "custom checkout"\n'
                     '  - id: ../bad\n    path: wrong\n  - id: beta\n'
                     'settings:\n  path: ignored\n')
        self.assertEqual(registered_repos(self.root), {
            "alpha": self.root / "custom checkout", "beta": self.root / "repos/beta"})

    def test_registration_failure_reaches_main_and_log(self):
        setup = load("setup-map-tool")
        failure = subprocess.CompletedProcess([], 9, "private client diagnostic", "")
        output = io.StringIO()
        with patch.object(setup, "installed_version", return_value=("/fake/cbm", "cbm " + setup.PINNED_VERSION.lstrip("v"))), \
                patch.object(setup.subprocess, "run", return_value=failure), \
                patch.object(setup, "run_log") as log, \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(setup.main([]), 1)
            log.assert_called_once_with("", 1)
        self.assertNotIn("private client diagnostic", output.getvalue())

    def test_registration_skip_does_not_run_client_install(self):
        setup = load("setup-map-tool")
        with patch.object(setup, "installed_version", return_value=("/fake/cbm", "cbm " + setup.PINNED_VERSION.lstrip("v"))), \
                patch.object(setup, "register_clients") as register, \
                patch.object(setup, "run_log"), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(setup.main(["--skip-register"]), 0)
            register.assert_not_called()

    def test_registration_timeout_is_failure(self):
        setup = load("setup-map-tool")
        with patch.object(setup.subprocess, "run", side_effect=subprocess.TimeoutExpired([], 60)), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(setup.register_clients("/fake/cbm"))

    def test_registration_strips_blocks_once_and_preserves_other_bytes(self):
        setup = load("setup-map-tool")
        for name in (".claude", ".codex", ".config/zed"):
            (self.root / name).mkdir(parents=True)
        instructions = self.root / ".claude/CLAUDE.md"
        alias = self.root / ".codex/AGENTS.md"
        alias.symlink_to("../.claude/CLAUDE.md")
        unchanged = self.root / ".config/zed/AGENTS.md"
        prefix = b"# User rules\r\nKeep these bytes: \xff\n"
        suffix = b"\r\n# Other rules\r\nKeep trailing spaces.  \r\nNo final newline"
        instructions.write_bytes(prefix + b"\r\n \t\r\n<!-- codebase-memory-mcp:start -->\r\n"
                                 b"managed instructions\r\n<!-- codebase-memory-mcp:end -->\r\n" + suffix)
        untouched = b"Inline <!-- codebase-memory-mcp:start --> stays.\r\n\xff\n\n"
        unchanged.write_bytes(untouched)
        before = unchanged.stat()
        output = io.StringIO()
        read_bytes = pathlib.Path.read_bytes
        with patch.object(setup.pathlib.Path, "home", return_value=self.root), \
                patch.object(setup, "installed_version", return_value=("/fake/cbm", "cbm " + setup.PINNED_VERSION.lstrip("v"))), \
                patch.object(setup.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)), \
                patch.object(setup.pathlib.Path, "read_bytes", autospec=True, side_effect=read_bytes) as read, \
                patch.object(setup, "run_log"), contextlib.redirect_stdout(output):
            self.assertEqual(setup.main([]), 0)
        self.assertEqual([call.args[0] for call in read.call_args_list], [instructions.resolve(), unchanged.resolve()])
        self.assertTrue(alias.is_symlink())
        self.assertEqual(instructions.read_bytes(), prefix + suffix)
        self.assertEqual(unchanged.read_bytes(), untouched)
        self.assertEqual(unchanged.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(output.getvalue().count("removed managed instruction block from"), 1)

    def test_instruction_cleanup_removes_clean_blocks_and_preserves_crlf(self):
        setup = load("setup-map-tool")
        path = self.root / "AGENTS.md"
        block = b"<!-- codebase-memory-mcp:start -->\nmanaged\n<!-- codebase-memory-mcp:end -->"
        cases = ((b"\n\n" + block, b""),
                 (block + b"\n\n" + block + b"\n", b""),
                 (b"keep\r\n\r\n \t\r\n" + block.replace(b"\n", b"\r\n") + b"\r\nafter\r\n",
                  b"keep\r\nafter\r\n"))
        with patch.object(setup.pathlib.Path, "home", return_value=self.root), \
                patch.object(setup, "INSTRUCTION_FILES", ("AGENTS.md",)), \
                contextlib.redirect_stdout(io.StringIO()):
            for original, expected in cases:
                with self.subTest(original=original):
                    path.write_bytes(original)
                    setup.strip_client_instructions()
                    self.assertTrue(path.exists())
                    self.assertEqual(path.read_bytes(), expected)

    def test_instruction_cleanup_malformed_markers_leave_file_unchanged_and_warn(self):
        setup = load("setup-map-tool")
        path = self.root / "AGENTS.md"
        start = b"<!-- codebase-memory-mcp:start -->\n"
        end = b"<!-- codebase-memory-mcp:end -->\n"
        block = start + b"managed\n" + end
        cases = (start + b"user text\n" + block,
                 start + block + end,
                 end + b"user text\n" + start,
                 start + b"incomplete\n",
                 end,
                 block + start,
                 block + end,
                 start + b"keep\n" + end.rstrip(b"\n") + b" extra\n")
        for original in cases:
            with self.subTest(original=original):
                path.write_bytes(original)
                before = path.stat()
                warning = io.StringIO()
                with patch.object(setup.pathlib.Path, "home", return_value=self.root), \
                        patch.object(setup, "INSTRUCTION_FILES", ("AGENTS.md",)), \
                        contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(warning):
                    setup.strip_client_instructions()
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
                self.assertIn("WARNING:", warning.getvalue())
                self.assertIn(str(path), warning.getvalue())

    def test_instruction_cleanup_failure_warns_and_registration_succeeds(self):
        setup = load("setup-map-tool")
        (self.root / ".claude/CLAUDE.md").mkdir(parents=True)
        instructions = self.root / ".codex/AGENTS.md"
        instructions.parent.mkdir()
        instructions.write_bytes(b"<!-- codebase-memory-mcp:start -->\nmanaged\n<!-- codebase-memory-mcp:end -->\n")
        output = io.StringIO()
        with patch.object(setup.pathlib.Path, "home", return_value=self.root), \
                patch.object(setup, "installed_version", return_value=("/fake/cbm", "cbm " + setup.PINNED_VERSION.lstrip("v"))), \
                patch.object(setup.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)), \
                patch.object(setup, "run_log") as log, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(output):
            self.assertEqual(setup.main([]), 0)
            log.assert_called_once_with("", 0)
        self.assertIn("WARNING: could not strip", output.getvalue())
        self.assertEqual(instructions.read_bytes(), b"")

    def test_fresh_install_strips_instructions_unless_registration_is_skipped(self):
        setup = load("setup-map-tool")
        archive = io.BytesIO()
        with setup.tarfile.open(fileobj=archive, mode="w:gz") as tar:
            member = setup.tarfile.TarInfo(setup.BINARY)
            member.size = 4
            tar.addfile(member, io.BytesIO(b"fake"))
        data = archive.getvalue()
        checksum = setup.hashlib.sha256(data).hexdigest()
        instructions = self.root / ".claude/CLAUDE.md"
        instructions.parent.mkdir()
        block = b"<!-- codebase-memory-mcp:start -->\nmanaged\n<!-- codebase-memory-mcp:end -->\n"
        for skip in (False, True):
            with self.subTest(skip_register=skip):
                instructions.write_bytes(block)
                argv = ["--dir", str(self.root / "bin")] + (["--skip-register"] if skip else [])
                with patch.object(setup.pathlib.Path, "home", return_value=self.root), \
                        patch.object(setup, "installed_version", return_value=(None, "")), \
                        patch.object(setup.platform, "system", return_value="Darwin"), \
                        patch.object(setup.platform, "machine", return_value="arm64"), \
                        patch.object(setup, "_fetch", side_effect=[
                            f"{checksum}  {setup.BINARY}-darwin-arm64.tar.gz\n".encode(), data]), \
                        patch.object(setup.subprocess, "run", side_effect=[
                            subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, "cbm 0.12.1")]), \
                        patch.object(setup.shutil, "which", return_value=None), \
                        patch.object(setup, "run_log"), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(setup.main(argv), 0)
                self.assertEqual(instructions.read_bytes(), block if skip else b"")

    def test_registration_failure_does_not_skip_indexing(self):
        repos = load("setup-repos")
        results = [subprocess.CompletedProcess([], 1), subprocess.CompletedProcess([], 0)]
        with patch.object(repos.subprocess, "run", side_effect=results) as run, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            repos.index_code_map(["alpha"])
        self.assertEqual(run.call_count, 2)
        self.assertIn("generate-map", run.call_args_list[1].args[0][1])

    def test_project_binding_is_reported_without_native_access_claim(self):
        check = load("check-map")
        (self.root / ".mcp.json").write_text(json.dumps({"mcpServers": {"codebase-memory-mcp": {}}}))
        home = self.root / "home"
        home.mkdir()
        with patch.object(check, "root", self.root), patch.object(check.pathlib.Path, "home", return_value=home), \
                patch.object(check.shutil, "which", return_value=None):
            notes = check.readiness_notes()
        self.assertIn("binary: missing", notes[0])
        self.assertIn("Claude Code: entry present, runtime unverified", notes)
        self.assertTrue(any("native access, subagent access, and query success: unverified" in n for n in notes))

    def test_other_workspace_binding_does_not_count(self):
        check = load("check-map")
        (self.root / ".claude.json").write_text(json.dumps({
            "projects": {"/another/workspace": {"mcpServers": {"codebase-memory-mcp": {}}}}}))
        with patch.object(check, "root", self.root), patch.object(check.pathlib.Path, "home", return_value=self.root):
            self.assertIn("Claude Code: entry not found", check.readiness_notes())

    def test_generate_all_skips_maps_built_from_head(self):
        generate = load("generate-map")
        maps = self.root / "maps"
        for rid, head in (("fresh", "aaa"), ("stale", "old")):
            (maps / rid).mkdir(parents=True)
            (maps / rid / "architecture.md").write_text("x")
            (maps / rid / "provenance.json").write_text(json.dumps({"last": {"map-generated": {"repo_head": head}}}))
        pin = re.search(r'^PINNED_VERSION = "v?([^"]+)"', (ROOT / "scripts/setup-map-tool").read_text(), re.M).group(1)
        def run(*args):
            built = []
            with patch.object(generate, "code_map_dir", lambda rid: maps / rid), \
                 patch.object(generate, "read_local_repo_paths", lambda: {"fresh": "r/fresh", "stale": "r/stale"}), \
                 patch.object(generate, "repo_head", lambda checkout: "aaa"), \
                 patch.object(generate, "find_binary", lambda: "cbm"), \
                 patch.object(generate, "run_log"), \
                 patch.object(generate.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, f"cbm {pin}")), \
                 patch.object(generate, "generate_one", lambda b, rid, *a: built.append(rid) or True), \
                 contextlib.redirect_stdout(io.StringIO()):
                generate.main(["--all", *args])
            return built
        self.assertEqual(run(), ["stale"])
        self.assertEqual(run("--force"), ["fresh", "stale"])
        self.assertEqual(run("--index-only"), ["fresh", "stale"])

    def test_stuck_daemon_is_restarted_once_then_retried(self):
        generate = load("generate-map")
        (self.root / "repo/.git").mkdir(parents=True)
        calls = []
        def cli(binary, tool, args):
            calls.append(tool)
            if len(calls) == 1:
                raise RuntimeError("CBM CLI could not start because an active pre-coordination or unverified CBM daemon is running")
            return {}
        with patch.object(generate, "root", self.root), \
             patch.object(generate, "cbmignore_status", lambda rid: (None, "missing")), \
             patch.object(generate, "rel_map", lambda rid, name: name), \
             patch.object(generate, "cli", cli), \
             patch.object(generate, "recover_daemon", lambda b: generate._recovered.append(1) or ["1"]) as rec, \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            ok = generate.generate_one("cbm", "alpha", "repo", "full", auto_cbmignore=False, index_only=True)
        self.assertTrue(ok)
        self.assertEqual(calls, ["index_repository", "index_repository"])
        self.assertEqual(generate._recovered, [1])
        # A second stuck error in the same run is not recovered again.
        calls.clear()
        with patch.object(generate, "root", self.root), \
             patch.object(generate, "cbmignore_status", lambda rid: (None, "missing")), \
             patch.object(generate, "rel_map", lambda rid, name: name), \
             patch.object(generate, "cli", lambda *a: (_ for _ in ()).throw(RuntimeError("unverified CBM daemon"))), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(generate.generate_one("cbm", "alpha", "repo", "full", auto_cbmignore=False, index_only=True))

    def test_hook_uses_registered_path_and_preserves_access_limits(self):
        hook = load("code-map-hook")
        (self.root / "custom/.git").mkdir(parents=True)
        self.sidecar("repositories:\n  - id: alpha\n    path: custom\n")
        for event in ["SessionStart", "SubagentStart"]:
            output = io.StringIO()
            with patch.object(hook, "root", self.root), \
                    patch.object(hook, "refresh") as refresh, \
                    patch.object(hook.sys, "stdin", io.StringIO(json.dumps({"hook_event_name": event}))), \
                    contextlib.redirect_stdout(output):
                hook.main()
            self.assertEqual(refresh.called, event == "SessionStart")
            data = json.loads(output.getvalue())["hookSpecificOutput"]
            self.assertEqual(data["hookEventName"], event)
            self.assertIn("repo id: alpha", data["additionalContext"])
            self.assertIn("do not prove an index exists", data["additionalContext"])
            if event == "SubagentStart":
                self.assertIn("state the access limit", data["additionalContext"])

    def test_hook_mount_oserror_preserves_other_repos_and_json(self):
        hook = load("code-map-hook")
        mounts = {repo_id: self.root / repo_id for repo_id in ("first", "second")}
        for checkout in mounts.values():
            (checkout / ".git").mkdir(parents=True)
        exists = pathlib.Path.exists
        def probe(path):
            if path == mounts["first"] / ".git":
                raise OSError("cannot inspect checkout")
            return exists(path)
        with patch.object(hook, "root", self.root), \
                patch("lib.mounts.registered_repos", return_value=mounts), \
                patch.object(pathlib.Path, "exists", probe), patch.object(hook, "refresh") as refresh, \
                patch.object(hook.sys, "stdin", io.StringIO('{"hook_event_name": "SessionStart"}')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            hook.main()
        refresh.assert_called_once_with()
        data = json.loads(output.getvalue())["hookSpecificOutput"]
        self.assertIn("repo id: second.", data["additionalContext"])

    def test_hook_foreground_spawns_one_detached_worker_and_preserves_json(self):
        hook = load("code-map-hook")
        mounts = {repo_id: self.root / repo_id for repo_id in ("first", "second")}
        for path in mounts.values():
            (path / ".git").mkdir(parents=True)
        for failure in (None, OSError("could not start")):
            with self.subTest(failure=failure):
                output = io.StringIO()
                with patch.object(hook, "root", self.root), \
                        patch("lib.mounts.registered_repos", return_value=mounts), \
                        patch.object(hook.subprocess, "Popen", side_effect=failure) as popen, \
                        patch.object(hook.subprocess, "run") as run, \
                        patch.object(hook, "refresh_worker") as worker, \
                        patch.object(hook.sys, "stdin", io.StringIO('{"hook_event_name": "SessionStart"}')), \
                        contextlib.redirect_stdout(output):
                    hook.main()
                popen.assert_called_once_with(
                    [sys.executable, str(ROOT / "scripts/code-map-hook"), "--refresh-worker"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, start_new_session=True)
                popen.return_value.wait.assert_not_called()
                popen.return_value.communicate.assert_not_called()
                run.assert_not_called()
                worker.assert_not_called()
                self.assertEqual(json.loads(output.getvalue()), {"hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": (
                        '[workspace code map] Ignore any "no indexed graph project matched this working directory" '
                        "message: it checks only the workspace root. Graph projects belong to individual mounted repos, and the graph "
                        "project name is the repo id: first, second. For a structural question (who calls X, where "
                        "a handler lives, what a change reaches), use the known repo id in search_graph or trace_path "
                        "before broad code searches. Mounted folders do not prove an index exists. "
                        "If a query reports a missing project, use list_projects and follow "
                        "agent-instructions/code-map.md. Worktree graphs are named '<repo-id>.wt.<folder>'.")}})

    def test_hook_version_note_only_on_pin_mismatch(self):
        hook = load("code-map-hook")
        (self.root / "scripts").mkdir()
        (self.root / "scripts/setup-map-tool").write_text('PINNED_VERSION = "v9.9.9"\n')
        for installed, expected in [("cbm 9.9.9", ""), ("cbm 1.0.0", "is 1.0.0, but the workspace pins v9.9.9")]:
            with patch.object(hook, "root", self.root), patch.object(hook.shutil, "which", return_value="/fake/cbm"), \
                    patch.object(hook.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, installed)):
                note = hook.version_note()
            if expected:
                self.assertIn(expected, note)
                self.assertIn("Updating the tool", note)
            else:
                self.assertEqual(note, "")

    def test_hook_worker_flag_does_not_read_stdin_or_spawn(self):
        hook = load("code-map-hook")
        mounts = {"alpha": self.root / "custom"}
        with patch("lib.mounts.registered_repos", return_value=mounts), \
                patch.object(hook, "refresh_worker") as worker, \
                patch.object(hook.json, "load") as read, \
                patch.object(hook.subprocess, "Popen") as popen, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            hook.main(["--refresh-worker"])
        worker.assert_called_once_with(mounts)
        read.assert_not_called()
        popen.assert_not_called()
        self.assertEqual(output.getvalue(), "")

    def test_hook_worktree_discovery_and_name_normalization(self):
        hook = load("code-map-hook")
        main = self.root / "main"
        linked = self.root / "fix @---中文._9"
        output = (f"worktree {main}\nHEAD abc\nbranch refs/heads/main\n\n"
                  f"worktree {linked}\nHEAD def\ndetached\n\n"
                  f"worktree {linked}\nlocked reason\n")
        with patch.object(hook.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output)) as run:
            self.assertEqual(hook.worktrees(main), {main.resolve(), linked.resolve()})
        run.assert_called_once_with(["git", "-C", str(main), "worktree", "list", "--porcelain"],
                                    capture_output=True, text=True, check=True, timeout=30)
        for folder, expected in ((linked.name, "fix__-__._9"), ("A.b_C-9", "A.b_C-9"),
                                 ("a--b---c", "a-b-c"), ("@!", "__"), ("bad@-", "bad_")):
            with self.subTest(folder=folder):
                checkout = pathlib.Path(folder)
                if folder != "A.b_C-9":
                    expected += "-" + hashlib.sha256(str(checkout.resolve()).encode()).hexdigest()[:8]
                self.assertEqual(hook.worktree_name("alpha", pathlib.Path(folder)), f"alpha.wt.{expected}")
        with patch.object(hook.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "")):
            with self.assertRaises(ValueError):
                hook.worktrees(main)

    def test_hook_worker_names_collisions_deterministically(self):
        hook = load("code-map-hook")
        main = self.root / "main"
        linked = {self.root / folder for folder in ("fix@one", "fix_one", "first/fix", "second/fix")}
        current = {main, *linked}
        expected = {}
        for checkout in linked:
            folder = checkout.name.replace("@", "_")
            if checkout.name != "fix_one":
                folder += "-" + hashlib.sha256(str(checkout.resolve()).encode()).hexdigest()[:8]
            expected[str(checkout)] = f"alpha.wt.{folder}"
        for ordered in (sorted(current), sorted(current, reverse=True)):
            with patch.object(hook, "root", self.root), patch.object(hook.shutil, "which", return_value="cbm"), \
                    patch.object(hook, "worktrees", return_value=ordered), \
                    patch.object(hook, "list_projects", return_value=[]), patch.object(hook, "cli") as cli:
                hook.refresh_worker({"alpha": main})
            names = {c.args[2]["repo_path"]: c.args[2]["name"] for c in cli.call_args_list
                     if c.args[2].get("name") != "alpha"}
            self.assertEqual(names, expected)
            self.assertEqual(len(set(names.values())), len(linked))
            for name in names.values():
                self.assertRegex(name, r"^[A-Za-z0-9._-]+$")
                self.assertNotIn("--", name)
        alias = self.root / "alias"
        alias.symlink_to(self.root / "fix@one")
        self.assertEqual(hook.worktree_name("alpha", alias), expected[str(self.root / "fix@one")])

    def test_hook_worktree_skips_symlink_and_nonregular_ignore(self):
        hook = load("code-map-hook")
        source = self.root / "knowledge/maps/alpha/.cbmignore"
        source.parent.mkdir(parents=True)
        source.write_text("vendor/\n")
        target = self.root / "outside"
        target.write_text("untouched\n")
        for kind in ("symlink", "dangling", "directory", "fifo"):
            checkout = self.root / kind
            checkout.mkdir()
            dest = checkout / ".cbmignore"
            if kind in ("symlink", "dangling"):
                dest.symlink_to(target if kind == "symlink" else self.root / "missing")
            elif kind == "directory":
                dest.mkdir()
            else:
                os.mkfifo(dest)
            with self.subTest(kind=kind), patch.object(hook, "root", self.root), \
                    patch.object(hook.subprocess, "run") as run, patch.object(hook, "cli") as cli, \
                    patch.object(hook, "copy_nofollow") as copy:
                hook.index_worktree("cbm", "alpha", checkout)
            run.assert_not_called()
            cli.assert_not_called()
            copy.assert_not_called()
            self.assertEqual(target.read_text(), "untouched\n")
            self.assertFalse((self.root / "missing").exists())

    def test_hook_worktree_stages_ignore_and_hides_it_once(self):
        hook = load("code-map-hook")
        checkout = self.root / "fix"
        checkout.mkdir()
        (checkout / ".git").write_text("gitdir: ../main/.git/worktrees/fix\n")
        source = self.root / "knowledge/maps/alpha/.cbmignore"
        source.parent.mkdir(parents=True)
        source.write_text("vendor/\n")
        exclude = self.root / "main/.git/info/exclude"
        exclude.parent.mkdir(parents=True)
        exclude.write_text("keep")
        def git(command, **kwargs):
            self.assertEqual(command[:3], ["git", "-C", str(checkout)])
            self.assertEqual(kwargs["timeout"], 30)
            if command[3:] == ["ls-files", "--error-unmatch", ".cbmignore"]:
                return subprocess.CompletedProcess(command, 1)
            self.assertEqual(command[3:], ["rev-parse", "--git-path", "info/exclude"])
            return subprocess.CompletedProcess(command, 0, str(exclude) + "\n")
        def index(binary, tool, args):
            self.assertEqual((checkout / ".cbmignore").read_text(), source.read_text())
            self.assertEqual(exclude.read_text(), "keep\n/.cbmignore\n")
            self.assertEqual((binary, tool, args), ("cbm", "index_repository", {
                "repo_path": str(checkout), "name": "alpha.wt.fix", "mode": "full"}))
        with patch.object(hook, "root", self.root), patch.object(hook.subprocess, "run", side_effect=git), \
                patch.object(hook, "cli", side_effect=index) as cli:
            hook.index_worktree("cbm", "alpha", checkout)
            hook.index_worktree("cbm", "alpha", checkout)
        self.assertEqual(cli.call_count, 2)
        self.assertEqual((checkout / ".cbmignore").read_text(), source.read_text())

    def test_hook_worktree_never_overwrites_tracked_ignore_even_if_index_fails(self):
        hook = load("code-map-hook")
        checkout = self.root / "fix"
        checkout.mkdir()
        dest = checkout / ".cbmignore"
        dest.write_text("original\n")
        source = self.root / "knowledge/maps/alpha/.cbmignore"
        source.parent.mkdir(parents=True)
        source.write_text("vendor/\n")
        for failure in (False, True):
            def index(*args):
                self.assertEqual(dest.read_text(), "original\n")
                if failure:
                    raise OSError("index failed")
            with self.subTest(failure=failure), patch.object(hook, "root", self.root), \
                    patch.object(hook.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)), \
                    patch.object(hook, "hide_from_git") as hide, patch.object(hook, "cli", side_effect=index), \
                    patch.object(hook, "copy_nofollow") as copy:
                if failure:
                    with self.assertRaises(OSError):
                        hook.index_worktree("cbm", "alpha", checkout)
                else:
                    hook.index_worktree("cbm", "alpha", checkout)
                hide.assert_not_called()
                copy.assert_not_called()
                self.assertEqual(dest.read_text(), "original\n")

    def test_hook_worker_skips_failed_staging_and_continues(self):
        hook = load("code-map-hook")
        main, broken, good = (self.root / name for name in ("main", "a-broken", "b-good"))
        for checkout in (main, broken, good):
            checkout.mkdir()
        source = self.root / "knowledge/maps/alpha/.cbmignore"
        source.parent.mkdir(parents=True)
        source.write_text("vendor/\n")
        # A missing main-checkout copy must not prevent worktree staging.
        copyfile = hook.copy_nofollow
        for failure in ("copy", "exclude", "git"):
            def copy(src, dest):
                if dest.parent == broken and failure == "copy":
                    raise PermissionError("cannot stage")
                return copyfile(src, dest)
            def hide(checkout):
                if checkout == broken and failure == "exclude":
                    raise OSError("cannot hide")
            def git(command, **kwargs):
                if command[2] == str(broken) and failure == "git":
                    raise OSError("git unavailable")
                return subprocess.CompletedProcess(command, 1)
            with self.subTest(failure=failure), patch.object(hook, "root", self.root), \
                    patch.object(hook.shutil, "which", return_value="cbm"), \
                    patch.object(hook, "copy_nofollow", side_effect=copy), \
                    patch.object(hook, "hide_from_git", side_effect=hide), \
                    patch.object(hook.subprocess, "run", side_effect=git), \
                    patch.object(hook, "worktrees", return_value={main, broken, good}), \
                    patch.object(hook, "list_projects", return_value=[]), patch.object(hook, "cli") as cli:
                hook.refresh_worker({"alpha": main})
            cli.assert_called_once_with("cbm", "index_repository", {
                "repo_path": str(good), "name": "alpha.wt.b-good", "mode": "full"})
        (main / ".cbmignore").write_text("vendor/\n")
        with patch.object(hook, "root", self.root), patch.object(hook.shutil, "which", return_value="cbm"), \
                patch.object(hook, "worktrees", return_value={main}), \
                patch.object(hook, "list_projects", return_value=[]), patch.object(hook, "cli") as cli:
            hook.refresh_worker({"alpha": main})
        cli.assert_called_once_with("cbm", "index_repository", {
            "repo_path": str(main), "name": "alpha", "mode": "full"})

    def test_hook_worker_indexes_sequentially_and_cleans_only_stale_roots(self):
        hook = load("code-map-hook")
        main, linked, other = (self.root / name for name in ("main", "fix", "other"))
        for checkout in (main, linked, other):
            checkout.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(linked)
        projects = [
            {"name": "alpha", "root_path": str(self.root / "gone")},
            {"name": "alpha.wt.old", "root_path": str(self.root / "gone")},
            {"name": "alpha.wt.renamed", "root_path": str(alias)},
            {"name": "alpha.wt.main", "root_path": str(main)},
            {"name": "alpha.wt.fix", "root_path": str(self.root / "different-gone")},
            {"name": "unmounted.wt.old", "root_path": str(self.root / "gone")},
            {"name": "alpha.wtish.old", "root_path": str(self.root / "gone")},
            {"name": "other.wt.old", "root_path": str(self.root / "gone")},
        ]
        calls = []
        def run(command, **kwargs):
            self.assertTrue(kwargs["check"])
            if command[0] == "git":
                checkout = pathlib.Path(command[2])
                self.assertEqual(command[3:], ["worktree", "list", "--porcelain"])
                paths = [main, linked] if checkout == main else [other]
                return subprocess.CompletedProcess(command, 0, "".join(f"worktree {p}\n\n" for p in paths))
            self.assertEqual(command[:3], ["cbm", "cli", "--json"])
            self.assertEqual(kwargs["timeout"], 600)
            tool, args = command[3], json.loads(kwargs["input"])
            calls.append((tool, args))
            if tool == "list_projects":
                self.assertEqual(command[4:], ["--format", "json"])
                self.assertEqual(args, {"limit": 500})
                return subprocess.CompletedProcess(command, 0, json.dumps({"content": [
                    {"type": "text", "text": json.dumps({"projects": projects})}]}))
            return subprocess.CompletedProcess(command, 0, "{}")
        with patch.object(hook, "root", self.root), patch.object(hook.shutil, "which", return_value="cbm"), \
                patch.object(hook.subprocess, "run", side_effect=run), patch.object(hook.subprocess, "Popen") as popen:
            hook.refresh_worker({"alpha": main, "other": other})
        popen.assert_not_called()
        self.assertEqual(calls, [
            ("list_projects", {"limit": 500}),
            ("index_repository", {"repo_path": str(main), "name": "alpha", "mode": "full"}),
            ("delete_project", {"project": "alpha.wt.old"}),
            ("index_repository", {"repo_path": str(linked), "name": "alpha.wt.fix", "mode": "full"}),
            ("index_repository", {"repo_path": str(other), "name": "other", "mode": "full"}),
            ("delete_project", {"project": "other.wt.old"}),
        ])

    def test_hook_cleanup_protects_mounted_ids_current_names_and_existing_roots(self):
        hook = load("code-map-hook")
        main, other, linked, existing = (self.root / name for name in ("main", "other", "fix", "existing"))
        for path in (main, other, linked, existing):
            path.mkdir()
        projects = [{"name": name, "root_path": str(path)} for name, path in (
            ("alpha.wt.other", self.root / "gone-mounted"),
            ("alpha.wt.", self.root / "gone-bare"),
            ("alpha.wt.keep", existing),
            ("alpha.wt.other.wt.fix", self.root / "gone-current"),
            ("alpha.wt.old", self.root / "gone-stale"))]
        with patch.object(hook, "root", self.root), patch.object(hook.shutil, "which", return_value="cbm"), \
                patch.object(hook, "worktrees", side_effect=[{main}, {other, linked}]), \
                patch.object(hook, "list_projects", return_value=projects), patch.object(hook, "cli") as cli:
            hook.refresh_worker({"alpha": main, "alpha.wt.other": other})
        self.assertEqual([c for c in cli.call_args_list if c.args[1] == "delete_project"], [
            unittest.mock.call("cbm", "delete_project", {"project": "alpha.wt.old"})])

    def test_hook_cleanup_skips_unparseable_list_output(self):
        hook = load("code-map-hook")
        main = self.root / "main"
        valid = {"name": "alpha.wt.old", "root_path": str(self.root / "gone")}
        malformed = ("not json", "[]", "{}", '{"content": []}',
                     json.dumps({"isError": True, "content": [{"type": "text", "text": json.dumps([valid])}]}),
                     json.dumps({"content": [{"type": "text", "text": "not json"}]}))
        inner = ({"unexpected": [valid]}, {"projects": [valid, {"name": "bad"}]}, [valid, None],
                 {"projects": [{"name": "alpha.wt.old", "root_path": "relative"}]})
        malformed += tuple(json.dumps({"content": [{"type": "text", "text": json.dumps(value)}]})
                           for value in inner)
        for output in malformed:
            def cli(binary, tool, args, *flags):
                return output if tool == "list_projects" else "{}"
            with self.subTest(output=output), patch.object(hook, "root", self.root), \
                    patch.object(hook.shutil, "which", return_value="cbm"), \
                    patch.object(hook, "worktrees", return_value={main}), \
                    patch.object(hook, "cli", side_effect=cli) as call:
                hook.refresh_worker({"alpha": main})
            self.assertEqual([c.args[1] for c in call.call_args_list], ["list_projects", "index_repository"])
        # Both known inner layouts are accepted.
        for data in ([valid], {"projects": [valid]}):
            envelope = json.dumps({"content": [{"type": "text", "text": json.dumps(data)}]})
            with patch.object(hook, "cli", return_value=envelope):
                self.assertEqual(hook.list_projects("cbm"), [valid])

    def test_hook_worker_errors_preserve_other_items(self):
        hook = load("code-map-hook")
        first, second, linked, last = (self.root / name for name in ("first", "second", "a-fix", "b-fix"))
        projects = [{"name": "alpha.wt.old", "root_path": str(self.root / "gone")},
                    {"name": "alpha.wt.older", "root_path": str(self.root / "gone2")}]
        for operation in ("main", "git", "worktree", "delete", "list"):
            for error in (OSError("unavailable"), subprocess.TimeoutExpired([], 600),
                          subprocess.CalledProcessError(1, [])):
                def cli(binary, tool, args, *flags):
                    if (operation == "main" and args.get("name") == "alpha" or
                        operation == "delete" and args.get("project") == "alpha.wt.old" or
                        operation == "list" and tool == "list_projects"):
                        raise error
                    if tool == "list_projects":
                        return json.dumps({"content": [{"type": "text", "text": json.dumps(projects)}]})
                    return "{}"
                def trees(checkout):
                    if checkout == first and operation == "git":
                        raise error
                    return {first, linked, last} if checkout == first else {second}
                def index(binary, repo_id, checkout, current):
                    if checkout == linked and operation == "worktree":
                        raise error
                with self.subTest(operation=operation, error=error), patch.object(hook, "root", self.root), \
                        patch.object(hook.shutil, "which", return_value="cbm"), \
                        patch.object(hook, "cli", side_effect=cli) as call, \
                        patch.object(hook, "worktrees", side_effect=trees), \
                        patch.object(hook, "index_worktree", side_effect=index) as index_call:
                    hook.refresh_worker({"alpha": first, "beta": second})
                self.assertIn(unittest.mock.call("cbm", "index_repository", {
                    "repo_path": str(second), "name": "beta", "mode": "full"}), call.call_args_list)
                if operation != "git":
                    self.assertIn(unittest.mock.call("cbm", "alpha", last, {first, linked, last}), index_call.call_args_list)
                else:
                    self.assertFalse(any(c.args[1] == "delete_project" for c in call.call_args_list))
                if operation == "delete":
                    self.assertIn(unittest.mock.call("cbm", "delete_project", {
                        "project": "alpha.wt.older"}), call.call_args_list)

    def test_health_surfaces_readiness_even_when_artifacts_pass(self):
        health = load("check-health")
        result = subprocess.CompletedProcess([], 0, "OK: map artifacts\n  READINESS: native access unverified\n", "")
        output = io.StringIO()
        with patch.object(health, "run", return_value=result), contextlib.redirect_stdout(output):
            self.assertEqual(health.normal_health(), 0)
        self.assertIn("code maps: OK: map artifacts", output.getvalue())
        self.assertIn("READINESS: native access unverified", output.getvalue())

    def test_lookup_classification(self):
        tasks = load("token-usage-tasks")
        cases = [("mcp__codebase-memory-mcp__search_graph", {}, "graph"),
                 ("check_index_coverage", {}, "coverage"),
                 ("Bash", {"command": "codebase-memory-mcp cli --json list_projects"}, "setup"),
                 ("Bash", {"command": "rg -n room knowledge/api/ENDPOINTS.md"}, "search"),
                 ("Read", {}, "read"), ("ToolSearch", {}, "other")]
        for name, args, expected in cases:
            self.assertEqual(tasks.lookup_kind(name, args), expected)
        self.assertEqual(tasks.result_measure({"content": None})["chars"], 0)

    def test_pilot_result_pairing_dedup_cache_and_privacy(self):
        tasks = load("token-usage-tasks")
        self.sidecar("repositories:\n  - id: alpha\n    path: custom\n")
        project = self.root / "transcripts/project"
        project.mkdir(parents=True)
        private = "PRIVATE_OUTPUT_MUST_NOT_PERSIST"
        records = []
        def assistant(sid, message, call, name, minute, output=2):
            return {"type": "assistant", "sessionId": sid, "cwd": str(self.root / "custom"),
                    "requestId": message, "timestamp": "2026-10-12T10:%02d:00+08:00" % minute,
                    "message": {"id": message, "model": "fixture-model", "usage": {
                        "input_tokens": 10, "output_tokens": output, "cache_read_input_tokens": 20,
                        "cache_creation_input_tokens": 3}, "content": [
                            {"type": "tool_use", "id": call, "name": name, "input": {}}]}}
        def result(sid, call, text, minute, error=False):
            return {"type": "user", "sessionId": sid, "timestamp": "2026-10-12T10:%02d:30+08:00" % minute,
                    "message": {"content": [{"type": "tool_result", "tool_use_id": call,
                                               "content": text, "is_error": error}]}}
        records += [assistant("parent", "m1", "g1", "search_graph", 0),
                    assistant("parent", "m1", "g1", "search_graph", 0, output=4),
                    result("parent", "g1", private, 0), result("parent", "g1", private, 0),
                    assistant("parent", "m2", "s1", "Grep", 1), result("parent", "s1", "abc", 1),
                    assistant("parent", "m3", "c1", "check_index_coverage", 2)]
        (project / "parent.jsonl").write_text("\n".join(json.dumps(r) for r in records))
        child = project / "parent/subagents"
        child.mkdir(parents=True)
        (child / "child.jsonl").write_text("\n".join(json.dumps(r) for r in [
            assistant("child", "c2", "g2", "query_graph", 3), result("child", "g2", "rows: 0", 3),
            assistant("child", "c3", "g3", "query_graph", 4), result("child", "g3", "syntax error", 4, True)]))
        since = until = date(2026, 10, 12)
        collected, _ = tasks.collect_tasks(str(self.root / "transcripts"), since, until, str(self.root), ["alpha"])
        self.assertEqual(len(collected), 2)
        self.assertEqual(sum(t["lookups"]["graph"]["calls"] for t in collected.values()), 3)
        self.assertEqual(sum(t["cache_read"] for t in collected.values()), 100)
        self.assertEqual(sum(t["output"] for t in collected.values()), 12)
        parent = next(t for t in collected.values() if t["lookups"]["search"]["calls"])
        self.assertEqual(parent["bucket"], "alpha")
        self.assertEqual(parent["first_lookup"], "graph")
        self.assertEqual(parent["lookups"]["graph"]["result_chars"], len(private))
        self.assertEqual(parent["lookups"]["coverage"]["unmatched"], 1)
        rows = [tasks.row_for_instance(iid, task, {"ref": "#1", "result": "success", "task_type": "structural"}, None)
                for iid, task in collected.items()]
        merged = tasks.merge_annotated_rows(rows)
        self.assertEqual(merged[0]["lookups"]["graph"]["errors"], 1)
        self.assertEqual(merged[0]["lookups"]["graph"]["empty"], 1)
        blob = json.dumps(merged)
        for value in (private, "parent", "child", str(self.root), "g1"):
            self.assertNotIn(value, blob)


if __name__ == "__main__":
    unittest.main()
