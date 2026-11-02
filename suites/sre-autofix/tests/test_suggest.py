import os
import unittest

from helpers import FIXTURES, TempDir, write
from lib import suggest as S


def readers(files):
    """In-memory repo: {relpath: content}."""
    return (lambda rel: files.get(rel, "")), (lambda: sorted(files))


class CiStepsTest(unittest.TestCase):
    def test_single_and_block_run_steps_on_pull_request(self):
        wf = ("name: ci\non:\n  pull_request:\njobs:\n  b:\n    steps:\n      - uses: x\n"
              "      - run: go build ./...\n      - name: vet\n        run: |\n          go vet ./...\n          go test ./...\n"
              "      - run: \"echo done\"\n")
        f, steps = S.ci_run_steps(*readers({".github/workflows/ci.yml": wf}))
        self.assertEqual(f, ".github/workflows/ci.yml")
        self.assertEqual(steps, ["go build ./...", "go vet ./...  …(+1 行)", "echo done"])

    def test_push_only_workflow_ignored(self):
        wf = "on: push\njobs:\n  b:\n    steps:\n      - run: make\n"
        self.assertEqual(S.ci_run_steps(*readers({".github/workflows/x.yml": wf})), ("", []))

    def test_seed_repo_has_no_run_steps(self):
        r, l = S.fs_readers(os.path.join(FIXTURES, "repo-seed"))
        self.assertEqual(S.ci_run_steps(r, l), ("", []))


class SuggestTest(unittest.TestCase):
    def test_go(self):
        s = S.suggest(*readers({"go.mod": "module x\n"}))
        self.assertEqual(s["commands"], ["go build ./...", "go vet ./..."])
        self.assertTrue(s["catches_signature_errors"])
        self.assertEqual(s["basis"], "go.mod")

    def test_java_and_ts(self):
        self.assertEqual(S.suggest(*readers({"pom.xml": "<project/>"}))["commands"], ["mvn -q -DskipTests compile"])
        self.assertEqual(S.suggest(*readers({"tsconfig.json": "{}", "package.json": "{}"}))["commands"], ["npx tsc --noEmit"])

    def test_php_without_analyser_is_flagged_weak(self):
        s = S.suggest(*readers({"composer.json": "{}"}))
        self.assertEqual(s["commands"], ["php -l {files}"])
        self.assertFalse(s["catches_signature_errors"])
        self.assertIn("phpstan-new-errors.sh", s["note"])

    def test_php_with_phpstan_in_composer(self):
        s = S.suggest(*readers({"composer.json": '{"require-dev": {"phpstan/phpstan": "^2"}}'}))
        self.assertIn("vendor/bin/phpstan analyse --level 5 {files}", s["commands"])
        self.assertTrue(s["catches_signature_errors"])

    def test_php_detected_from_runtime_note_when_no_composer(self):
        s = S.suggest(*readers({"README.md": "x"}), runtime_note="PHP 7.2（依据 CI）")
        self.assertEqual(s["commands"], ["php -l {files}"])
        self.assertEqual(s["basis"], "CI 探测到 PHP")

    def test_python_mypy(self):
        self.assertEqual(S.suggest(*readers({"pyproject.toml": "[tool.mypy]\n"}))["commands"], ["mypy {files}"])
        s = S.suggest(*readers({"requirements.txt": "x\n"}))
        self.assertEqual(s["commands"], ["python -m compileall -q {files}"])
        self.assertFalse(s["catches_signature_errors"])

    def test_nothing_recognised(self):
        s = S.suggest(*readers({"README.md": "x"}))
        self.assertEqual(s["commands"], [])
        self.assertIn("no toolchain marker", S.render_lines(s, "r")[0])

    def test_render_lines_shape(self):
        s = S.suggest(*readers({"go.mod": "module x\n",
                                ".github/workflows/ci.yml": "on: [pull_request]\njobs:\n  b:\n    steps:\n      - run: go vet ./...\n"}))
        lines = S.render_lines(s, "gosvc")
        self.assertTrue(lines[0].startswith("CI on pull_request runs (.github/workflows/ci.yml)"))
        self.assertIn('checks: ["go build ./...", "go vet ./..."]', lines[1])
        self.assertIn("catches signature errors", lines[1])
        weak = S.render_lines(S.suggest(*readers({"composer.json": "{}"})), "php")
        self.assertIn("SYNTAX ONLY", weak[0])
        self.assertTrue(weak[1].startswith("⚠"))

    def test_multiple_markers_prefer_the_probed_runtime(self):
        # a PHP monolith with a stray go.mod for a helper tool: CI says PHP → PHP wins, Go is "also found"
        s = S.suggest(*readers({"go.mod": "module x\n", "composer.json": "{}"}), runtime_note="PHP 7.2（依据 CI）")
        self.assertEqual(s["lang"], "PHP")
        self.assertEqual(s["commands"], ["php -l {files}"])
        self.assertEqual([a["lang"] for a in s["also"]], ["Go"])
        lines = S.render_lines(s, "r")
        self.assertTrue(any(l.startswith("also found Go (go.mod)") for l in lines), lines)
        # no probe → first marker wins, the rest still listed
        s2 = S.suggest(*readers({"go.mod": "module x\n", "composer.json": "{}"}))
        self.assertEqual(s2["lang"], "Go")
        self.assertEqual([a["lang"] for a in s2["also"]], ["PHP"])

    def test_all_pull_request_workflows_listed(self):
        files = {".github/workflows/a.yml": "on: [pull_request]\njobs:\n  a:\n    steps:\n      - run: make a\n",
                 ".github/workflows/b.yml": "on:\n  pull_request:\njobs:\n  b:\n    steps:\n      - run: make b\n",
                 ".github/workflows/c.yml": "on: push\njobs:\n  c:\n    steps:\n      - run: make c\n"}
        s = S.suggest(*readers(files))
        self.assertEqual([f for f, _ in s["ci"]], [".github/workflows/a.yml", ".github/workflows/b.yml"])
        self.assertEqual(len([l for l in S.render_lines(s, "r") if l.startswith("CI on pull_request")]), 2)

    def test_fs_readers_on_disk(self):
        with TempDir() as tmp:
            write(os.path.join(tmp, "go.mod"), "module x\n")
            write(os.path.join(tmp, ".github", "workflows", "ci.yml"), "on: pull_request\njobs:\n  a:\n    steps:\n      - run: go build ./...\n")
            r, l = S.fs_readers(tmp)
            self.assertIn(".github/workflows/ci.yml", l())
            s = S.suggest(r, l)
            self.assertEqual(s["ci_steps"], ["go build ./..."])
            self.assertEqual(s["basis"], "go.mod")


if __name__ == "__main__":
    unittest.main()
