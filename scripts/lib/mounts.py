"""Read the workspace's line-oriented repositories sidecar without loading other local settings."""
import pathlib
import re
import shlex


def registered_repos(root):
    root = pathlib.Path(root)
    sidecar = root / "workspace.local.yaml"
    if not sidecar.exists():
        return {}
    repos, current, in_block = {}, None, False
    for line in sidecar.read_text().splitlines():
        if re.match(r"^repositories:\s*(?:#.*)?$", line):
            in_block = True
            continue
        if in_block and re.match(r"^[A-Za-z_]", line):
            break
        if not in_block:
            continue
        match = re.match(r"^\s*(?:-\s*id|path):\s*(.*)$", line)
        if not match:
            continue
        try:
            value = " ".join(shlex.split(match.group(1), comments=True))
        except ValueError:
            value = ""
        if line.lstrip().startswith("-"):
            current = value if re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", value) else None
            if current:
                repos[current] = root / "repos" / current
        elif current and value:
            repos[current] = root / pathlib.Path(value).expanduser()
    return repos
