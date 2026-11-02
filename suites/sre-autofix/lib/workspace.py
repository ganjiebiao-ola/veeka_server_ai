"""git worktree manager over a mounted business repo (repos/<id>) — local port of
orchestrator/internal/workspace/workspace.go.

Differences from upstream on purpose: no bare mirror (the mounted clone is the common dir), no bot
identity (the operator's own git config commits), no token plumbing (git uses the operator's own
credential helper), and the scaffold exclusion is passed per call as `-c core.excludesFile=<file>`
instead of being written into the shared info/exclude of the mount.
"""
import os
import re

from .common import SuiteError, output, run, split_lines

SCAFFOLD_CLEAN = ["FIXNOTES.md", ".sre-evidence"]
GITHUB_URL_RE = re.compile(r"(?:github\.com[:/])([^/\s]+)/([^/\s]+?)(?:\.git)?/?$")


class Worktree:
    def __init__(self, repo_dir, worktree_dir, branch, exclude_file, remote="origin", base="main",
                 scaffold=None, extra_secrets=()):
        self.repo_dir = os.path.abspath(repo_dir)
        self.dir = os.path.abspath(worktree_dir)
        self.branch = branch
        self.exclude_file = os.path.abspath(exclude_file)
        self.remote, self.base = remote, base
        self.scaffold = list(scaffold or ["INCIDENT.md", "FIXNOTES.md", ".sre-evidence/"])
        self.extra_secrets = extra_secrets
        self.base_ref = ""
        self.base_sha = ""
        self._files_cache = {}

    # ---- plumbing ----
    def _argv(self, args):
        return ["git", "-c", "core.excludesFile=" + self.exclude_file] + list(args)

    def git(self, args, cwd=None, wall=30, env=None, stdin=None):
        return run(self._argv(args), cwd=cwd or self.dir, wall=wall, env=env, stdin=stdin,
                   extra_secrets=self.extra_secrets)

    def git_out(self, args, cwd=None, wall=30, env=None):
        return output(self._argv(args), cwd=cwd or self.dir, wall=wall, env=env,
                      extra_secrets=self.extra_secrets)

    def repo_git_out(self, args, wall=30, env=None):
        return self.git_out(args, cwd=self.repo_dir, wall=wall, env=env)

    def write_exclude(self):
        os.makedirs(os.path.dirname(self.exclude_file), exist_ok=True)
        with open(self.exclude_file, "w", encoding="utf-8") as f:
            f.write("# suites/sre-autofix: handoff scaffold — stays in the worktree, never enters a commit\n")
            for s in self.scaffold:
                f.write(s + "\n")

    # ---- base ----
    def fetch_base(self):
        return self.repo_git_out(["fetch", self.remote, self.base], wall=300, env={"GIT_TERMINAL_PROMPT": "0"})

    def resolve_base_ref(self):
        """Prefer the remote-tracking ref; fall back to the local branch with a degradation note."""
        for ref, note in (("refs/remotes/%s/%s" % (self.remote, self.base), ""),
                          ("refs/heads/%s" % self.base, "基线取自本地分支 %s（远端跟踪分支不可用，未 fetch）" % self.base)):
            res = self.git(["rev-parse", "--verify", "--quiet", ref + "^{commit}"], cwd=self.repo_dir)
            if res.code == 0 and res.stdout.strip():
                self.base_ref, self.base_sha = ref, res.stdout.strip()
                return ref, self.base_sha, note
        raise SuiteError("cannot resolve base %s in %s (neither refs/remotes/%s/%s nor refs/heads/%s)"
                         % (self.base, self.repo_dir, self.remote, self.base, self.base))

    def branch_exists(self):
        return self.git(["show-ref", "--verify", "--quiet", "refs/heads/" + self.branch], cwd=self.repo_dir).code == 0

    def is_our_worktree(self):
        """True when self.dir is a worktree whose common dir is this mounted repo's .git."""
        res = self.git(["rev-parse", "--git-common-dir"], cwd=self.dir)
        if res.code != 0:
            return False
        common = res.stdout.strip()
        if not os.path.isabs(common):
            common = os.path.join(self.dir, common)
        want = self.repo_dir if os.path.isfile(os.path.join(self.repo_dir, ".git")) else os.path.join(self.repo_dir, ".git")
        return os.path.realpath(common) == os.path.realpath(want)

    def prepare(self, allow_existing_branch=False):
        """Create (or reuse) the worktree on a fresh autofix/<id> branch at base_ref."""
        if not self.base_ref:
            self.resolve_base_ref()
        self.write_exclude()
        self.git(["worktree", "prune"], cwd=self.repo_dir)
        if os.path.isdir(self.dir) and os.listdir(self.dir):
            if not self.is_our_worktree():
                raise SuiteError("目录 %s 已存在但不是 %s 的 worktree；不在它上面继续。请人工确认后移走：mv %s %s.bak"
                                 % (self.dir, self.repo_dir, self.dir, self.dir))
            return "reused"
        if self.branch_exists() and not allow_existing_branch:
            raise SuiteError("分支 %s 已存在于 %s 但不是本 suite 记录的现场——不用 -B 覆盖。请人工确认后删除："
                             "git -C %s branch -D %s" % (self.branch, self.repo_dir, self.repo_dir, self.branch))
        os.makedirs(os.path.dirname(self.dir), exist_ok=True)
        args = ["worktree", "add"]
        args += (["-B"] if allow_existing_branch else ["-b"]) + [self.branch, self.dir, self.base_ref]
        self.git_out(args, cwd=self.repo_dir, wall=300)
        return "created"

    # ---- harvest ----
    def head_sha(self):
        return self.git_out(["rev-parse", "HEAD"]).strip()

    def diff(self):
        return self.git_out(["diff"], wall=60)

    def diff_committed(self):
        return self.git_out(["diff", self.base_sha, "HEAD"], wall=60)

    def changed_files(self):
        return split_lines(self.git_out(["diff", "--name-only"]))

    def untracked(self):
        return split_lines(self.git_out(["ls-files", "--others", "--exclude-standard"]))

    def apply_check_reverse(self, patch):
        if not (patch or "").strip():
            return False, "补丁为空"
        res = self.git(["apply", "--check", "--reverse", "-"], stdin=patch, wall=60)
        if res.code != 0:
            return False, res.stderr.strip() or "git apply --check --reverse 非零退出"
        return True, ""

    def read_file(self, rel):
        p = os.path.join(self.dir, rel)
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except FileNotFoundError:
            return None

    def write_file(self, rel, content):
        p = os.path.join(self.dir, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)

    # ---- commit / push ----
    def identity(self):
        name = self.git(["config", "user.name"]).stdout.strip()
        email = self.git(["config", "user.email"]).stdout.strip()
        return name, email

    def commit_only(self, files, message, no_verify=False):
        if not files:
            raise SuiteError("没有要提交的文件")
        args = ["commit", "--only"] + (["--no-verify"] if no_verify else []) + ["-m", message, "--"] + list(files)
        self.git_out(args, wall=120)
        return self.head_sha()

    def committed_files(self):
        return split_lines(self.git_out(["show", "--name-only", "--format=", "HEAD"]))

    def commits_since_base(self):
        return split_lines(self.git_out(["rev-list", "%s..HEAD" % self.base_sha]))

    def remote_head(self):
        out = self.git_out(["ls-remote", self.remote, "refs/heads/" + self.branch], wall=60,
                           env={"GIT_TERMINAL_PROMPT": "0"})
        parts = out.strip().split()
        return parts[0] if parts else ""

    def push(self):
        return self.git_out(["push", self.remote, "%s:%s" % (self.branch, self.branch)], wall=300,
                            env={"GIT_TERMINAL_PROMPT": "0"})

    def remote_url(self):
        res = self.git(["remote", "get-url", self.remote], cwd=self.repo_dir)
        return res.stdout.strip() if res.code == 0 else ""

    def github_repo(self):
        m = GITHUB_URL_RE.search(self.remote_url())
        return "%s/%s" % (m.group(1), m.group(2)) if m else ""

    # ---- reset / release ----
    def reset(self):
        self.git_out(["reset", "--hard", self.base_sha])
        self.git_out(["clean", "-fd"])
        for p in SCAFFOLD_CLEAN:
            full = os.path.join(self.dir, p)
            if os.path.isdir(full):
                import shutil
                shutil.rmtree(full)
            elif os.path.exists(full):
                os.unlink(full)

    def release(self):
        if os.path.isdir(self.dir):
            if not self.is_our_worktree():
                raise SuiteError("%s 不是本 suite 的 worktree，拒绝删除" % self.dir)
            self.git_out(["worktree", "remove", "--force", self.dir], cwd=self.repo_dir, wall=120)
        self.git(["worktree", "prune"], cwd=self.repo_dir)
        res = self.git(["branch", "-D", self.branch], cwd=self.repo_dir)
        return res.code == 0

    # ---- base tree reads (no worktree needed) ----
    def list_files_at_base(self):
        ref = self.base_ref or self.resolve_base_ref()[0]
        if ref not in self._files_cache:
            self._files_cache[ref] = split_lines(self.git_out(["ls-tree", "-r", "--name-only", ref], cwd=self.repo_dir, wall=120))
        return self._files_cache[ref]

    def read_file_at_base(self, rel):
        ref = self.base_ref or self.resolve_base_ref()[0]
        res = self.git(["show", "%s:%s" % (ref, rel)], cwd=self.repo_dir, wall=60)
        return res.stdout if res.code == 0 else ""


def match_basename(files, basename):
    return [f for f in files if os.path.basename(f) == basename]


def github_from_url(url):
    m = GITHUB_URL_RE.search(url or "")
    return "%s/%s" % (m.group(1), m.group(2)) if m else ""
