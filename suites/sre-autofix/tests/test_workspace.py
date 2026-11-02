import os
import unittest

from helpers import INCIDENT, TempDir, apply_shipped_diff, make_temp_repo, write, write_outputs
from lib.common import SuiteError
from lib.workspace import Worktree, github_from_url


def mk(tmp):
    clone, origin = make_temp_repo(tmp)
    wt = Worktree(clone, os.path.join(tmp, "runs", INCIDENT, "worktree"), "autofix/" + INCIDENT,
                  os.path.join(tmp, "runs", INCIDENT, "git-exclude"))
    return wt, origin


class WorktreeTest(unittest.TestCase):
    def test_prepare_diff_apply_commit_push(self):
        with TempDir() as tmp:
            wt, origin = mk(tmp)
            ref, sha, note = wt.resolve_base_ref()
            self.assertEqual(ref, "refs/remotes/origin/main")
            self.assertEqual(note, "")
            self.assertEqual(wt.prepare(), "created")
            self.assertTrue(wt.is_our_worktree())
            self.assertEqual(wt.head_sha(), sha)
            self.assertEqual(wt.diff(), "")
            apply_shipped_diff(wt.dir)
            write_outputs(wt.dir)
            wt.write_file("INCIDENT.md", "# INCIDENT x\n")
            diff = wt.diff()
            self.assertIn("+++ b/app/service/ExampleSrv.php", diff)
            self.assertEqual(wt.changed_files(), ["app/service/ExampleSrv.php"])
            self.assertEqual(wt.untracked(), [])  # scaffold excluded via core.excludesFile
            ok, why = wt.apply_check_reverse(diff)
            self.assertTrue(ok, why)
            ok, why = wt.apply_check_reverse(diff.replace("return false;", "return null;", 1))
            self.assertFalse(ok)
            self.assertFalse(wt.apply_check_reverse("")[0])
            sha2 = wt.commit_only(["app/service/ExampleSrv.php"], "fix\n\nFiles: x\n")
            self.assertEqual(wt.committed_files(), ["app/service/ExampleSrv.php"])
            self.assertEqual(wt.commits_since_base(), [sha2])
            self.assertEqual(wt.remote_head(), "")
            wt.push()
            self.assertEqual(wt.remote_head(), sha2)
            self.assertTrue(os.path.exists(os.path.join(wt.dir, "FIXNOTES.md")))
            wt.reset()
            self.assertEqual(wt.diff(), "")
            self.assertFalse(os.path.exists(os.path.join(wt.dir, "FIXNOTES.md")))
            self.assertFalse(os.path.exists(os.path.join(wt.dir, ".sre-evidence")))
            self.assertTrue(os.path.exists(os.path.join(wt.dir, "INCIDENT.md")))
            self.assertEqual(wt.prepare(), "reused")
            wt.release()
            self.assertFalse(os.path.isdir(wt.dir))
            self.assertFalse(wt.branch_exists())

    def test_refuses_foreign_dir_and_existing_branch(self):
        with TempDir() as tmp:
            wt, _ = mk(tmp)
            wt.resolve_base_ref()
            write(os.path.join(wt.dir, "stray.txt"), "x")
            with self.assertRaises(SuiteError):
                wt.prepare()
            os.unlink(os.path.join(wt.dir, "stray.txt"))
            os.rmdir(wt.dir)
            wt.git_out(["branch", wt.branch, wt.base_sha], cwd=wt.repo_dir)
            with self.assertRaises(SuiteError):
                wt.prepare()
            self.assertEqual(wt.prepare(allow_existing_branch=True), "created")

    def test_base_reads_and_fallback(self):
        with TempDir() as tmp:
            wt, _ = mk(tmp)
            wt.resolve_base_ref()
            self.assertIn("app/service/ExampleSrv.php", wt.list_files_at_base())
            self.assertIn("^7.2", wt.read_file_at_base("composer.json"))
            self.assertEqual(wt.read_file_at_base("nope.txt"), "")
            wt.git_out(["update-ref", "-d", "refs/remotes/origin/main"], cwd=wt.repo_dir)
            wt.base_ref = ""
            ref, _, note = wt.resolve_base_ref()
            self.assertEqual(ref, "refs/heads/main")
            self.assertIn("本地分支", note)
            self.assertEqual(github_from_url("git@github.com:o/r.git"), "o/r")
            self.assertEqual(github_from_url("https://github.com/o/r"), "o/r")
            self.assertEqual(github_from_url(wt.remote_url()), "")


if __name__ == "__main__":
    unittest.main()
