import os
import unittest

from helpers import TempDir
from lib import repocheck as R


class ExpandTest(unittest.TestCase):
    def test_placeholders_are_shell_quoted(self):
        s = R.expand("php -l {files} && ls {worktree}", ["app/a b.php", "app/c'd.php"], "/tmp/w t")
        self.assertEqual(s, "php -l 'app/a b.php' 'app/c'\"'\"'d.php' && ls '/tmp/w t'")

    def test_root_placeholder(self):
        self.assertEqual(R.expand("sh {root}/x.sh {worktree}", [], "/w", root="/ws root"), "sh '/ws root'/x.sh /w")
        self.assertEqual(R.expand("sh {root}/x.sh", [], "/w"), "sh ''/x.sh")   # no root given → empty, never a crash

    def test_no_files_expands_to_nothing(self):
        self.assertEqual(R.expand("go vet ./... {files}", [], "/w"), "go vet ./... ")

    def test_binaries_skip_env_prefix(self):
        self.assertEqual(R.binaries(["GOFLAGS=-mod=mod go build ./...", "php -l {files}", "go vet ./..."]),
                         ["go", "php"])

    def test_describe(self):
        self.assertEqual(R.describe(["a", "b c"]), "`a`；`b c`")


class RunAllTest(unittest.TestCase):
    def test_runs_in_worktree_records_code_and_output(self):
        with TempDir() as tmp:
            open(os.path.join(tmp, "x.txt"), "w").close()
            res = R.run_all(["test -f x.txt", "echo out; echo err >&2; exit 2", "echo {files}"],
                            tmp, ["a.php", "b c.php"], wall=10)
            self.assertEqual([r["code"] for r in res], [0, 2, 0])
            self.assertEqual(res[1]["output"], "out\nerr")
            self.assertEqual(res[2]["output"], "a.php b c.php")
            self.assertEqual(res[2]["expanded"], "echo a.php 'b c.php'")
            log = R.log_text(res)
            self.assertIn("$ test -f x.txt", log)
            self.assertIn("exit 2", log)

    def test_wall_clock_is_a_failed_check_not_a_crash(self):
        with TempDir() as tmp:
            res = R.run_all(["sleep 5"], tmp, [], wall=1)
            self.assertEqual(res[0]["code"], R.EXIT_WALL)
            self.assertIn("wall clock", res[0]["output"])

    def test_trim_keeps_tail(self):
        r = R.trim([{"cmd": "c", "code": 1, "output": "x" * (R.TAIL_CHARS + 50)}])[0]
        self.assertEqual(len(r["output"]), R.TAIL_CHARS + 1)
        self.assertTrue(r["output"].startswith("…"))


if __name__ == "__main__":
    unittest.main()
