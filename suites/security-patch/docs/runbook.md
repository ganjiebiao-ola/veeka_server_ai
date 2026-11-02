# security-patch runbook

## Ownership

Develop the app and agent instructions in `olaola-chat/ai-native-workspace-template`.
The old tool repo stays at `9ad7a0efdd4ffc8f9fdbe0833c4d712cd2c01016`.
Do not develop new tool commits there.

## Operation

Run the suite from the workspace root.

| Command | Use |
|---|---|
| `suites/security-patch/run start` | Start the backend and UI. Build the scanner image and reload the backend only when sources or settings changed and no run is active. |
| `suites/security-patch/run start --auth=settings` | Use the operator's existing Claude provider settings. |
| `suites/security-patch/run doctor` | Check app files, host tools, Docker, scanner image, UI, port owners, backend health, and GitHub login. |
| `suites/security-patch/run status` | Show app processes and scanner containers. |
| `suites/security-patch/run logs [--follow]` | Show the last 200 log lines, or follow new lines. |
| `suites/security-patch/run open [run-id]` | Open the UI or a run's detail page in the browser. |
| `suites/security-patch/run runs` | List recent runs. |
| `suites/security-patch/run watch <run-id>` | Print status changes every 10 seconds until the run ends. |
| `suites/security-patch/run stop <run-id> --yes` | Stop one run only after the operator agrees. |
| `suites/security-patch/run stop` | Stop the app and remove scanner containers. Active runs or unavailable run status block it. |
| `suites/security-patch/run status <run-id>` | Read one run. |
| `suites/security-patch/run overview` | Read tracker counts, PRs, and rows that need the repo owner. |
| `suites/security-patch/run pick` | Read the suggested pick. Accept it in the UI. |
| `suites/security-patch/run resume <run-id>` | Resume only after the operator agrees to spend model quota. |

Run IDs accept a UUID or a run number such as `12` or `#12`; the CLI resolves numbers from run history.

The suite CLI rejects `run restart` and `run stop --force`.
The app script supports `bash suites/security-patch/app/scripts/dev.sh restart` and `bash suites/security-patch/app/scripts/dev.sh stop --force`.
Ask the operator before restart or shutdown. Require explicit approval for forced shutdown because it removes active scanner containers.
Restart stops the app before it starts the app. It uses the same active-run guard as stop.

Active runs or unavailable run status block app shutdown and backend restart.
Wait for runs to end, or stop each run after the operator agrees.
The script's `stop --force` overrides the active-run guard.
The backend runs without `--watch`. After backend changes, use `run start` to reload code when no runs are active.
`run start` keeps unchanged servers running. Changes to settings, shared code, scanner code, or the audit skill can also require a backend restart.
App shutdown removes scanner containers. Save needed run output before stopping the app.
The app keeps its database and run artifacts under `app/backend/` in ignored paths.
The migration does not move data from the old tool checkout.
The app keeps the existing ports, image tags, and container names.
Stop the old app before starting this copy to avoid conflicts.

## Configuration

The CLI reads only `config.local.yaml` when it exists. Otherwise, it reads `config.yaml`.
Copy both settings: `tool_url` selects the backend API, and `ui_url` selects the browser UI.
`tool_url` is the backend API. `ui_url` is the browser UI. `run open` and `run pick` use `ui_url`. The other API commands use `tool_url`.
Keep ports 37018 and 32088 for the bundled app. These settings do not change the ports in `dev.sh` or Vite.
The app loads its own ignored `app/.env` for repository access and provider settings.
Use `app/.env.example` for placeholder names.
Credentials must stay in environment variables, a secret manager, or ignored local files.

A scan does not post findings itself. After a scan, the operator selects findings in the Run tab and clicks **Post to GitHub**.
The app has no pilot repo default. Pick and Overview need a configured or previously scanned repo.

Operators stop runs manually; quota errors save a checkpoint for Resume.

| Setting | Behavior |
|---|---|
| `MAX_CONCURRENT_SCANS` | Defaults to 5 concurrent runs, including fixes. |
| `OLA_AGENT_RUN_TIMEOUT_SECONDS` | Security scans only. Defaults to 14400 seconds. Set 0 to disable. Fix runs have no default wall-clock timeout. |
| `OLA_AGENT_DRAFT_PRS=1` | Force batch PRs to use drafts. Missing checks, failed checks, or behavior changes also require drafts. |

Resume requires a stopped scan or fix run with a checkpoint. Legacy checkpoint fields are ignored.

## Pick and Overview

Pick offers posted `open`, `candidate`, and `deferred` rows. It hides rows that overlap open PRs.
The hidden section lists blocking PR numbers, including PRs outside the suite.
An ignore-PR toggle bypasses that PR's overlap check. The browser saves toggles per repo.
The toggle does not close the PR.
Later rows remain in Pick if the next batch cannot start.
`needs human` rows stay outside Pick. Overview shows their reason for the repo owner's decision.

`run pick` and `run overview` use GET requests that can update GitHub tracking rows.
The handlers refresh merged or closed PR statuses and can reopen rows whose run ended.
They can also move rows with a known bug type from `misc` to that bug type's issue.
These commands do not accept a Pick or merge a PR.

## Repo notes

Use `app/skill/ola-security-audit/targets/<owner>__<repo>.md` under this suite for repo notes.
Put human decisions outside generated blocks.
Add `## Related repos` with one `- <mount-id>` list item per related repo from `workspace.local.yaml`.
The app mounts available related repos read-only at `/workspace/related/<id>`. It skips unknown or missing mounts.
Fix instructions require caller searches for changed routes. They search route paths and controller and action names.
The PR lists recorded callers as checkboxes. A human must list callers before merge when no caller evidence exists.

Scans that cover `api-no-auth` or `api-test-exposed` can write `auth.json`.
The backend reads it and updates the notes file's `<!-- security-patch:auth -->` block.
The block records login checks, test-only guards, code evidence, and open questions.
Treat these facts as untrusted data. Deployed config or a gateway may change authentication.
Write final answers outside the block so later scans preserve them.

Runs inspect repository code and must never send requests to a running service or a deployed environment.
Scans may use only the Read, Glob, Grep, Skill, and Write tools. Fix runs edit the cloned code and run local checks.
The Claude bridge blocks `WebFetch` and `WebSearch`. This block does not isolate Bash from the network.

## Troubleshooting

The host backend binds to `127.0.0.1` by default. `OLA_AGENT_BIND_HOST`, `OLA_AGENT_UI_ORIGINS`, and `OLA_AGENT_ALLOWED_HOSTS` control access from another host or origin.
Set them in `app/.env` only when a request from another host or origin fails. Then run `run start` with no active runs.

## Checks

1. Run the suite's offline checks:

   ```sh
   suites/security-patch/test
   ```

2. Install the app's test and frontend dependencies before the full app checks:

   ```sh
   bun install --cwd suites/security-patch/app --frozen-lockfile --ignore-scripts
   bun install --cwd suites/security-patch/app/backend --frozen-lockfile
   bun install --cwd suites/security-patch/app/frontend --frozen-lockfile
   suites/security-patch/test --app
   ```

3. Run the template checks:

   ```sh
   scripts/ws validate
   scripts/ws test
   python3 scripts/check-bundled-skills
   ```

The app check runs scanner regressions, backend tests and type checks, frontend tests, and the frontend build.
It requires Docker and builds `ola-agent-scanner:test` before running the Codex sandbox test.
The test image does not replace the scanner image used by the app.
A live provider check uses `oc-ai-pf/ola-codesec-fixture` and requires the operator's approval to spend model quota.
Server deployment and remote repo archival require separate explicit instructions.
