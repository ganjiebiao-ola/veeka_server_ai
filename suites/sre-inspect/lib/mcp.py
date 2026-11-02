"""grafana/mcp-grafana as a sidecar — pinned image, the flag set measured on 2026-08-28, and a
stdio probe (JSON-RPC over a docker `-i` process) used by doctor and spike.

Facts baked in (verified against the image, not the README):
  * category names are singular (`datasource`, `dashboard`), `-t stdio|sse|streamable-http`;
  * the image entrypoint already carries `--transport sse --address 0.0.0.0:8000` — compose must
    override `entrypoint`, and the binary needs `--server-auth-token` on a non-loopback listener;
  * `query_prometheus` requires `endTime`; `alerting_manage_rules` takes `operation` (list|get|versions);
  * the image has no wget/curl (no in-container healthcheck);
  * the embedded mcp-go server also rejects loopback connections whose Host is not localhost
    (independent of --allowed-hosts) — probe the sidecar from another container, never from inside
    its own network namespace.
"""
import json
import os
import subprocess
import threading

from .common import SuiteError, which

IMAGE = "grafana/mcp-grafana:1.2.0@sha256:cfae68f893dbe40cb6df69579f78beb226f973ded4436d47c844f91d2f00dc53"
ENABLED_TOOLS = "datasource,prometheus,alerting,dashboard,navigation,search"
GRAFANA_TIMEOUT = "60s"
STDIO_ARGS = ["-t", "stdio", "--disable-write", "--enabled-tools", ENABLED_TOOLS, "--grafana-timeout", GRAFANA_TIMEOUT]


def docker_stdio_argv(image=IMAGE):
    """`docker run` argv for Claude Code / Codex `.mcp.json`. Credentials pass as `-e NAME` (value from
    the caller's environment) — never inline."""
    return ["docker", "run", "-i", "--rm", "-e", "GRAFANA_URL", "-e", "GRAFANA_SERVICE_ACCOUNT_TOKEN",
            "-e", "GRAFANA_ORG_ID", "--entrypoint", "/app/mcp-grafana", image] + STDIO_ARGS


def claude_mcp_json(image=IMAGE):
    argv = docker_stdio_argv(image)
    return {"mcpServers": {"grafana": {"command": argv[0], "args": argv[1:],
                                       "env": {"GRAFANA_URL": "${GRAFANA_URL}",
                                               "GRAFANA_SERVICE_ACCOUNT_TOKEN": "${GRAFANA_SERVICE_ACCOUNT_TOKEN}",
                                               "GRAFANA_ORG_ID": "${GRAFANA_ORG_ID:-1}"}}}}


def merge_claude_mcp_json(existing_text, image=IMAGE):
    """Merge the `grafana` server into an existing .mcp.json text (other servers preserved).
    Returns (new_text, action) with action in created|updated|unchanged. Invalid JSON raises SuiteError."""
    want = claude_mcp_json(image)["mcpServers"]["grafana"]
    if existing_text is None or not existing_text.strip():
        return json.dumps({"mcpServers": {"grafana": want}}, indent=2) + "\n", "created"
    try:
        doc = json.loads(existing_text)
    except ValueError as e:
        raise SuiteError(".mcp.json exists but is not valid JSON (%s) — fix or remove it, then rerun" % e)
    if not isinstance(doc, dict):
        raise SuiteError(".mcp.json must be a JSON object with a mcpServers map")
    servers = doc.setdefault("mcpServers", {})
    if servers.get("grafana") == want:
        return existing_text, "unchanged"
    servers["grafana"] = want
    return json.dumps(doc, indent=2) + "\n", "updated"


def codex_toml(image=IMAGE):
    argv = docker_stdio_argv(image)
    args = ", ".join(json.dumps(a) for a in argv[1:])
    return ("[mcp_servers.grafana]\ncommand = \"docker\"\nargs = [%s]\n"
            "# values come from your shell environment (source suites/sre-inspect/env/.env.holmes first)\n"
            "env = { GRAFANA_URL = \"${GRAFANA_URL}\", GRAFANA_SERVICE_ACCOUNT_TOKEN = \"${GRAFANA_SERVICE_ACCOUNT_TOKEN}\" }\n" % args)


def ensure_image(image=IMAGE, wall=900):
    """Pull the sidecar image if it is not local yet — a first run on a laptop would otherwise spend the
    probe's wall clock on the download and report a misleading timeout. Raises SuiteError when the
    docker daemon is unreachable (the message names that, not a timeout)."""
    from .common import run
    probe = run(["docker", "image", "inspect", image], wall=30)
    if probe.code == 0:
        return False
    if "Cannot connect to the Docker daemon" in probe.stderr or "Is the docker daemon running" in probe.stderr:
        raise SuiteError("docker daemon is not running (start Docker Desktop / dockerd, then rerun)")
    pull = run(["docker", "pull", image], wall=wall)
    if pull.code != 0:
        raise SuiteError("docker pull %s failed: %s" % (image.split("@")[0], (pull.stderr or pull.stdout).strip().split("\n")[-1][:200]))
    return True


class _Reader(threading.Thread):
    def __init__(self, stream):
        super().__init__(daemon=True)
        self.stream, self.lines, self.done = stream, [], threading.Event()

    def run(self):
        for line in self.stream:
            self.lines.append(line)
        self.done.set()


def stdio_probe(env, image=IMAGE, wall=60, argv=None):
    """Run the sidecar via docker stdio, initialize, list tools, call list_datasources.
    Returns {"tools": [...], "datasources": n, "server": {...}} or raises SuiteError."""
    if argv is None:
        if not which("docker"):
            raise SuiteError("docker is not on PATH")
        ensure_image(image)
        argv = docker_stdio_argv(image)
    proc_env = dict(os.environ)
    proc_env.update({k: env[k] for k in ("GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN", "GRAFANA_ORG_ID") if env.get(k)})
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=proc_env, text=True, bufsize=1)
    except FileNotFoundError as e:
        raise SuiteError("cannot start %s: %s" % (argv[0], e))
    reader = _Reader(proc.stdout)
    reader.start()
    seq = [0]
    responses = {}

    def send(method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            seq[0] += 1
            msg["id"] = seq[0]
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()
        return None if notify else seq[0]

    def wait(mid, timeout):
        import time
        t0 = time.monotonic()
        idx = 0
        while time.monotonic() - t0 < timeout:
            while idx < len(reader.lines):
                line = reader.lines[idx]
                idx += 1
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if obj.get("id") is not None:
                    responses[obj["id"]] = obj
            if mid in responses:
                return responses[mid]
            if proc.poll() is not None and reader.done.is_set():
                err = (proc.stderr.read() or "")[-300:].strip()
                raise SuiteError("mcp-grafana stdio: process exited with code %s before answering request %d (%s)"
                                 % (proc.returncode, mid, err or "no stderr"))
            time.sleep(0.05)
        raise SuiteError("mcp-grafana stdio: no response to request %d within %ss (stderr: %s)"
                         % (mid, timeout, (proc.stderr.read() or "")[-300:].strip()))

    try:
        r = wait(send("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                     "clientInfo": {"name": "sre-inspect-doctor", "version": "1"}}), wall)
        server = (r.get("result") or {}).get("serverInfo") or {}
        send("notifications/initialized", notify=True)
        r = wait(send("tools/list"), wall)
        tools = [t.get("name") for t in ((r.get("result") or {}).get("tools") or [])]
        r = wait(send("tools/call", {"name": "list_datasources", "arguments": {}}), wall)
        res = r.get("result") or {}
        text = "".join(c.get("text", "") for c in res.get("content") or [])
        if res.get("isError"):
            raise SuiteError("list_datasources failed through mcp-grafana: %s" % text[:300])
        try:
            n = len((json.loads(text) or {}).get("datasources") or [])
        except ValueError:
            n = -1
        return {"server": server, "tools": tools, "datasources": n}
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
