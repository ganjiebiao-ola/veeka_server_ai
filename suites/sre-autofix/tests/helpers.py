"""Test helpers: throwaway git repos with a file:// remote, and a fake workspace root."""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SUITE = os.path.dirname(HERE)
REAL_ROOT = os.path.dirname(os.path.dirname(SUITE))
FIXTURES = os.path.join(HERE, "fixtures")
INCIDENT = "INC-20260101-000000-deadbeef"
REPO_ID = "demo-repo"

sys.path.insert(0, SUITE)


def git(args, cwd, check=True):
    env = dict(os.environ)
    env.update({"GIT_AUTHOR_NAME": "Test User", "GIT_AUTHOR_EMAIL": "test@example.invalid",
                "GIT_COMMITTER_NAME": "Test User", "GIT_COMMITTER_EMAIL": "test@example.invalid",
                "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
                "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"})
    return subprocess.run(["git"] + list(args), cwd=cwd, env=env, check=check, capture_output=True, text=True)


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def make_temp_repo(tmp):
    """Seed → local clone at <tmp>/repos/demo-repo with a bare file:// origin at <tmp>/origin.git.
    Returns (clone_dir, origin_dir)."""
    seed = os.path.join(tmp, "seed")
    shutil.copytree(os.path.join(FIXTURES, "repo-seed"), seed)
    r = git(["init", "-q", "-b", "main"], seed, check=False)
    if r.returncode != 0:  # git < 2.28
        git(["init", "-q"], seed)
        git(["checkout", "-q", "-b", "main"], seed)
    git(["add", "-A"], seed)
    git(["commit", "-q", "-m", "seed"], seed)
    origin = os.path.join(tmp, "origin.git")
    git(["clone", "-q", "--bare", seed, origin], tmp)
    clone = os.path.join(tmp, "repos", REPO_ID)
    os.makedirs(os.path.dirname(clone), exist_ok=True)
    git(["clone", "-q", origin, clone], tmp)
    git(["config", "user.name", "Test User"], clone)
    git(["config", "user.email", "test@example.invalid"], clone)
    git(["fetch", "-q", "origin", "main"], clone)
    return clone, origin


def make_fake_workspace(tmp, scope="app/", github="example-org/demo-repo", with_repo=True):
    """A minimal workspace root: workspace.yaml (demo-repo registered), harness.sh, the real
    incident-fix skill (contract source), a config.yaml naming demo-repo, and a mounted clone."""
    root = os.path.join(tmp, "ws")
    os.makedirs(root)
    write(os.path.join(root, "workspace.yaml"),
          "owner: Tester\nteam: test\nrepositories:\n  - id: %s\n    path: repos/%s\nagent_suites: []\n"
          "required_local_permissions: []\nknown_limitations: []\n" % (REPO_ID, REPO_ID))
    os.makedirs(os.path.join(root, "scripts", "lib"))
    shutil.copy(os.path.join(REAL_ROOT, "scripts", "lib", "harness.sh"), os.path.join(root, "scripts", "lib", "harness.sh"))
    shutil.copytree(os.path.join(REAL_ROOT, "skills", "incident-fix"), os.path.join(root, "skills", "incident-fix"))
    write(os.path.join(root, "suites", "sre-autofix", "config.yaml"),
          "version: 1\nmin_confidence: medium\nscaffold: [INCIDENT.md, FIXNOTES.md, .sre-evidence/]\nrepos:\n"
          "  - id: %s\n    scope: [%s]\n    base: main\n    remote: origin\n    github: \"%s\"\n"
          "headless:\n  agent: auto\n  model: \"\"\n  max_budget_usd: 1\n  wall_sec: 30\n  retries: 1\n  command: []\n"
          % (REPO_ID, scope, github))
    clone = origin = None
    if with_repo:
        clone, origin = make_temp_repo(tmp)
        os.makedirs(os.path.join(root, "repos"), exist_ok=True)
        shutil.move(clone, os.path.join(root, "repos", REPO_ID))
        clone = os.path.join(root, "repos", REPO_ID)
    return root, clone, origin


def assemble_archive(tmp, draft="draft-code-defect.json", name=INCIDENT):
    d = os.path.join(tmp, "archive", name)
    os.makedirs(d)
    shutil.copy(os.path.join(FIXTURES, draft), os.path.join(d, "bugissue-draft.json"))
    for f in ("issue.draft.md", "alert.json", "route.json", "state.json"):
        shutil.copy(os.path.join(FIXTURES, f), os.path.join(d, f))
    return d


def shipped_config():
    """The suite's config.yaml as COMMITTED (git HEAD) — the operator fills the on-disk copy with real
    repo ids, so tests about the shipped all-TODO template must not read the working tree."""
    r = subprocess.run(["git", "-C", SUITE, "show", "HEAD:suites/sre-autofix/config.yaml"],
                       capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        return r.stdout
    return read(os.path.join(SUITE, "config.yaml"))   # not a git checkout: fall back to the file


def run_cli(root, *args, env=None):
    e = dict(os.environ)
    e["PYTHONDONTWRITEBYTECODE"] = "1"
    if env:
        e.update(env)
    # start_new_session: detach from the controlling terminal so scripts/lib/harness.sh sees no /dev/tty
    # and fail-safe blocks — on a developer's Mac the test would otherwise prompt for a human-id
    p = subprocess.run([sys.executable, os.path.join(SUITE, "lib", "cli.py"), "--root", root] + list(args),
                       capture_output=True, text=True, env=e, stdin=subprocess.DEVNULL, start_new_session=True)
    return p.returncode, p.stdout, p.stderr


def apply_shipped_diff(worktree):
    subprocess.run(["git", "apply", os.path.join(FIXTURES, "shipped.diff")], cwd=worktree, check=True)


def write_outputs(worktree, verification="verification-shipped.json"):
    write(os.path.join(worktree, "FIXNOTES.md"), read(os.path.join(FIXTURES, "fixnotes-sample.md")))
    write(os.path.join(worktree, ".sre-evidence", "verification.json"), read(os.path.join(FIXTURES, verification)))


class TempDir:
    def __enter__(self):
        self.path = tempfile.mkdtemp(prefix="sre-autofix-test-")
        return self.path

    def __exit__(self, *a):
        shutil.rmtree(self.path, ignore_errors=True)
