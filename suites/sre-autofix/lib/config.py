"""suite config (config.yaml) + the workspace's mounted-repo registry (workspace.yaml).

Zero-dependency: a small hand-walked YAML subset (top-level scalars, inline `[a, b]` lists, nested
maps by indentation, lists of maps) — the same shapes scripts/check-permissions and
scripts/check-asset-metadata already parse this way. The config file is operator-owned; entries that
still carry `TODO(owner)` are ignored at claim time and rejected only when a verb actually needs them.
"""
import os
import re

from .common import SuiteError, read_text

DEFAULT_CHECKS_WALL_SEC = 600   # per command, `config.yaml checks_wall_sec`
DEFAULT_SCAFFOLD = ["INCIDENT.md", "FIXNOTES.md", ".sre-evidence/"]
DEFAULT_HEADLESS = {
    "agent": "auto", "model": "", "max_budget_usd": 5, "wall_sec": 3600, "retries": 1, "command": [],
}


def _unquote(s):
    s = s.strip()
    if len(s) >= 2 and s[0] in "\"'" and s[-1] == s[0]:
        return s[1:-1]
    if " #" in s:
        s = s.split(" #", 1)[0].rstrip()
    return s


def _scalar(s):
    s = _unquote(s)
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        return [_unquote(x) for x in inner.split(",") if x.strip()] if inner else []
    if s in ("true", "false"):
        return s == "true"
    if re.match(r"^-?\d+$", s):
        return int(s)
    if re.match(r"^-?\d+\.\d+$", s):
        return float(s)
    return s


def parse_simple_yaml(text):
    lines = []
    for raw in (text or "").splitlines():
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        lines.append((len(raw) - len(raw.lstrip(" ")), raw.strip()))

    def block(i, indent):
        if i >= len(lines):
            return None, i
        if lines[i][1].startswith("- "):
            return lst(i, lines[i][0])
        return mp(i, indent)

    def mp(i, indent):
        out = {}
        while i < len(lines):
            ind, content = lines[i]
            if ind < indent or content.startswith("- "):
                break
            if ind > indent:
                i += 1  # stray deeper line without a parent key: skip defensively
                continue
            m = re.match(r"^([A-Za-z_][\w.-]*):\s*(.*)$", content)
            if not m:
                i += 1
                continue
            key, val = m.group(1), m.group(2)
            if val == "":
                if i + 1 < len(lines) and lines[i + 1][0] > ind:
                    child, i = block(i + 1, lines[i + 1][0])
                else:
                    child, i = {}, i + 1
                out[key] = child if child is not None else {}
            else:
                out[key] = _scalar(val)
                i += 1
        return out, i

    def lst(i, indent):
        out = []
        while i < len(lines):
            ind, content = lines[i]
            if ind != indent or not content.startswith("- "):
                break
            item = content[2:].strip()
            m = re.match(r"^([A-Za-z_][\w.-]*):\s*(.*)$", item)
            if m:
                # a map whose first key sits on the "- " line; continuation keys are indented deeper
                cont = lines[i + 1][0] if i + 1 < len(lines) and lines[i + 1][0] > ind and not lines[i + 1][1].startswith("- ") else ind + 2
                lines[i] = (cont, item)
                child, i = mp(i, cont)
                out.append(child)
            else:
                out.append(_scalar(item))
                i += 1
        return out, i

    obj, _ = block(0, lines[0][0] if lines else 0)
    return obj or {}


def is_placeholder(v):
    if isinstance(v, list):
        return any(is_placeholder(x) for x in v)
    return "TODO" in str(v or "")


class RepoCfg:
    def __init__(self, d):
        rid = d.get("id", "")
        self.id = rid.strip() if isinstance(rid, str) else ""   # a bare `id:` parses as an empty block
        scope = d.get("scope", [])
        self.scope = [str(s).strip() for s in (scope if isinstance(scope, list) else [scope]) if str(s).strip()]
        self.base = str(d.get("base", "main")).strip() or "main"
        self.remote = str(d.get("remote", "origin")).strip() or "origin"
        self.github = str(d.get("github", "")).strip()
        checks = d.get("checks", [])
        self.checks = [str(c).strip() for c in (checks if isinstance(checks, list) else [checks]) if str(c).strip()]

    def scope_ok(self):
        return bool(self.scope) and not is_placeholder(self.scope)

    def checks_configured(self):
        """Operator has listed real check commands (a TODO placeholder counts as not configured)."""
        return bool(self.checks) and not is_placeholder(self.checks)

    def as_dict(self):
        return {"id": self.id, "scope": self.scope, "base": self.base, "remote": self.remote, "github": self.github,
                "checks": self.checks}


class Config:
    def __init__(self, raw):
        self.raw = raw or {}
        self.min_confidence = str(self.raw.get("min_confidence", "medium")).strip().lower() or "medium"
        sc = self.raw.get("scaffold")
        self.scaffold = [str(s) for s in sc] if isinstance(sc, list) and sc else list(DEFAULT_SCAFFOLD)
        self.repos = [RepoCfg(r) for r in (self.raw.get("repos") or []) if isinstance(r, dict)]
        try:
            self.checks_wall_sec = int(self.raw.get("checks_wall_sec", DEFAULT_CHECKS_WALL_SEC)) or DEFAULT_CHECKS_WALL_SEC
        except (TypeError, ValueError):
            self.checks_wall_sec = DEFAULT_CHECKS_WALL_SEC
        hl = dict(DEFAULT_HEADLESS)
        hl.update({k: v for k, v in (self.raw.get("headless") or {}).items()})
        self.headless = hl

    def repo(self, repo_id):
        for r in self.repos:
            if r.id == repo_id:
                return r
        return None


LOCAL_CONFIG = "config.local.yaml"   # operator's copy, gitignored — wins over the tracked template


def config_path(root):
    """Resolution: $SRE_AUTOFIX_CONFIG → suites/sre-autofix/config.local.yaml (if present) → config.yaml.
    The tracked config.yaml is a template the framework keeps editing; an operator who fills it in gets
    a merge conflict on every pull (happened three times on the first real machine). config.local.yaml
    is theirs alone."""
    env = os.environ.get("SRE_AUTOFIX_CONFIG")
    if env:
        return env
    local = os.path.join(root, "suites", "sre-autofix", LOCAL_CONFIG)
    if os.path.isfile(local):
        return local
    return os.path.join(root, "suites", "sre-autofix", "config.yaml")


def config_source(root):
    """Short label for doctor: which file is in effect and why."""
    p = config_path(root)
    if os.environ.get("SRE_AUTOFIX_CONFIG"):
        return p, "from $SRE_AUTOFIX_CONFIG"
    if os.path.basename(p) == LOCAL_CONFIG:
        return p, "operator copy (gitignored; wins over config.yaml)"
    return p, "tracked template — copy it to %s and edit that, so `git pull` never conflicts with your edits" % LOCAL_CONFIG


def load(root, path=None):
    path = path or config_path(root)
    text = read_text(path)
    if text is None:
        raise SuiteError("config not found: %s" % path)
    return Config(parse_simple_yaml(text))


def load_workspace_repos(root):
    """workspace.yaml `repositories[] {id, path}` → {id: absolute path} (check-permissions walk)."""
    text = read_text(os.path.join(root, "workspace.yaml"))
    if text is None:
        raise SuiteError("workspace.yaml not found under %s — run from the workspace root" % root)
    entries, cur, in_block = [], None, False
    for raw in text.splitlines():
        if re.match(r"^repositories:\s*(\[\]\s*)?$", raw):
            in_block = True
            continue
        if not in_block:
            continue
        if re.match(r"^[A-Za-z_]", raw):
            break
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        m = re.match(r"^\s*-\s*(.*)$", raw)
        if m:
            if cur is not None:
                entries.append(cur)
            km = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", m.group(1))
            cur = {km.group(1): _unquote(km.group(2))} if km else {}
        else:
            km = re.match(r"^\s+([A-Za-z_][\w-]*):\s*(.*)$", raw)
            if km and cur is not None:
                cur[km.group(1)] = _unquote(km.group(2))
    if cur is not None:
        entries.append(cur)
    out = {}
    for e in entries:
        rid, path = e.get("id", "").strip(), e.get("path", "").strip()
        if rid and path:
            out[rid] = os.path.join(root, path)
    return out


def usable_repos(cfg, ws_repos):
    """Repos the suite may target: configured, not a placeholder, registered in workspace.yaml and
    actually mounted (repos/<id>/.git exists). Returns ([(RepoCfg, abs_path)], [notes])."""
    usable, notes = [], []
    for r in cfg.repos:
        if not r.id or is_placeholder(r.id):
            notes.append("config.yaml repos 条目仍是 TODO(owner) 占位，已忽略")
            continue
        if r.id not in ws_repos:
            notes.append("%s 未在 workspace.yaml repositories[] 注册，已忽略" % r.id)
            continue
        path = ws_repos[r.id]
        if not os.path.isdir(os.path.join(path, ".git")) and not os.path.isfile(os.path.join(path, ".git")):
            notes.append("%s 已注册但未挂载（%s 无 .git），已忽略" % (r.id, path))
            continue
        usable.append((r, path))
    return usable, notes
