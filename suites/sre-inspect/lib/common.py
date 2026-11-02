"""Shared primitives for suites/sre-inspect (python3 stdlib only).

Same discipline as suites/sre-autofix/lib/common.py: subprocesses never go through a shell, secrets
never ride on argv, every command has a wall clock. File helpers write atomically.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

DEFAULT_WALL = 60
EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_NOTHING, EXIT_FAILED, EXIT_BLOCKED = 0, 1, 2, 3, 4, 5
_SHELL_META = set(" \t\n|&;<>()$`")
_DUR = re.compile(r"^\s*(\d+)\s*([smhd])\s*$")
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400}


class SuiteError(Exception):
    """A user-facing failure with a process exit code."""

    def __init__(self, message, code=EXIT_ERROR):
        super().__init__(message)
        self.code = code


def require_python():
    if sys.version_info < (3, 8):
        raise SuiteError("suites/sre-inspect needs python3 >= 3.8 (found %d.%d)" % sys.version_info[:2])


class Result:
    __slots__ = ("stdout", "stderr", "code", "duration")

    def __init__(self, stdout, stderr, code, duration):
        self.stdout, self.stderr, self.code, self.duration = stdout, stderr, code, duration


def run(argv, cwd=None, env=None, stdin=None, wall=DEFAULT_WALL):
    """Run argv without a shell. Non-zero exit comes back in Result; failing to start or overrunning
    the wall clock raises SuiteError."""
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
        proc = subprocess.run(list(argv), cwd=cwd, env=full_env,
                              input=stdin.encode("utf-8") if isinstance(stdin, str) else stdin,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=wall)
    except FileNotFoundError as e:
        raise SuiteError("cannot start %s: %s" % (argv[0], e))
    except subprocess.TimeoutExpired:
        raise SuiteError("%s exceeded the %ss wall clock and was killed" % (argv[0], wall))
    return Result(proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace"),
                  proc.returncode, time.monotonic() - start)


def which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def parse_duration(s, default=None):
    """'30m' / '14d' / '90s' / '2h' -> seconds. Integers are seconds."""
    if s is None or str(s).strip() == "":
        if default is not None:
            return default
        raise SuiteError("duration is required")
    if isinstance(s, (int, float)):
        return int(s)
    m = _DUR.match(str(s))
    if not m:
        if re.match(r"^\d+$", str(s).strip()):
            return int(str(s).strip())
        raise SuiteError("bad duration %r (use 30m, 2h, 14d, 90s)" % (s,))
    return int(m.group(1)) * _UNIT[m.group(2)]


def fmt_duration(sec):
    sec = int(sec)
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if sec % n == 0 and sec >= n:
            return "%d%s" % (sec // n, unit)
    return "%ds" % sec


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


def write_text(path, text, mode=None):
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_json(path, obj, mode=None):
    write_text(path, json.dumps(obj, ensure_ascii=False, indent=1) + "\n", mode=mode)


def append_jsonl(path, obj):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def first_line(s, limit=200):
    line = (s or "").strip().split("\n", 1)[0]
    return line[:limit] + "…" if len(line) > limit else line


def one_line(s, limit=300):
    s = " ".join((s or "").replace("\n", " ").split()).replace("|", "\\|")
    return s[:limit] + "…" if len(s) > limit else s


def short_hash(s, n=8):
    import hashlib
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:n]
