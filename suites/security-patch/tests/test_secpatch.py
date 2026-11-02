import io
import json
import os
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock, call

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))
import secpatch  # noqa: E402

OVERVIEW = {
    "repo": "owner/app",
    "availableTypes": ["sqli", "cors"],
    "types": [{"category": "sqli", "issue": 3, "body": "", "total": 3,
               "counts": {"open": 2, "in progress": 0, "needs human": 1, "ignored": 0, "fixed": 0}},
              {"category": "cors", "issue": None, "body": "", "total": 0,
               "counts": {"open": 0, "in progress": 0, "needs human": 0, "ignored": 0, "fixed": 0}}],
    "openPRs": [{"number": 9, "title": "【P1·SQL 注入】接口参数化", "draft": True, "url": "u"}],
    "needsHuman": [{"category": "sqli", "issue": 3, "file": "app/a.php", "lines": [4],
                    "reason": "Changes behavior", "severity": "P0"}],
    "ignored": [],
}
PICK = {"repoUrl": "https://github.com/owner/app", "suggestedIds": ["a" * 64], "rows": [
    {"id": "a" * 64, "category": "sqli", "severity": "P0", "file": "app/a.php", "lines": [4],
     "status": "open", "reason": "SQL interpolation", "date": "22-10-2026", "pr": "", "subsystem": "app/a.php"},
    {"id": "b" * 64, "category": "sqli", "severity": "P1", "file": "app/b.php", "lines": [7],
     "status": "open", "reason": "SQL interpolation", "date": "22-10-2026", "pr": "", "subsystem": "app/b.php"}],
    "hidden": [], "limits": {"maxFilesPerBatch": 10}}

# RunSummary returned by handleGetRun and handleListAllRuns, including pagination.
RUN = {"runId": "r1", "runNumber": 1, "sessionId": "s1", "repoUrl": "https://github.com/owner/app",
       "branch": "main", "skill": "ola-security-audit", "model": "opus", "effort": "high",
       "mode": "fix", "status": "stopped", "startedAt": 1792663200000,
       "finishedAt": 1792663260000, "error": "stopped at quota"}


SETUP = {"githubLogin": True, "push": "token"}


class Fake:
    calls = []

    @staticmethod
    def urlopen(request, timeout=30):
        url = request.full_url if isinstance(request, secpatch.urllib.request.Request) else request
        if not url.startswith(SuiteTest.url):
            raise secpatch.urllib.error.URLError("fixture backend unavailable")
        path = secpatch.urllib.parse.urlsplit(url).path
        method = request.get_method() if isinstance(request, secpatch.urllib.request.Request) else "GET"
        Fake.calls.append((method, path))
        routes = {"/api/health": {"status": "ok"}, "/api/setup": SETUP, "/api/overview": OVERVIEW, "/api/pick": PICK,
                  "/api/runs": {"runs": [RUN], "limit": 200, "offset": 0},
                  "/api/runs/r1": {**RUN, "caps": {"maxTurns": 50}}, "": {}, "/": {}}
        code = 200
        if method == "POST":
            if path == "/api/runs/r0/stop":
                body = {"ok": True}
            elif path == "/api/runs/r1/stop":
                code, body = 409, {"error": "run is already stopped"}
            elif path == "/api/runs/r1/resume":
                code, body = 201, {"runId": "r2", "status": "queued"}
            else:
                code, body = 409, {"error": "run already resumed"}
        elif path in routes:
            body = routes[path]
        else:
            code, body = 404, {"error": "not found"}
        if code >= 400:
            raise secpatch.urllib.error.HTTPError(url, code, "fixture error", {}, io.BytesIO(json.dumps(body).encode()))
        response = Mock(status=code)
        response.read.return_value = json.dumps(body).encode()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        return response


class SuiteTest(unittest.TestCase):
    url = "http://127.0.0.1:12345"

    def setUp(self):
        transport = patch.object(secpatch.urllib.request, "urlopen", side_effect=Fake.urlopen)
        transport.start()
        self.addCleanup(transport.stop)

    def run_cli(self, argv, url=None):
        with tempfile.TemporaryDirectory() as here:
            with open(os.path.join(here, "config.yaml"), "w") as f:
                f.write('tool_url: "TODO(owner): set me"\n')
            if url:
                with open(os.path.join(here, "config.local.yaml"), "w") as f:
                    f.write(f"# operator copy\ntool_url: {url}\n")
            out = io.StringIO()
            return secpatch.main(argv, out, here), out.getvalue()

    def test_todo_url_is_refused(self):
        code, out = self.run_cli(["overview"])
        self.assertEqual(code, 1)
        self.assertIn("tool_url is not set", out)
        self.assertEqual(self.run_cli(["doctor"])[0], 1)

    def test_local_config_wins_and_overview_prints_state(self):
        code, out = self.run_cli(["overview"], self.url)
        self.assertEqual(code, 0)
        self.assertIn("sqli", out)
        self.assertIn("#9 【P1·SQL 注入】接口参数化 (draft)", out)
        self.assertIn("[sqli] app/a.php:4 — Changes behavior", out)

    def test_pick_lists_only_suggested_rows_and_never_confirms(self):
        Fake.calls.clear()
        code, out = self.run_cli(["pick"], self.url)
        self.assertEqual(code, 0)
        self.assertIn("app/a.php:4", out)
        self.assertNotIn("app/b.php", out)
        self.assertEqual(Fake.calls, [("GET", "/api/pick")])

    def test_status_and_resume(self):
        self.assertIn("r1: stopped stopped at quota", self.run_cli(["status", "r1"], self.url)[1])
        code, out = self.run_cli(["resume", "r1"], self.url)
        self.assertEqual((code, out.strip()), (0, "resumed as run r2"))
        code, out = self.run_cli(["resume", "r9"], self.url)
        self.assertEqual(code, 1)
        self.assertIn("run already resumed", out)

    def test_writes_use_json_and_the_configured_host_without_a_browser_origin(self):
        def strict_backend(request, timeout=30):
            if request.get_header("Content-type") != "application/json":
                raise secpatch.urllib.error.HTTPError(request.full_url, 415, "", {},
                                                      io.BytesIO(b'{"error":"JSON required"}'))
            self.assertEqual(request.host, "127.0.0.1:12345")
            self.assertIsNone(request.get_header("Origin"))
            return Fake.urlopen(request, timeout)

        with patch.object(secpatch.urllib.request, "urlopen", side_effect=strict_backend):
            for argv in (["resume", "r1"], ["stop", "r0", "--yes"]):
                with self.subTest(argv=argv):
                    self.assertEqual(self.run_cli(argv, self.url)[0], 0)

    def test_api_rejects_non_object_json_and_empty_success_bodies(self):
        commands = (["overview"], ["pick"], ["runs"], ["status", "r1"], ["watch", "r1"],
                    ["resume", "r1"], ["stop", "r0", "--yes"])
        for raw in (b"[]", b"null", b'"error"', b"123", b"true", b"", b"<html>error</html>", b"\xff"):
            for status in (200, 400, 500):
                for argv in commands:
                    with self.subTest(raw=raw, status=status, argv=argv):
                        if status >= 400:
                            options = {"side_effect": secpatch.urllib.error.HTTPError(
                                self.url, status, "", {}, io.BytesIO(raw))}
                        else:
                            response = Mock(status=201 if argv[0] == "resume" else 200)
                            response.read.return_value = raw
                            response.__enter__ = Mock(return_value=response)
                            response.__exit__ = Mock(return_value=False)
                            options = {"return_value": response}
                        with patch.object(secpatch.urllib.request, "urlopen", **options), \
                             patch.object(secpatch.time, "sleep", side_effect=AssertionError("invalid response must not poll")):
                            code, out = self.run_cli(argv, self.url)
                        self.assertEqual(code, 1)
                        self.assertNotIn("Traceback", out)
                        self.assertNotIn("<html>", out)

    def test_empty_api_lists_are_successful(self):
        with patch.dict(OVERVIEW, {"types": [], "openPRs": [], "needsHuman": []}), \
             patch.dict(PICK, {"rows": [], "suggestedIds": []}):
            for command in ("overview", "pick"):
                self.assertEqual(self.run_cli([command], self.url)[0], 0)
        response = Fake.urlopen(secpatch.urllib.request.Request(self.url + "/api/runs"))
        response.read.return_value = b'{"runs":[]}'
        with patch.object(secpatch.urllib.request, "urlopen", return_value=response):
            self.assertEqual(self.run_cli(["runs"], self.url), (0, ""))

    def test_invalid_config_urls_fail_without_requests_or_browser_calls(self):
        values = ("http://localhost:bad", "http://localhost:65536", "http://[invalid", "http:///missing-host",
                  "http://localhost/\tinvalid")
        for key in ("tool_url", "ui_url"):
            for value in values:
                with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as here, \
                     patch.object(secpatch.urllib.request, "urlopen") as transport, \
                     patch.object(secpatch.webbrowser, "open") as browser:
                    with open(os.path.join(here, "config.local.yaml"), "w") as config:
                        config.write(f"tool_url: {self.url}\nui_url: http://localhost:32088\n{key}: {value}\n")
                    out = io.StringIO()
                    self.assertEqual(secpatch.main(["overview" if key == "tool_url" else "open"], out, here), 1)
                    self.assertNotIn(value, out.getvalue())
                    transport.assert_not_called()
                    browser.assert_not_called()

    def test_config_urls_with_credentials_are_rejected_before_output(self):
        for value in ("http://operator:fixture-secret@localhost:37018", "http://localhost:37018?token=fixture-secret",
                      "http://localhost:32088/#token=fixture-secret"):
            for key in ("tool_url", "ui_url"):
                with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as here, \
                     patch.object(secpatch.urllib.request, "urlopen") as transport, \
                     patch.object(secpatch.webbrowser, "open") as browser:
                    with open(os.path.join(here, "config.local.yaml"), "w") as config:
                        config.write(f"tool_url: {self.url}\nui_url: http://localhost:32088\n{key}: {value}\n")
                    out = io.StringIO()
                    self.assertEqual(secpatch.main(["overview" if key == "tool_url" else "open"], out, here), 1)
                    self.assertNotIn("fixture-secret", out.getvalue())
                    transport.assert_not_called()
                    browser.assert_not_called()

    def test_doctor_handles_invalid_ports_and_keeps_url_credentials_out_of_output(self):
        for value in ("http://localhost:bad", "http://localhost:65536", "http://[invalid",
                      "http://operator:fixture-secret@localhost:37018"):
            with self.subTest(value=value), patch.object(secpatch.shutil, "which", return_value=None), \
                 patch.object(secpatch.subprocess, "run", return_value=Mock(returncode=1, stdout="")):
                code, out = self.run_cli(["doctor"], value)
                self.assertEqual(code, 1)
                self.assertIn("[MISS] tool_url", out)
                self.assertNotIn(value, out)
                self.assertNotIn("fixture-secret", out)

    def test_bad_usage(self):
        for argv in ([], ["ship"], ["resume"], ["resume", "../x"], ["start", "--auth=bad"],
                     ["stop", "extra", "--no"], ["watch"], ["watch", "../x"], ["open", "../x"], ["open", "r1", "extra"], ["runs", "extra"], ["logs", "--bad"], ["overview", "extra"], ["doctor", "extra"]):
            self.assertEqual(self.run_cli(argv, self.url)[0], 2, argv)

    def test_service_runs_only_the_bundled_app_from_its_directory(self):
        with tempfile.TemporaryDirectory(prefix="suite app ") as here:
            app = os.path.join(here, "app")
            os.makedirs(os.path.join(app, "scripts"))
            with open(os.path.join(app, "scripts", "dev.sh"), "w") as f:
                f.write('printf "%s\\n" "$PWD" "$@" > invocation.txt\nexit 7\n')
            for argv in (["start"], ["start", "--auth=settings"], ["dev"], ["dev", "--auth=settings"], ["stop"], ["logs"], ["logs", "--follow"], ["status"]):
                self.assertEqual(secpatch.main(argv, io.StringIO(), here), 7)
                with open(os.path.join(app, "invocation.txt")) as f:
                    self.assertEqual(f.read().splitlines(), [os.path.realpath(app), *argv])

    def test_missing_bundled_app_refuses_start(self):
        code, out = self.run_cli(["start"])
        self.assertEqual(code, 1)
        self.assertIn("bundled app is missing", out)

    def test_doctor_checks_app_prerequisites_and_docker_without_a_tool_clone(self):
        with tempfile.TemporaryDirectory() as here:
            paths = ("backend/cli/server.ts", "frontend/bun.lock", "scanner/bridge.mjs", "scripts/dev.sh", ".env")
            for path in paths:
                full = os.path.join(here, "app", path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w") as f:
                    f.write("")
            with patch.object(secpatch.shutil, "which", return_value="/fake/bin"), \
                 patch.object(secpatch.subprocess, "run") as run:
                run.return_value.returncode = 0
                run.return_value.stdout = "COMMAND PID\nfixture 123"
                out = io.StringIO()
                self.assertEqual(secpatch.doctor(self.url, out, here, self.url), 0)
                self.assertIn("[OK] Docker daemon", out.getvalue())
                self.assertIn("[OK] scanner image", out.getvalue())
                self.assertIn("[OK] UI at", out.getvalue())
                self.assertIn("[OK] port", out.getvalue())
                self.assertIn("[OK] bundled app/.env", out.getvalue())
                self.assertIn("[OK] bundled app/scanner/bridge.mjs", out.getvalue())
                self.assertEqual(run.call_args_list[0].args[0], ["docker", "info"])
                run.return_value.returncode = 1
                self.assertEqual(secpatch.doctor(self.url, io.StringIO(), here, self.url), 1)
            with patch.object(secpatch.shutil, "which", return_value=None), \
                 patch.object(secpatch.subprocess, "run", side_effect=FileNotFoundError):
                self.assertEqual(secpatch.doctor(self.url, io.StringIO(), here, self.url), 1)

    def test_doctor_names_missing_posting_settings(self):
        out = io.StringIO()
        with patch.dict(SETUP, {"githubLogin": False, "push": None}):
            self.assertFalse(secpatch.posting_setup(self.url, out))
        self.assertIn("[MISS] tool GitHub login", out.getvalue())
        self.assertIn("[MISS] PR push: set GH_TOKEN in app/.env", out.getvalue())
        out = io.StringIO()
        self.assertTrue(secpatch.posting_setup(self.url, out))
        self.assertIn("[OK] tool GitHub login", out.getvalue())
        self.assertIn("[OK] PR push: token", out.getvalue())

    def test_doctor_prints_each_port_owner_once_on_one_line(self):
        owners = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n" + \
                 "bun 123 user 1u IPv4 0 0t0 TCP *:37018 (LISTEN)\n" + \
                 "bun 123 user 2u IPv6 0 0t0 TCP *:37018 (LISTEN)\n" + \
                 "node 456 user 3u IPv4 0 0t0 TCP *:32088 (LISTEN)\n"
        with patch.object(secpatch.shutil, "which", return_value="/fake/bin"), \
             patch.object(secpatch.subprocess, "run", return_value=Mock(returncode=0, stdout=owners)):
            out = io.StringIO()
            secpatch.doctor(self.url, out, ui=self.url)
        lines = [line for line in out.getvalue().splitlines() if "port " in line]
        self.assertEqual(lines, ["[OK] port 12345 owners: bun (pid 123), node (pid 456)"])
        self.assertNotIn("COMMAND PID", out.getvalue())
        self.assertNotIn("LISTEN", out.getvalue())

    def test_unreachable_tool_fails_doctor(self):
        code, out = self.run_cli(["doctor"], "http://127.0.0.1:9")
        self.assertEqual(code, 1)
        self.assertIn("[MISS] codesec tool", out)

    def test_pick_uses_ui_url_and_defaults_for_older_configs(self):
        code, out = self.run_cli(["pick"], self.url)
        self.assertEqual(code, 0)
        self.assertIn("Pick screen: http://localhost:32088", out)
        with tempfile.TemporaryDirectory() as here:
            with open(os.path.join(here, "config.yaml"), "w") as f:
                f.write(f"tool_url: {self.url}\nui_url: http://localhost:12345/\n")
            out = io.StringIO()
            self.assertEqual(secpatch.main(["pick"], out, here), 0)
            self.assertIn("Pick screen: http://localhost:12345\n", out.getvalue())
            with patch.object(secpatch.webbrowser, "open", return_value=True) as browser:
                self.assertEqual(secpatch.main(["open"], io.StringIO(), here), 0)
                browser.assert_called_once_with("http://localhost:12345")

    def test_cli_rejects_unset_ui_url(self):
        for value in ("", '""', '"TODO(owner): set me"', '"http://TODO(owner)"'):
            for command in ("doctor", "pick", "open"):
                with self.subTest(value=value, command=command), \
                     tempfile.TemporaryDirectory() as here, \
                     patch.object(secpatch.shutil, "which", return_value="/fake/bin"), \
                     patch.object(secpatch.subprocess, "run", return_value=Mock(returncode=0, stdout="")), \
                     patch.object(secpatch.urllib.request, "urlopen", side_effect=Fake.urlopen) as transport, \
                     patch.object(secpatch.webbrowser, "open") as browser:
                    with open(os.path.join(here, "config.local.yaml"), "w") as f:
                        f.write(f"tool_url: {self.url}\nui_url: {value}\n")
                    out = io.StringIO()
                    self.assertEqual(secpatch.main([command], out, here), 1)
                    self.assertIn("[MISS] ui_url" if command == "doctor" else "ui_url is not set", out.getvalue())
                    self.assertIn("suites/security-patch/config.local.yaml", out.getvalue())
                    self.assertTrue(all(isinstance(args.args[0], secpatch.urllib.request.Request)
                                        for args in transport.call_args_list))
                    browser.assert_not_called()

    def test_open_needs_no_backend_and_reports_browser_failure(self):
        with patch.object(secpatch.webbrowser, "open", return_value=False):
            code, out = self.run_cli(["open"])
        self.assertEqual(code, 1)
        self.assertIn("Open http://localhost:32088", out)

    def test_runs_reads_recent_runs(self):
        Fake.calls.clear()
        code, out = self.run_cli(["runs"], self.url)
        self.assertEqual(code, 0)
        self.assertEqual(out, "#1 r1: stopped fix https://github.com/owner/app\n")
        self.assertEqual(Fake.calls, [("GET", "/api/runs")])

    def test_every_run_verb_resolves_bare_and_hash_numbers_to_uuid(self):
        for number in ("1", "#1"):
            for verb in ("status", "watch", "open", "resume", "stop"):
                with self.subTest(number=number, verb=verb), \
                     patch.object(secpatch.webbrowser, "open", return_value=True) as browser:
                    Fake.calls.clear()
                    argv = [verb, number] + (["--yes"] if verb == "stop" else [])
                    code, out = self.run_cli(argv, self.url)
                    self.assertEqual(code, 1 if verb == "stop" else 0)
                    self.assertEqual(Fake.calls[0], ("GET", "/api/runs"))
                    if verb == "open":
                        browser.assert_called_once_with("http://localhost:32088/runs/r1")
                        self.assertEqual(len(Fake.calls), 1)
                    else:
                        method = "POST" if verb in ("resume", "stop") else "GET"
                        suffix = f"/{verb}" if method == "POST" else ""
                        self.assertEqual(Fake.calls[1:], [(method, f"/api/runs/r1{suffix}")])
                        self.assertIn({"status": "r1: stopped", "watch": "r1: stopped",
                                       "resume": "resumed as run r2", "stop": "run is already stopped"}[verb], out)

    def test_unknown_numbers_do_not_open_or_mutate_a_run(self):
        for number in ("12", "#12", "0", "#0"):
            for verb in ("status", "watch", "open", "resume", "stop"):
                with self.subTest(number=number, verb=verb), \
                     patch.object(secpatch.webbrowser, "open") as browser:
                    Fake.calls.clear()
                    code, out = self.run_cli([verb, number] + (["--yes"] if verb == "stop" else []), self.url)
                    self.assertEqual(code, 1)
                    self.assertIn(f"unknown run number #{number.lstrip('#')}", out)
                    self.assertEqual(Fake.calls, [("GET", "/api/runs")])
                    browser.assert_not_called()

    def test_number_lookup_pages_past_recent_runs(self):
        pages = [(200, {"runs": [{**RUN, "runNumber": 2, "runId": "newer"}], "limit": 1, "offset": 0}),
                 (200, {"runs": [RUN], "limit": 1, "offset": 1}), (200, RUN)]
        with patch.object(secpatch, "call", side_effect=pages) as api:
            self.assertEqual(self.run_cli(["status", "#1"], self.url)[0], 0)
        self.assertEqual(api.call_args_list, [call(self.url, "/api/runs?limit=500&offset=0"),
                                            call(self.url, "/api/runs?limit=500&offset=1"),
                                            call(self.url, "/api/runs/r1")])

    def test_number_lookup_reports_backend_failure(self):
        with patch.object(secpatch, "call", return_value=(503, {"error": "unavailable"})) as api:
            code, out = self.run_cli(["resume", "#1"], self.url)
        self.assertEqual((code, out), (1, "run lookup failed: unavailable\n"))
        api.assert_called_once_with(self.url, "/api/runs?limit=500&offset=0")

    def test_stop_number_still_requires_yes_before_lookup(self):
        Fake.calls.clear()
        code, out = self.run_cli(["stop", "#1"], self.url)
        self.assertEqual(code, 1)
        self.assertIn("Stopping a run requires the operator's yes", out)
        self.assertEqual(Fake.calls, [])

    def test_open_uuid_uses_uuid_url_without_lookup(self):
        Fake.calls.clear()
        with patch.object(secpatch.webbrowser, "open", return_value=True) as browser:
            self.assertEqual(self.run_cli(["open", "r1"], self.url)[0], 0)
        browser.assert_called_once_with("http://localhost:32088/runs/r1")
        self.assertEqual(Fake.calls, [])

    def test_watch_prints_only_changes_every_ten_seconds_until_terminal(self):
        for terminal in ("completed", "failed", "stopped", "aborted"):
            responses = [(200, {**RUN, "status": state, "error": None})
                         for state in ("queued", "queued", "scanning", terminal)]
            with patch.object(secpatch, "call", side_effect=responses) as api, \
                 patch.object(secpatch.time, "sleep") as sleep:
                code, out = self.run_cli(["watch", "r1"], self.url)
            self.assertEqual(code, 0)
            self.assertEqual(out, f"r1: queued\nr1: scanning\nr1: {terminal}\n")
            self.assertEqual(sleep.call_args_list, [call(10)] * 3)
            self.assertEqual(api.call_args_list, [call(self.url, "/api/runs/r1")] * 4)
        with patch.object(secpatch, "call", return_value=(404, {"error": "not found"})):
            self.assertEqual(self.run_cli(["watch", "r1"], self.url)[0], 1)

    def test_stop_run_requires_yes_and_only_calls_its_stop_endpoint(self):
        Fake.calls.clear()
        code, out = self.run_cli(["stop", "r0"], self.url)
        self.assertEqual(code, 1)
        self.assertIn("operator's yes", out)
        self.assertEqual(Fake.calls, [])
        self.assertEqual(self.run_cli(["stop", "r0", "--yes"], self.url)[0], 0)
        self.assertEqual(Fake.calls, [("POST", "/api/runs/r0/stop")])
        code, out = self.run_cli(["stop", "r1", "--yes"], self.url)
        self.assertEqual(code, 1)
        self.assertIn("run is already stopped", out)
        code, out = self.run_cli(["stop", "r9", "--yes"], self.url)
        self.assertEqual(code, 1)
        self.assertIn("stop refused", out)

    def test_backend_down_prints_start_hint_without_urlopen_details(self):
        for argv in (["pick"], ["overview"], ["runs"], ["status", "r1"], ["watch", "r1"], ["resume", "r1"], ["stop", "r1", "--yes"]):
            with patch.object(secpatch.urllib.request, "urlopen", side_effect=secpatch.urllib.error.URLError("raw socket detail")):
                code, out = self.run_cli(argv, self.url)
            self.assertEqual(code, 1)
            self.assertIn("suites/security-patch/run start", out)
            self.assertNotIn("raw socket detail", out)

    def test_doctor_reports_new_missing_checks(self):
        with tempfile.TemporaryDirectory() as here, \
             patch.object(secpatch.shutil, "which", return_value="/fake/bin"), \
             patch.object(secpatch.subprocess, "run", return_value=Mock(returncode=1, stdout="")), \
             patch.object(secpatch.urllib.request, "urlopen", side_effect=OSError):
            out = io.StringIO()
            self.assertEqual(secpatch.doctor(self.url, out, here, self.url), 1)
        for text in ("[MISS] bundled app/.env", "[MISS] scanner image", "[MISS] UI at", "[MISS] port"):
            self.assertIn(text, out.getvalue())


class PortabilityTest(unittest.TestCase):
    def check_guard(self, relative, content):
        suite = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(suite, "test")) as f:
            script = f.read()
        guard = script[script.index("# portability:"):script.index("# SKIP_SCANNER_IMAGE=1")]
        with tempfile.TemporaryDirectory() as root:
            here = os.path.join(root, "suite")
            for directory in ("lib", "docs", "app/skill"):
                os.makedirs(os.path.join(here, directory))
            for filename in ("run", "SUITE.md", "config.yaml"):
                with open(os.path.join(here, filename), "w") as f:
                    f.write("")
            with open(os.path.join(root, "workspace.yaml"), "w") as f:
                f.write("repositories:\n  - id: pilot-local\n")
            target = os.path.join(here, relative)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w") as f:
                f.write(content)
            result = subprocess.run(["sh", "-c", 'here=$1\nroot=$2\nrc=0\n' + guard + '\nexit "$rc"',
                                     "guard", here, root], capture_output=True, text=True)
            return result.returncode, result.stdout + result.stderr

    def test_guard_rejects_mounted_ids_and_pilot_text_in_app_skill(self):
        for token in ("pilot-local", "olaola-chat/bms-payment PR #182", "cli/room/vendor", "pt-oversea",
                      "app/service/Helper.php", "RedisBase.php", "phpnsq", "StageRoomTypeCheck", "ApplicationVar", "server/"):
            with self.subTest(token=token):
                code, output = self.check_guard("app/skill/audit/SKILL.md", token)
                self.assertEqual(code, 1, output)
                self.assertIn("FAIL:", output)

    def test_guard_excludes_target_notes_and_test_fixtures(self):
        for path in ("app/skill/audit/targets/owner__repo.md", "app/skill/audit/tests/fixture.md",
                     "app/skill/audit/fixture.test.mjs", "app/skill/audit/SKILL.md"):
            content = "generic audit instructions" if path.endswith("SKILL.md") else "pilot-local pt-oversea Helper.php server/"
            with self.subTest(path=path):
                code, output = self.check_guard(path, content)
                self.assertEqual(code, 0, output)


if __name__ == "__main__":
    unittest.main()
