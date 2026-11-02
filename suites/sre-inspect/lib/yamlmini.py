"""Hand-walked YAML subset — copied from suites/sre-autofix/lib/config.py (parse_simple_yaml) and
extended with inline flow maps `{a: b, c: d}`. Shapes supported: top-level scalars, `key: value`,
nested maps by indentation, `- item` lists, lists of maps (first key on the `- ` line), inline
`[a, b]` lists and `{k: v}` maps, `# comments`. No anchors, no block scalars, no multi-line strings.
tenant.yaml / routes.yaml are written against exactly this subset (see tenant.yaml.example).
"""
import re


def _unquote(s):
    s = s.strip()
    if len(s) >= 2 and s[0] in "\"'" and s[-1] == s[0]:
        return s[1:-1]
    if " #" in s:
        s = s.split(" #", 1)[0].rstrip()
    return s


def _split_top(s, sep=","):
    """Split on `sep` outside quotes/brackets."""
    out, buf, depth, quote = [], [], 0, None
    for ch in s:
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
            buf.append(ch)
        elif ch in "[{":
            depth += 1
            buf.append(ch)
        elif ch in "]}":
            depth -= 1
            buf.append(ch)
        elif ch == sep and depth == 0:
            out.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        out.append("".join(buf))
    return out


def _scalar(s):
    raw = s.strip()
    if raw and raw[0] in "\"'":
        end = raw.find(raw[0], 1)
        if end > 0:
            return raw[1:end]          # quoted scalar; anything after the closing quote (a comment) is dropped
    s = _unquote(s)
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        return [_scalar(x) for x in _split_top(inner) if x.strip()] if inner else []
    if s.startswith("{") and s.endswith("}"):
        inner = s[1:-1].strip()
        out = {}
        for part in _split_top(inner):
            if not part.strip():
                continue
            m = re.match(r"^\s*([A-Za-z_][\w.\-]*)\s*:\s*(.*)$", part)
            if m:
                out[m.group(1)] = _scalar(m.group(2))
        return out
    if s in ("true", "false"):
        return s == "true"
    if s in ("null", "~"):
        return None
    if re.match(r"^-?\d+$", s):
        return int(s)
    if re.match(r"^-?\d+\.\d+$", s):
        return float(s)
    return s


def parse(text):
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
                i += 1
                continue
            m = re.match(r"^([A-Za-z_][\w.\-]*):\s*(.*)$", content)
            if not m:
                i += 1
                continue
            key, val = m.group(1), m.group(2)
            if val == "" or val.startswith("#"):
                if i + 1 < len(lines) and lines[i + 1][0] > ind:
                    child, i = block(i + 1, lines[i + 1][0])
                elif i + 1 < len(lines) and lines[i + 1][0] == ind and lines[i + 1][1].startswith("- "):
                    child, i = lst(i + 1, ind)
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
            m = re.match(r"^([A-Za-z_][\w.\-]*):\s*(.*)$", item)
            if m and not item.startswith("{"):
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
