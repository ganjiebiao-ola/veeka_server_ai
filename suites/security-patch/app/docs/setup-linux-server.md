# Linux Server Deployment (with Claude Pro/Max OAuth)

This guide covers the bundled security-patch app on a Linux host using the
operator's Claude OAuth login. Run commands from the workspace root unless a
step says to enter `suites/security-patch/app/`. Server startup is a deployment
and requires the operator's explicit instruction.

---

## Big picture

```
host machine (Linux)
  ~/.claude/.credentials.json          ← Claude CLI reads/writes (auto-refreshes via cron)
        │  bind-mounted RO into backend container at /host-claude/.credentials.json
        ▼
  ola-agent-backend (compose)
        │  per-run refreshCredentials() reads the mounted source, writes the slice ↓
        ▼
  ./.runtime/.credentials.json (RW)    ← scanner sibling containers mount RO
```

Under docker compose the backend runs inside a container whose `$HOME=/root`,
so it can't see the host user's `~/.claude/.credentials.json` by default.
`docker-compose.server.yml` bridges that: it mounts the host file in and points
`OLA_AGENT_CREDENTIALS_SOURCE` at the mount. `./scripts/dev.sh compose:server:start`
layers that override on for you.

The bundled keep-fresh script invokes `claude --version` every 6h and reports
the credential expiry saved by the CLI. Check that the reported expiry advances;
log in again when the credentials need renewal.

---

## Step 1 — install prereqs on the server

```bash
# Debian/Ubuntu
sudo apt-get update
sudo apt-get install -y curl ca-certificates jq git docker.io
# Add yourself to docker group + log back in
sudo usermod -aG docker $USER

# Bun
curl -fsSL https://bun.sh/install | bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc

# Claude Code CLI
curl -fsSL https://claude.ai/install.sh | bash
```

---

## Step 2 — `claude login` (first-time auth)

```bash
claude login
# follow the printed URL on your laptop, paste the resulting code back to the
# server terminal. Creates ~/.claude/.credentials.json.
```

Verify:

```bash
ls -la ~/.claude/.credentials.json
jq '.claudeAiOauth | {expiresAt, scopes}' ~/.claude/.credentials.json
```

---

## Step 3 — prepare the bundled app

Use a checkout of `olaola-chat/ai-native-workspace-template` on the host. From
its root:

```bash
cp suites/security-patch/app/.env.example suites/security-patch/app/.env
# edit suites/security-patch/app/.env:
#   GH_TOKEN=<token>     (GitHub token with repo scope, for clone, push and issues)
#   leave ANTHROPIC_API_KEY and OLA_AGENT_CREDENTIALS_SOURCE commented out —
#   compose:server:start sets the credentials source for you via the override.
```

The server override uses Compose `!override` to keep both published ports on
loopback. Check `docker compose version` first; [Docker requires Compose 2.24.4 or
later for `!override`](https://docs.docker.com/reference/compose-file/merge/#replace-value).

### Memory budget on a single box

Scanners are **sibling** containers: the backend starts them through the mounted
docker socket, so the backend's own `mem_limit` does not constrain them. The
number that has to fit on the host is therefore

```
MAX_CONCURRENT_SCANS x OLA_AGENT_SCANNER_MEMORY_MB
```

With the defaults (5 x 4096 MB) that is 20 GB of theoretical commitment, which
is more than a small VPS has. Size it explicitly in `.env`:

```
MAX_CONCURRENT_SCANS=2
OLA_AGENT_SCANNER_CPUS=1
OLA_AGENT_SCANNER_MEMORY_MB=1536
OLA_AGENT_SCANNER_MEMORY_SWAP_MB=1536   # equal to _MEMORY_MB = no swap
```

The swap line matters as much as the memory line. With `--memory` set and
`--memory-swap` omitted, docker allows swap up to the memory cap again, so a
box under pressure thrashes instead of OOM-killing anything — the kernel keeps
reclaiming and the machine can become unresponsive without a single entry in
the OOM log. Setting the two equal disables swap for the container, the same
thing `memswap_limit: <same as mem_limit>` does for the compose services.

The effective values are printed at startup:

```
[boot] scanner caps: 1 cpu / 1536 MB each, swap disabled x MAX_CONCURRENT_SCANS=2 -> up to 2 cpu / 3072 MB RAM committed
```

---

## Step 4 — schedule the keep-fresh script

### Option A: crontab (simpler)

```bash
crontab -e
# add (every 6h):
0 */6 * * * /path/to/ai-native-workspace-template/suites/security-patch/app/scripts/keep-claude-token-fresh.sh >> /var/log/ola-agent-token.log 2>&1
```

Make the log dir writable:

```bash
sudo touch /var/log/ola-agent-token.log
sudo chown $USER /var/log/ola-agent-token.log
```

Test it immediately:

```bash
/path/to/ai-native-workspace-template/suites/security-patch/app/scripts/keep-claude-token-fresh.sh
# check for an OK result and inspect the reported expiry
```

### Option B: systemd timer (preferred)

Two files in `/etc/systemd/system/`:

**`ola-token-refresh.service`**:
```ini
[Unit]
Description=Refresh Claude Code OAuth token

[Service]
Type=oneshot
User=YOUR_USER
Environment=HOME=/home/YOUR_USER
ExecStart=/path/to/ai-native-workspace-template/suites/security-patch/app/scripts/keep-claude-token-fresh.sh
```

**`ola-token-refresh.timer`**:
```ini
[Unit]
Description=Refresh Claude Code OAuth token every 6 hours

[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ola-token-refresh.timer
systemctl status ola-token-refresh.timer
journalctl -u ola-token-refresh.service -n 20
```

---

## Step 5 — start the agent

### Docker compose (recommended for server)

```bash
cd /path/to/ai-native-workspace-template/suites/security-patch/app
./scripts/dev.sh compose:server:start
```

This builds the scanner image, brings up `docker-compose.yml` +
`docker-compose.server.yml`, mounts the host OAuth credentials into the backend,
and **binds both ports to `127.0.0.1`** — the app has no auth layer, so it is
never exposed on `0.0.0.0`.

Stop with `./scripts/dev.sh compose:server:stop`.

> `compose:start` uses the base compose file, whose frontend port binds on all
> interfaces. Use `compose:server:start` for loopback binding on a server.

### Step 5b — reach it (no public exposure)

Because there's no login screen, don't open the port to the world. Pick one:

**SSH tunnel (simplest, default):**

```bash
# from your laptop
ssh -L 32088:localhost:32088 you@server
# then open http://localhost:32088
```

**VPN / internal IP:** edit `docker-compose.server.yml` and replace `127.0.0.1`
with the server's VPN-facing IP (e.g. `10.0.0.5:32088:80`), then firewall the
port to the VPN subnet only:

```bash
sudo ufw allow from 10.0.0.0/24 to any port 32088 proto tcp
sudo ufw deny 32088
```

### Dev mode (host processes — debugging only)

```bash
./scripts/dev.sh start    # host backend binds 127.0.0.1 by default
```

---

## Step 6 — verify everything end-to-end

```bash
# 1. token is fresh
jq '.claudeAiOauth.expiresAt' ~/.claude/.credentials.json
date +%s%3N    # should be << expiresAt

# 2. backend picked it up
curl http://localhost:37018/api/health
grep "OAuth credentials refreshed" /var/log/ola-agent-backend.log  # or wherever your logs go

# 3. smoke run
SID=$(curl -s -X POST http://localhost:37018/api/sessions | jq -r .sessionId)
curl -s -X POST http://localhost:37018/api/runs -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg s "$SID" '{sessionId:$s, repoUrl:"https://github.com/octocat/Hello-World.git", branch:"master", skill:"ola-security-audit", model:"haiku", effort:"low", mode:"scan"}')"
# then GET /api/runs/<runId> until status=completed and usage>0
```

---

## Credential maintenance

If the OAuth credential expires or the refresh script fails, symptoms include:

- `keep-claude-token-fresh.sh` cron log starts showing `claude --version failed`
- Backend logs show `[runs] credential refresh skipped: source file ... read failed`
- All runs 401 on Claude API

Fix:

```bash
ssh server
claude login
# follow URL, paste code
systemctl start ola-token-refresh.service   # re-prime; or just wait for the next 6h tick
```

To avoid being surprised, set a calendar reminder, or pipe the cron log to
a monitoring system (Prometheus textfile collector, or just a daily
`grep ERROR ola-agent-token.log | mail` job).

---

## Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `claude login` opens browser on server (no GUI) | CLI thinks DISPLAY is set | Run `unset DISPLAY && claude login` or copy the URL printed in fallback mode |
| Cron runs but token doesn't refresh | Cron has no `$HOME` / `$PATH` | systemd timer with `Environment=HOME=...` is more reliable |
| `refresh skipped: source file missing` in backend log | The server override cannot read the host login file | Verify `~/.claude/.credentials.json` for the user who runs `compose:server:start` and inspect the compose volume |
| Token refreshes work in shell but not in cron | Different `HOME` between user and cron | Add `HOME=/home/yourname` to the crontab line |
| Host runs out of memory / becomes unresponsive while runs are active | `MAX_CONCURRENT_SCANS x OLA_AGENT_SCANNER_MEMORY_MB` exceeds host RAM, or swap is left enabled for scanners | Lower both, and set `OLA_AGENT_SCANNER_MEMORY_SWAP_MB` equal to `OLA_AGENT_SCANNER_MEMORY_MB`. Check the `[boot] scanner caps:` line for what is actually in effect |
| Every run fails with exit code 125 right after start | A resource env var was rejected, or docker refused the value (e.g. `--memory` below 6 MB) | Look for `[config] ... ignoring it` in the backend log; values are plain numbers with no unit suffix |

---

## API-key server mode

If maintaining a cron makes you uncomfortable:

```bash
# in .env
ANTHROPIC_API_KEY=<your-api-key>
# the server compose override still mounts ~/.claude/.credentials.json
```

The backend prefers the API key over OAuth. The current server override still
requires the host credentials file for its bind mount; remove that mount and
`OLA_AGENT_CREDENTIALS_SOURCE` in a local override if you choose key-only setup.
Keep the loopback port bindings when adjusting the override.
