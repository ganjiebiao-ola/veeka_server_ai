"""Shared primitives for suites/sre-autofix (python3 stdlib only).

Ports the discipline of ola-sre-agent orchestrator/internal/runcmd/runcmd.go: subprocesses never go
through a shell, credentials never appear on argv (git/gh use the operator's own helpers), every
command has a wall clock, and all captured output is scrubbed before it is logged or archived.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

from . import scrub as _scrub

DEFAULT_WALL = 30
INCIDENT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
_SHELL_META = set(" \t\n|&;<>()$`")


class SuiteError(Exception):
    """A user-facing failure with a process exit code (see cli.py for the code table)."""

    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


def require_python():
    if sys.version_info < (3, 8):
        raise SuiteError("suites/sre-autofix needs python3 >= 3.8 (found %d.%d)" % sys.version_info[:2])


class Result:
    __slots__ = ("stdout", "stderr", "code", "duration")

    def __init__(self, stdout, stderr, code, duration):
        self.stdout, self.stderr, self.code, self.duration = stdout, stderr, code, duration


def run(argv, cwd=None, env=None, stdin=None, wall=DEFAULT_WALL, extra_secrets=()):
    """Run argv (no shell). Non-zero exit is returned in Result, not raised; only failing to start
    or exceeding the wall clock raises SuiteError. stdout/stderr come back scrubbed."""
    if not argv:
        raise SuiteError("run(): empty argv")
    if any(ch in _SHELL_META for ch in argv[0]):
        raise SuiteError("run(): argv[0] contains shell metacharacters, refused: %r" % argv[0])
    full_env = None
    if env:
        full_env = dict(os.environ)
        full_env.update(env)
    start = time.monotonic()
    try:
        proc = subprocess.run(
            list(argv), cwd=cwd, env=full_env,
            input=stdin.encode("utf-8") if isinstance(stdin, str) else stdin,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=wall,
        )
    except FileNotFoundError as e:
        raise SuiteError("cannot start %s: %s" % (argv[0], e))
    except subprocess.TimeoutExpired:
        raise SuiteError("%s exceeded the %ss wall clock and was killed" % (argv[0], wall))
    dur = time.monotonic() - start
    out = _scrub.scrub(proc.stdout.decode("utf-8", "replace"), extra_secrets)[0]
    err = _scrub.scrub(proc.stderr.decode("utf-8", "replace"), extra_secrets)[0]
    return Result(out, err, proc.returncode, dur)


def output(argv, **kw):
    """run() and require exit 0; the first stderr line rides along in the error."""
    res = run(argv, **kw)
    if res.code != 0:
        raise SuiteError("%s exited %d: %s" % (" ".join(argv[:3]), res.code, first_line(res.stderr)))
    return res.stdout


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def check_incident_id(s):
    s = (s or "").strip()
    if not INCIDENT_ID_RE.match(s):
        raise SuiteError("invalid incident id %r (allowed: [A-Za-z0-9][A-Za-z0-9._-]{0,80})" % s, 2)
    return s


def read_text(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return default


def read_json(path, default=None):
    text = read_text(path)
    if text is None:
        return default
    return json.loads(text)


def write_text(path, text):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_json(path, obj):
    write_text(path, json.dumps(obj, ensure_ascii=False, indent=1) + "\n")


def append_jsonl(path, obj):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def read_jsonl(path):
    text = read_text(path, "")
    out = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def first_line(s, limit=200):
    line = (s or "").strip().split("\n", 1)[0]
    return line[:limit] + "…" if len(line) > limit else line


def one_line(s, limit=300):
    """Markdown-table-safe single line (egress.go oneLine)."""
    s = (s or "").strip().replace("\n", " ").replace("|", "\\|")
    return s[:limit] + "…" if len(s) > limit else s


def one_line_trim(s, limit):
    """Whitespace-collapsed single line, trimmed to `limit` characters (fixleg.go oneLineTrim)."""
    s = " ".join((s or "").replace("\n", " ").split())
    return s[:limit] + "…" if len(s) > limit else s


def nz(s, fallback):
    s = (s or "").strip()
    return fallback if s == "" or s.lower() == "none" else s


def workspace_sha(root):
    res = run(["git", "-C", root, "rev-parse", "HEAD"])
    return res.stdout.strip() if res.code == 0 else "0" * 40


def split_lines(s):
    return [l.strip() for l in (s or "").split("\n") if l.strip()]
