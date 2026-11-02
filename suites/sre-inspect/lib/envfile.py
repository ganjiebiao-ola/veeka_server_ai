"""KEY=VALUE env files (the suite's credential carrier: env/.env.holmes, gitignored, 0600).

Values are never printed by anything in this suite; `describe()` only reports presence and length.
"""
import os
import re
import stat

_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
REQUIRED = ("GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN")
OPTIONAL = ("GRAFANA_ORG_ID", "MCP_GRAFANA_SERVER_TOKEN", "HOLMES_API_KEY", "OPENAI_API_KEY")


def parse(text):
    out = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _LINE.match(line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if val and val[0] in "\"'":
            q = val[0]
            end = val.find(q, 1)
            val = val[1:end] if end > 0 else val[1:]      # quoted value; anything after the closing quote is a comment
        elif " #" in val:
            val = val.split(" #", 1)[0].rstrip()
        if val.startswith("<") and val.endswith(">"):
            val = ""                       # <placeholder> from the .example counts as unset
        out[key] = val
    return out


def load(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return parse(f.read())
    except FileNotFoundError:
        return {}


def apply(values, env=None, override=False):
    env = os.environ if env is None else env
    for k, v in values.items():
        if override or not env.get(k):
            env[k] = v
    return env


def mode_ok(path):
    """True when the file is not readable by group/other (0600 or 0400)."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return False
    return (st.st_mode & (stat.S_IRWXG | stat.S_IRWXO)) == 0


def describe(values):
    """Presence-only view for doctor output — never the values."""
    out = {}
    for k in REQUIRED + OPTIONAL:
        v = values.get(k, "")
        out[k] = ("set (%d chars)" % len(v)) if v else "missing"
    return out
