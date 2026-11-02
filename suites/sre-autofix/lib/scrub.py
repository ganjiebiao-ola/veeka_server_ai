"""Deterministic redaction — port of ola-sre-agent orchestrator/internal/egress/egress.go:20-105.

Secret patterns block outbound text (PR bodies) and fail the gate when found in a diff; PII patterns
only redact. Pattern literals are written so that scripts/check-secret-scan never matches them.

The rule set is kept identical to the Go engine on purpose: this file is a hand-maintained port, and
it has already drifted once (argv-secret / keyed-secret, added upstream after a real AK leak, never
reached this copy). Any rule added here must be added there in the same change, and vice versa.

Replacement invariant: never introduce or remove a quote character. report.json is scrubbed as one
serialized blob and parsed back afterwards, and most model prose sits inside JSON strings — leaving
quotes alone keeps that structure intact. Key/value rules therefore keep the key (keep_prefix) and
replace only the value; swallowing the key would leave half a string literal behind.
"""
import re

SECRET_PATTERNS = [
    ("aliyun-ak-id", re.compile(r"LTAI[0-9A-Za-z]{12,24}"), False),
    ("aws-ak-id", re.compile(r"AKIA[0-9A-Z]{16}"), False),
    ("openai-style-key", re.compile(r"sk-[A-Za-z0-9_\-]{16,}"), False),
    ("github-token", re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"), False),
    ("github-fine-grained-pat", re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), False),
    ("git-url-credentials", re.compile(r"(?i)x-access-token:[^@\s\"']+"), False),
    ("slack-app-token", re.compile(r"xapp-[0-9]-[A-Za-z0-9]+-[0-9]+-[a-f0-9]+"), False),
    ("slack-bot-token", re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"), False),
    ("bearer", re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{20,}"), False),
    ("basic-auth", re.compile(r"(?i)basic\s+[A-Za-z0-9+/=]{20,}"), False),
    ("authorization-header", re.compile(r"(?i)(\"?authorization\"?\s*[:=]\s*\"?)[A-Za-z0-9+/=._\-]{20,}"), True),
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), False),
    # Bare secret shapes: an AK secret / API key has no recognisable prefix, so it can only be caught
    # by "parameter or key name + value". Upstream added these after a custom toolset put
    # --access-key-secret in argv and the agent echoed the expanded command into 25 archived files.
    # Values are ASCII-random only, so CJK prose is never mistaken for a key (which would block a
    # whole report).
    ("argv-secret", re.compile(
        r"(?i)(--(?:access-key-secret|secret(?:-key)?|client-secret|api-key|token|password)[= ]+)[A-Za-z0-9_\-+/=]{12,}"), True),
    ("keyed-secret", re.compile(
        r"(?i)((?:access[_-]?key[_-]?secret|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret"
        r"|api[_-]?key|password|passwd|token)[\"\']?\s*[:=]\s*[\"\']?)[A-Za-z0-9_\-+/=]{16,}"), True),
    # A JWT is a credential, not a hint of one: third-party sign-in id_token / client_secret land in
    # archived tool output verbatim. Three base64url segments starting with the "{\"" prefix.
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), False),
    ("cookie-header", re.compile(r"(?i)(\bcookie[\"\']?\s*[:=]\s*[\"\']?)[A-Za-z0-9%_\-=./+]{16,}"), True),
]

def _octets(m):
    """Four octets of a dotted quad, or None when any part is out of range (version strings)."""
    parts = m.split(".")
    if len(parts) != 4:
        return None
    try:
        o = [int(x) for x in parts]
    except ValueError:
        return None
    return o if all(0 <= x <= 255 for x in o) else None


_VERSION_CTX = re.compile(r"(?i)(?:version|ver|版本)[\s:=v]*$")


def keep_public_ip(m, before):
    """Redact end-user addresses only. A private/reserved address is internal topology, not personal
    data, and stripping it would cost the reader the host they need; a dotted quad right after
    "version=" is a version string (measured: 1 of 19 candidates in real archived reports)."""
    o = _octets(m)
    if o is None:
        return False
    if (o[0] in (0, 10, 127) or (o[0] == 172 and 16 <= o[1] <= 31) or (o[0] == 192 and o[1] == 168)
            or (o[0] == 169 and o[1] == 254) or (o[0] == 100 and 64 <= o[1] <= 127) or o[0] >= 224):
        return False
    return not _VERSION_CTX.search(before)


# (name, regex, keep) — keep is None to redact every match, else keep(match, text_before) decides.
PII_PATTERNS = [
    # Three shapes the original pattern missed, all present in real archived reports: the JSON form
    # ("userId": "…") needs the quote before the colon; a separator-less form (uid 824862702) needs
    # the colon to be optional; blid is this platform's own user id and was never in the word list.
    # \b after the name keeps "uid12345" (an identifier, not a value) out.
    ("uid", re.compile(r"(?i)(\b(?:uid|user_?id|memberid|blid)\b[\"\']?\s*[:=]?\s*[\"\']?)\d{5,}"), None, True),
    ("email", re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"), None, False),
    ("phone", re.compile(r"\b(?:\+?\d{1,3}[ \-]?)?1[3-9]\d{9}\b"), None, False),
    ("client-ip", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), keep_public_ip, False),
]


def mask(s):
    if len(s) <= 8:
        return "*" * len(s)
    return s[:4] + "*" * 6 + s[-2:]


def scrub(text, extra_secrets=()):
    """Return (redacted_text, findings). findings: [{kind, name, sample, blocked}]."""
    findings = []
    out = text or ""
    for s in extra_secrets or ():
        s = (s or "").strip()
        if len(s) < 12:
            continue
        if s in out:
            out = out.replace(s, "«已脱敏:配置值»")
            findings.append({"kind": "secret", "name": "env-exact-match", "sample": mask(s), "blocked": True})
    for name, rx, keep_prefix in SECRET_PATTERNS:
        for m in rx.finditer(out):
            findings.append({"kind": "secret", "name": name, "sample": mask(m.group(0)), "blocked": True})
        out = rx.sub((r"\1" if keep_prefix else "") + "«已脱敏:" + name + "»", out)
    for name, rx, keep, keep_prefix in PII_PATTERNS:
        repl = (r"\1" if keep_prefix else "") + "«已脱敏:" + name + "·请用查询式引用»"
        if keep is None:
            for m in rx.finditer(out):
                findings.append({"kind": "pii", "name": name, "sample": mask(m.group(0)), "blocked": False})
            out = rx.sub(repl, out)
            continue
        # Conditional patterns are rebuilt by hand: the predicate needs the text before the match,
        # which sub()/RE2 cannot supply (Go has no lookbehind either — both ports do it this way).
        assert not keep_prefix, "keep 与 keep_prefix 未同时支持（当前无此组合）"
        pieces, last = [], 0
        for m in rx.finditer(out):
            if not keep(m.group(0), out[max(0, m.start() - 40):m.start()]):
                continue
            findings.append({"kind": "pii", "name": name, "sample": mask(m.group(0)), "blocked": False})
            pieces.append(out[last:m.start()])
            pieces.append(repl)
            last = m.end()
        if pieces:
            pieces.append(out[last:])
            out = "".join(pieces)
    return out, findings


def scan_secrets(text, extra_secrets=()):
    """Gate check 3 (fixgate.go scanSecrets): secret-kind findings only, one entry per pattern."""
    _, findings = scrub(text, extra_secrets)
    hits, seen = [], set()
    for f in findings:
        if f["kind"] != "secret" or f["name"] in seen:
            continue
        seen.add(f["name"])
        hits.append(f["name"] + "（样本 " + f["sample"] + "）")
    return hits


def load_extra_secrets(path):
    """Exact-match values for the gate/PR scrub, one per line, from a file named by the operator
    (never from the repo). Missing file → empty."""
    if not path:
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return [l.strip() for l in f if l.strip() and not l.startswith("#")]
    except FileNotFoundError:
        return []
