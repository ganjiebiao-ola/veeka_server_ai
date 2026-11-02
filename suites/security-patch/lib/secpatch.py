"""Start the bundled security app and read its API through the suite entry point."""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import webbrowser
import urllib.parse
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_config(here=HERE):
    """config.local.yaml wins over config.yaml. Flat `key: value` lines only."""
    for name in ("config.local.yaml", "config.yaml"):
        path = os.path.join(here, name)
        if os.path.exists(path):
            config = {}
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or ":" not in line:
                        continue
                    key, value = line.split(":", 1)
                    config[key.strip()] = value.strip().strip('"').strip("'")
            return config
    return {}


def tool_url(config):
    url = config.get("tool_url", "")
    if not url or "TODO" in url or not url.startswith(("http://", "https://")):
        return None
    try:
        parsed = urllib.parse.urlsplit(url)
        if not parsed.hostname or parsed.port == 0 or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
            return None
        # Credentials and tokens must not enter browser links or diagnostics.
        if parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
            return None
    except ValueError:
        return None
    return url.rstrip("/")


def ui_url(config):
    return tool_url({"tool_url": config.get("ui_url", "http://localhost:32088")})


def call(url, path, method="GET", timeout=30):
    req = urllib.request.Request(url + path, method=method, data=b"" if method == "POST" else None,
                                 headers={"Accept": "application/json", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read())
            if not isinstance(body, dict):
                return 0, {"error": "backend returned invalid JSON object"}
            return r.status, body
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
            return e.code, body if isinstance(body, dict) else {}
        except ValueError:
            return e.code, {}
        finally:
            e.close()
    except (urllib.error.URLError, OSError):
        return 0, {"error": "backend unavailable. Run `suites/security-patch/run start`."}
    except ValueError:
        return 0, {"error": "backend returned invalid JSON"}


def doctor(url, out, here=HERE, ui="http://localhost:32088"):
    ok = True
    for name in ("bun", "jq", "docker", "gh", "claude", "lsof"):
        good = bool(shutil.which(name))
        out.write(f"[{'OK' if good else 'MISS'}] {name}\n")
        ok &= good
    for path in ("backend/cli/server.ts", "frontend/bun.lock", "scanner/bridge.mjs", "scripts/dev.sh", ".env"):
        good = os.path.isfile(os.path.join(here, "app", path))
        out.write(f"[{'OK' if good else 'MISS'}] bundled app/{path}\n")
        ok &= good
    try:
        good = subprocess.run(["docker", "info"], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        good = False
    out.write(f"[{'OK' if good else 'MISS'}] Docker daemon\n")
    ok &= good
    try:
        good = subprocess.run(["docker", "image", "inspect", "ola-agent-scanner:latest"],
                              capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        good = False
    out.write(f"[{'OK' if good else 'MISS'}] scanner image ola-agent-scanner:latest (run start builds it)\n")
    ok &= good
    if not ui:
        out.write("[MISS] ui_url: set it in suites/security-patch/config.local.yaml\n")
        ok = False
    else:
        try:
            with urllib.request.urlopen(ui, timeout=5) as response:
                good = response.status == 200
        except (OSError, ValueError, TypeError):
            good = False
        out.write(f"[{'OK' if good else 'MISS'}] UI at {ui}\n")
        ok &= good
    checked_ports = set()
    for endpoint in (url, ui):
        if not endpoint:
            continue
        parsed = urllib.parse.urlsplit(endpoint)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if port in checked_ports:
            continue
        checked_ports.add(port)
        try:
            owners = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"],
                                    capture_output=True, text=True, timeout=5)
            good = owners.returncode == 0
            processes = dict.fromkeys(tuple(line.split()[:2]) for line in owners.stdout.splitlines()[1:]
                                      if len(line.split()) >= 2)
            detail = ", ".join(f"{command} (pid {pid})" for command, pid in processes) if good else "no listener"
        except (OSError, subprocess.TimeoutExpired):
            good, detail = False, "lsof unavailable"
        out.write(f"[{'OK' if good else 'MISS'}] port {port} owners: {detail}\n")
        ok &= good
    if not url:
        out.write("[MISS] tool_url: set it in suites/security-patch/config.local.yaml\n")
        return 1
    status, body = call(url, "/api/health", timeout=5)
    good = status == 200 and body.get("status") == "ok"
    out.write(f"[{'OK' if good else 'MISS'}] codesec tool at {url}\n")
    ok &= good
    if status == 0:
        out.write(body["error"] + "\n")
    if good:
        ok &= posting_setup(url, out)
    gh = shutil.which("gh") and subprocess.run(["gh", "auth", "status"], capture_output=True).returncode == 0
    out.write(f"[{'OK' if gh else 'MISS'}] gh auth (the tool reads the tracker and PRs with the operator's gh login)\n")
    return 0 if ok and gh else 1


def posting_setup(url, out):
    """Rows for the settings the tool needs to post issues and push PRs. Read from the tool, which loads app/.env."""
    status, body = call(url, "/api/setup", timeout=10)
    if status != 200:
        out.write("[MISS] posting setup: the tool has no /api/setup. Restart it with the current app.\n")
        return False
    rows = [
        (body.get("githubLogin") is True, "tool GitHub login (gh auth or GH_TOKEN)"),
        (body.get("push") == "token", "PR push: token" if body.get("push") == "token" else
         "PR push: set GH_TOKEN in app/.env (a GitHub token with repo scope)"),
    ]
    for good, text in rows:
        out.write(f"[{'OK' if good else 'MISS'}] {text}\n")
    return all(good for good, _ in rows)


def service(argv, out, here):
    command = argv[0]
    if len(argv) > 1 and not (len(argv) == 2 and (
            command in ("start", "dev") and argv[1] in ("--auth=oauth", "--auth=settings") or
            command == "logs" and argv[1] == "--follow")):
        out.write(USAGE)
        return 2
    app = os.path.join(here, "app")
    script = os.path.join(app, "scripts", "dev.sh")
    if not os.path.isfile(script):
        out.write("bundled app is missing: sync the workspace template\n")
        return 1
    try:
        return subprocess.run(["bash", script, *argv], cwd=app).returncode
    except OSError:
        out.write("could not run the bundled app\n")
        return 1


def overview(url, out):
    status, body = call(url, "/api/overview")
    if status != 200:
        out.write(f"overview failed: {body.get('error', status)}\n")
        return 1
    out.write(f"Bug types in {body['repo']}:\n")
    for t in body["types"]:
        counts = ", ".join(f"{k} {v}" for k, v in t["counts"].items() if v)
        out.write(f"  {t['category']:<20} {t['total']:>4} rows  {counts}\n")
    out.write(f"Open suite PRs: {len(body['openPRs'])}\n")
    for pr in body["openPRs"]:
        out.write(f"  #{pr['number']} {pr['title']}{' (draft)' if pr['draft'] else ''}\n")
    out.write(f"Needs human: {len(body['needsHuman'])}\n")
    for row in body["needsHuman"]:
        out.write(f"  [{row['category']}] {row['file']}:{','.join(map(str, row['lines']))} — {row['reason']}\n")
    return 0


def pick(url, out, ui="http://localhost:32088"):
    status, body = call(url, "/api/pick")
    if status != 200:
        out.write(f"pick failed: {body.get('error', status)}\n")
        return 1
    suggested = set(body["suggestedIds"])
    out.write(f"{len(body['rows'])} candidate rows, {len(suggested)} suggested:\n")
    for row in body["rows"]:
        if row["id"] in suggested:
            out.write(f"  {row['severity'] or '--':<3} {row['category']:<16} {row['file']}:{','.join(map(str, row['lines']))}\n")
    out.write(f"Accept or edit the pick in the tool's Pick screen: {ui}\n")
    return 0


def run_status(url, run_id, out):
    status, body = call(url, f"/api/runs/{run_id}")
    if status != 200:
        out.write(f"status failed: {body.get('error', status)}\n")
        return 1
    out.write(f"{run_id}: {body.get('status')} {body.get('error') or ''}\n".rstrip() + "\n")
    return 0


def resume(url, run_id, out):
    status, body = call(url, f"/api/runs/{run_id}/resume", method="POST")
    if status != 201:
        out.write(f"resume refused: {body.get('error', status)}\n")
        return 1
    out.write(f"resumed as run {body['runId']}\n")
    return 0


def runs(url, out):
    status, body = call(url, "/api/runs")
    if status != 200:
        out.write(f"runs failed: {body.get('error', status)}\n")
        return 1
    for run in body["runs"]:
        out.write(f"#{run['runNumber']} {run['runId']}: {run['status']} {run.get('mode', '')} {run.get('repoUrl', '')}".rstrip() + "\n")
    return 0


def resolve_run_id(url, run_id, out):
    if not re.fullmatch(r"#?[0-9]+", run_id):
        return run_id
    number = int(run_id.lstrip("#"))
    offset = 0
    while True:
        status, body = call(url, f"/api/runs?limit=500&offset={offset}")
        if status != 200:
            out.write(f"run lookup failed: {body.get('error', status)}\n")
            return None
        rows = body["runs"]
        for run in rows:
            if run.get("runNumber") == number:
                return run["runId"]
        if len(rows) < body["limit"]:
            out.write(f"unknown run number #{number}\n")
            return None
        offset += len(rows)


def watch(url, run_id, out):
    previous = None
    while True:
        status, body = call(url, f"/api/runs/{run_id}")
        if status != 200:
            out.write(f"watch failed: {body.get('error', status)}\n")
            return 1
        current = (body.get("status"), body.get("error"))
        if current != previous:
            out.write(f"{run_id}: {current[0]} {current[1] or ''}".rstrip() + "\n")
            out.flush()
            previous = current
        if current[0] in ("completed", "failed", "stopped", "aborted"):
            return 0
        time.sleep(10)


def stop_run(url, run_id, out):
    status, body = call(url, f"/api/runs/{run_id}/stop", method="POST")
    if status != 200:
        out.write(f"stop refused: {body.get('error', status)}\n")
        return 1
    out.write(f"stop requested for run {run_id}\n")
    return 0


USAGE = "usage: run start [--auth=oauth|settings] | dev [--auth=oauth|settings] | stop [<run-id> --yes] | logs [--follow] | doctor | overview | pick | runs | watch <run-id> | open [run-id] | status [run-id] | resume <run-id> (run-id accepts UUID, 12 or '#12')\n"


def main(argv, out=sys.stdout, here=HERE):
    if not argv or argv[0] not in ("start", "dev", "stop", "logs", "doctor", "overview", "pick", "status", "resume", "runs", "watch", "open"):
        out.write(USAGE)
        return 2
    command = argv[0]
    if command in ("start", "dev", "logs") or argv in (["status"], ["stop"]):
        return service(argv, out, here)
    if command in ("doctor", "overview", "pick", "runs") or command == "open" and len(argv) == 1:
        valid = len(argv) == 1
    else:
        valid = len(argv) >= 2 and bool(argv[1]) and (re.fullmatch(r"#?[0-9]+", argv[1]) is not None or all(c.isalnum() or c in "-_" for c in argv[1]))
        valid &= len(argv) == 2 or command == "stop" and len(argv) == 3 and argv[2] == "--yes"
    if not valid:
        out.write(USAGE)
        return 2
    if command == "stop" and len(argv) == 2:
        out.write("Stopping a run requires the operator's yes. Then use: run stop <run-id> --yes\n")
        return 1
    config = load_config(here)
    url, ui = tool_url(config), ui_url(config)
    run_id = None
    if command in ("status", "resume", "watch", "stop") or command == "open" and len(argv) == 2:
        if not url:
            out.write("tool_url is not set: run `suites/security-patch/run doctor`\n")
            return 1
        run_id = resolve_run_id(url, argv[1], out)
        if run_id is None:
            return 1
    if command == "open":
        if not ui:
            out.write("ui_url is not set: set it in suites/security-patch/config.local.yaml\n")
            return 1
        target = f"{ui}/runs/{urllib.parse.quote(run_id, safe='')}" if run_id else ui
        if not webbrowser.open(target):
            out.write(f"could not open browser. Open {target}\n")
            return 1
        return 0
    if command == "doctor":
        return doctor(url, out, here, ui)
    if not url:
        out.write("tool_url is not set: run `suites/security-patch/run doctor`\n")
        return 1
    if command == "pick":
        if not ui:
            out.write("ui_url is not set: set it in suites/security-patch/config.local.yaml\n")
            return 1
        return pick(url, out, ui)
    if command in ("status", "resume", "watch", "stop"):
        handler = {"status": run_status, "resume": resume, "watch": watch, "stop": stop_run}[command]
        return handler(url, run_id, out)
    return (overview if command == "overview" else runs)(url, out)
