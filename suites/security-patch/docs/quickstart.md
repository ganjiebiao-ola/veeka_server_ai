# security-patch quickstart

Run these commands from the workspace root on macOS.
The template includes the app. You do not need a separate tool clone.

## Install prerequisites

1. Install Docker Desktop. Start Docker.
2. Install the host tools:

   ```sh
   brew install oven-sh/bun/bun jq gh
   curl -fsSL https://claude.ai/install.sh | bash
   ```

3. Run `gh auth login`. Run `claude login`.
   Your GitHub account needs permission to read the scanned repo and create its tracker issues and PRs.

## Configure the suite

1. Create the local settings:

   ```sh
   git check-ignore -v suites/security-patch/app/.env
   cp suites/security-patch/app/.env.example suites/security-patch/app/.env
   cp suites/security-patch/config.yaml suites/security-patch/config.local.yaml
   ```

2. Create a classic GitHub token with only the `repo` scope and a 30-day expiry.
   If the org uses SSO, authorize the token for it. Set `GH_TOKEN` to it in `suites/security-patch/app/.env`.
   The tool uses this token to clone, push and update issues. A run does not start without it.
   Keep secrets out of tracked files.

3. Keep `tool_url: "http://localhost:37018"` in `suites/security-patch/config.local.yaml` for the local app.
   Keep `ui_url: "http://localhost:32088"` for the UI. These URLs do not change the ports in `dev.sh` or Vite.
   Keep pilot settings and notes in ignored local files.

## Start and use the suite

1. Start the app:

   ```sh
   suites/security-patch/run start
   suites/security-patch/run doctor
   ```

   Fix each `[MISS]` row. The first start builds the scanner image and installs frontend dependencies.
   For an existing Claude provider in `~/.claude/settings.json`, use `run start --auth=settings`.

2. Run `suites/security-patch/run open`. The UI uses port 32088. The backend uses port 37018.
   Use `run open <run-id>` to open one run's detail page.
3. Start a scan in the UI.
4. When the scan ends, open its Run tab. Clear the findings that are false positives.
   Then click **Post to GitHub**. The app adds the selected findings to the repo's tracker files in `olaola-chat/security-patch-tracker`.
   Pick shows only posted findings.
5. Run `suites/security-patch/run pick`. Accept or edit the pick in the UI.
   Rows that overlap an open PR stay hidden. The UI lists the blocking PRs and lets you ignore one PR per repo.
Operators stop runs manually; quota errors save a checkpoint for Resume.
6. The app runs the batches and opens their PRs. Run `suites/security-patch/run overview` to read the state.
7. The repo owner reviews each PR. Rows marked `needs human` wait for that owner.
8. A stopped scan or fix run with a checkpoint can resume. Ask the operator before
   `suites/security-patch/run resume <run-id>` because Resume spends model quota.

## Stop and check

```sh
suites/security-patch/run status
suites/security-patch/run logs
suites/security-patch/run logs --follow
suites/security-patch/run runs
suites/security-patch/run watch <run-id>
suites/security-patch/run stop
```

Setup does not need the suite tests. Run them only after you change the suite. See "Checks" in [runbook.md](runbook.md).
See [runbook.md](runbook.md) for operation details and [the app README](../app/README.md) for the implementation.

## Troubleshooting

- **Port in use:** `run doctor` shows port owners. Stop the conflicting process before `run start`.
  The bundled app requires ports 37018 and 32088.
- **Active runs block stop or restart:** use `run runs` and `run watch <run-id>` to check progress.
  Wait for the runs to end. To stop one run, ask the operator first.
  After the operator agrees, use `run stop <run-id> --yes`. Then repeat `run stop` or `run start`.
- **Backend edits need a restart:** the backend runs without `--watch`. Run `suites/security-patch/run start` after backend, scanner, skill, or settings changes.
  The command reloads changed backend code when no runs are active.
- **Request from another host or origin fails:** the backend binds to `127.0.0.1` by default.
  Set `OLA_AGENT_BIND_HOST`, `OLA_AGENT_UI_ORIGINS`, or `OLA_AGENT_ALLOWED_HOSTS` in `app/.env` when access from that host or origin is needed.
- **Backend unavailable:** run `suites/security-patch/run start`, then `run doctor`.
- **Logs:** `run logs` shows the last 200 lines. Use `run logs --follow` for new lines.
  Startup appends to existing logs.
