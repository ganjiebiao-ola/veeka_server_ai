# security-patch app

This app belongs to `suites/security-patch/` in `olaola-chat/ai-native-workspace-template`.
It provides the web UI for security scans, audits, and fixes inside isolated Docker containers.
The old tool repo stays at `9ad7a0efdd4ffc8f9fdbe0833c4d712cd2c01016`. Develop future changes in the template.
Claude uses the Claude Agent SDK. Codex uses the Agent Client Protocol (ACP) for read-only work.
LiteLLM uses the existing Claude relay.

The user selects a repository, branch or commit, provider, effort, and mode.
The backend starts a scanner container and records its run in SQLite.
The scanner saves reports and structured findings. The UI shows progress, findings, and run history.

---

## Architecture

```
Browser (Vite + React)
   │ HTTP + SSE
   ▼
Backend (Bun + Hono, :37018)
   │  – SessionManager / SQLite (sessions, runs, findings)
   │  – Spawns sibling scanner containers via host docker.sock
   ▼
Scanner container (per run)
   ├─ Clone a branch or pinned commit, or use an allowed local workspace
   ├─ Scan: Semgrep pre-pass
   ├─ Claude: SDK scan / fix. Codex: read-only ACP scan
   └─ Save findings.json and reports, stream messages as JSONL
```

### Key decisions

| | |
|---|---|
| Claude auth | `--auth=oauth` uses host OAuth from macOS Keychain or a Linux file. `--auth=settings` uses host `~/.claude/settings.json` provider settings. Scanners receive `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` through environment variables. See `backend/auth/refresh_creds.ts`. |
| Codex auth | The backend mounts the host login file for Codex runs and reviews. Default: `~/.codex/auth.json`. Override with `OLA_AGENT_CODEX_AUTH_PATH`. A run can use `OPENAI_API_KEY` instead; pick Subscription or API key per run. The key reaches only the Codex process, never the agent's commands. A Codex review with no login file falls back to the key. |
| Qoder auth | OAuth/subscription only. The backend mounts `~/.qoder/.auth` for Qoder runs and reviews; override with `OLA_AGENT_QODER_AUTH_PATH`. A refreshed `user` token is copied back unless the host file changed during the run; `machine_id` and the `dynamic-*` caches never are. Container auth failures may indicate a host-bound `machine_id`. |
| Antigravity auth | The backend mounts the host login token for Antigravity runs and reviews. Default: `~/.gemini/antigravity-cli/antigravity-oauth-token`. Override with `OLA_AGENT_ANTIGRAVITY_AUTH_PATH`. |
| Repository auth | The scanner clones and pushes with `GH_TOKEN`, a GitHub token with `repo` scope. A run does not start without it. |
| Skills | The image includes `skill/<name>/SKILL.md`. Runs never ask the operator questions. |
| Persistence | SQLite: `backend/data/ola-agent.sqlite`. Run artifacts: `backend/workspace/runs/<id>/artifacts/`. |
| Models | Claude accepts `opus`, `sonnet`, and `haiku` aliases. History prefers the reported model ID and marks fallback names as `Requested`. |
| Effort | Claude uses SDK effort settings. Main Codex runs apply `low`, `medium`, `high`, or `xhigh` before the first prompt. Unsupported effort stops setup. |
| Version anchor | The image pins `claude-code@2.1.N` and `claude-agent-sdk@0.3.N` with the same trailing N. Check with `scripts/check-claude-versions.sh`. |

### Scan and run history

- A scan lists candidates without source edits, commits, PRs, or questions to the operator.
- The scan form defaults to Sonnet at high effort. It has a Max subagents setting from 0 to 3, default 0. The run saves the value.
- At 0, the scan instructions require one agent and the Claude SDK removes `Agent` and `Task` from its tool set. At 1 to 3, the bridge denies every start past the cap. A scan may start fewer. Subagents cannot write `findings.json`.
- Semgrep checks PHP SQL injection, command injection, unsafe `unserialize`, disabled TLS verification, mass assignment, and loose input comparisons before the model starts.
- The prompt groups hits by file, rule, and category within an 80,000-character budget. It reports omitted hits and links the full report.
- SQLi candidates include CLI and internal code. Fix assesses reachability later. Numeric casts, constants, bound parameters, and matching ignore markers remain exclusions.
- Start runs through the app or its API to record them in history. Standalone CLI sessions do not create history entries automatically.
- History shows a reported ID such as `claude-sonnet-5-5` when available. Otherwise, it marks the requested alias, such as `sonnet`, as `Requested`.

Codex supports read-only scan and review. Fix mode uses Claude.
Antigravity scans and reviews with a read-only `agy` agent that has file read tools and the artifact writer, no shell, in an empty workspace. Fix runs write only inside the container. Effort is `low`, `medium` or `high`.

---

## Quick start (macOS)

Follow the [suite quickstart](../docs/quickstart.md) for prerequisites, GitHub login, and local settings.
Run these commands from the workspace root:

```sh
suites/security-patch/run start
suites/security-patch/run doctor
```

The UI uses `http://localhost:32088`. The backend uses `http://localhost:37018`.
For an existing Claude provider in `~/.claude/settings.json`, use `suites/security-patch/run start --auth=settings`.
The suite includes this app. Do not clone the old tool repo for setup.

## Optional Linux server setup

```bash
# on the server, after `claude login` + the keep-fresh cron (see doc below)
./scripts/dev.sh compose:server:start
# layers docker-compose.server.yml on the base: ports bound to 127.0.0.1,
# host OAuth credentials mounted in. Reach it via an SSH tunnel:
#   ssh -L 32088:localhost:32088 you@server   →  http://localhost:32088
```

The app has **no auth layer**, so the server compose binds ports to `127.0.0.1`
only — never expose it directly. Full walkthrough (OAuth refresh cron, API-key
alternative, VPN/firewall): [`docs/setup-linux-server.md`](docs/setup-linux-server.md).

## Headless code-agent API (generic runs)

External tools can submit a raw prompt and an allowed host workspace through the backend API.
They can follow SSE progress and read `response.md` and `events.jsonl`.
Generic runs are off by default. Enable them through `OLA_AGENT_WORKSPACES_ROOT`.
Full API and SkillOpt integration guide:
[`docs/headless-code-agent.md`](docs/headless-code-agent.md).

---

## Repo layout

```
backend/                Bun + Hono API
  ├─ auth/              OAuth credential refresh (Keychain / file)
  ├─ cli/server.ts      Entry point
  ├─ docker/            DockerController — spawns scanner containers
  ├─ events/            SSE bus + SDK message → RunEvent mapper
  ├─ handlers/          HTTP routes (runs, sessions, repos, pick, providers, setup)
  ├─ orchestrator/      ScannerRun (per-run lifecycle), batch PR
  ├─ sdk_bridge/        Decodes scanner stdout JSONL, usage aggregator
  └─ store/             SQLite schema + repo

frontend/               Vite + React
  ├─ src/pages/         LandingPage, RunPage, OverviewPage, PickPage, HistoryPage, RunDetailPage
  ├─ src/components/    ChecklistSidebar, ReportView (markdown), ActivityArea,
  │                     TokenHud, …
  └─ src/hooks/         useSession (localStorage), useRunEvents (SSE reducer)

scanner/
  ├─ Dockerfile         Per-run image (Debian + Bun + git + SDK / ACP tools)
  ├─ entrypoint.sh      git auth + clone + fallback main→master
  └─ bridge.mjs         Daemon: multi-round query() + JSONL stdio

skill/
  └─ ola-security-audit/
      └─ SKILL.md       Audit categories and scan/fix instructions

shared/types.ts         Contract types shared between backend + frontend

docs/                   Setup and headless API guides
scripts/                dev.sh (start/stop/compose), keep-claude-token-fresh.sh,
                        check-claude-versions.sh
```

---

## Development

Run these commands from the workspace root:

```sh
bun install --cwd suites/security-patch/app --frozen-lockfile --ignore-scripts
bun install --cwd suites/security-patch/app/backend --frozen-lockfile
bun install --cwd suites/security-patch/app/frontend --frozen-lockfile
suites/security-patch/test
suites/security-patch/test --app
```

The scanner test dependency uses the same ACP SDK version as the scanner image.
The app check runs scanner regressions, backend tests and type checks, frontend tests, and the frontend build.
It also builds a separate scanner test image and checks the Codex filesystem and network restrictions in Docker.
The Security patch CI workflow runs these checks on pull requests and pushes to main.
`run start` rebuilds the scanner image only when scanner, skill, backend, or shared sources or settings changed. Existing containers keep their scanner code.
The backend runs without `--watch`. `run start` reloads changed backend code only when no run is active.
See the [runbook](../docs/runbook.md) for operation and ownership rules.

---

## Status

Working: branch and commit cloning, Scan, Fix, structured findings, run history, and OAuth refresh.
Fix runs can push commits to a new branch. Picked batches use the batch PR flow.
Reports and patches survive interrupted runs.

Known limits:

- Operators stop runs manually; quota errors save a checkpoint for Resume.
- `OLA_AGENT_RUN_TIMEOUT_SECONDS` applies only to scans. It defaults to 14400 seconds. Fix runs have no default timeout.
- `MAX_CONCURRENT_SCANS` defaults to 5. `OLA_AGENT_DRAFT_PRS=1` forces draft batch PRs.
- ACP does not report token totals to the bridge.
- A smoke check stops after first model output or its configured time limit. The 30-second clock starts at the first model request.
- The model runs as the unprivileged user `agent` in the scanner container. `GH_TOKEN` and the bridge's `/proc/<pid>/environ` stay root-only, and push runs as root. The model still holds its own model login (`ANTHROPIC_*` env and a copy of the OAuth or Codex login), so it can read those. The model can reach the network from Bash. Root never runs git in the model's repo. The `agent` user writes a bundle, and root pushes it from a fresh repo to the clone URL. The Codex login is a copy. On exit, root copies a refreshed login back to the host file only when it passes the file, size, JSON and key checks. A container that Docker kills hard skips this step and leaves the artifacts folder at mode 1777.
- The app assumes one user. History intentionally includes runs from every session.

Developer controls: `suites/security-patch/run dev` enables Smoke check and the scan subagents selector. Normal `run start` hides them. When starting the backend directly, set `OLA_DEV=1`; `/api/health` reports the mode to the frontend.
