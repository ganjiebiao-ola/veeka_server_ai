# codesec executor — documented interface, **not wired**

The API payload and operational traps below describe the historical upstream
codesec executor. They are not the contract of the bundled security-patch app.
For its current generic-run API, use
[`security-patch/app/docs/headless-code-agent.md`](../../security-patch/app/docs/headless-code-agent.md).

> **Status: documented only.** This suite runs the fix with the operator's own agent CLI
> (`lib/headless.py run_agent()`). The upstream sentinel instead ran it inside an `ola-codesec-agent`
> container — a generic, containerised Claude Code runner with a zero-credential, no-push sandbox.
> If a team wants that sandbox (unattended batch runs on a shared host, parity with the central
> sentinel, a pinned CLI version), the **insertion point is one function**: implement
> `run_agent(worktree, run_dir, cfg, wall_sec, agent, extra_secrets) -> attempt dict` against the
> HTTP contract below and select it via `config.yaml headless.agent`. Nothing else in the pipeline
> changes — the gate still reads the worktree on the host.

Source: `ola-sre-agent` `orchestrator/internal/codesec/codesec.go` (client + header comment),
`docs/codesec-handover.md`; `ola-codesec-agent` `docs/headless-code-agent.md`.

## Endpoints (generic headless run)

```
POST <codesec-base-url>/api/sessions                    → 201 {sessionId}       one per client process
POST <codesec-base-url>/api/runs                        → 201 {runId, status}
GET  <codesec-base-url>/api/runs/:id                    → {status, error, usage.estCostUsd, …}
GET  <codesec-base-url>/api/runs/:id/events             → SSE (avoid, see traps)
GET  <codesec-base-url>/api/runs/:id/artifacts/response → response.md
GET  <codesec-base-url>/api/runs/:id/artifacts/events   → events.jsonl
GET  <codesec-base-url>/api/runs/:id/artifacts/prompt   → prompt.txt
```

`POST /api/runs` payload that worked in production (generic mode is triggered by `prompt`; never
send `repoUrl`/`skill` with it):

```json
{"sessionId": "<sid>", "prompt": "<HEADLESS_PROMPT>",
 "workspaceHostDir": "<workspaces-root>/<incident-id>",
 "mode": "fix", "model": "<model>", "effort": "high",
 "interactive": false, "indexing": false, "timeoutSeconds": 3600, "ttlMinutes": 60}
```

- `model` is **mandatory** (400 otherwise); an alias (`sonnet`…) or a raw model id.
- `workspaceHostDir` is a **host** absolute path and must fall under the server's
  `OLA_AGENT_WORKSPACES_ROOT` allow-list (403 otherwise); the container bind-mounts it read-write at
  `/workspace/repo`. The archive / evidence directories must stay **outside** that root.
- `interactive:false` and `timeoutSeconds` must be sent explicitly (non-omitted booleans) or the run
  never ends and holds a concurrency slot. `ttlMinutes ∈ {10,30,60,120}`; `timeoutSeconds ∈ [30,14400]`.
- Prompt ≤ 256 KB, delivered to the container as a file; the thick brief is `INCIDENT.md` in the
  workspace, exactly as in this suite.

## Operational traps (all observed in production)

1. **Poll `GET /api/runs/:id` every ~30 s; do not consume the SSE stream** — it hangs after the TTL and
   replays the full history (~200 KB), and you must GET the summary afterwards anyway.
2. **Terminal states by allow-list**: `{completed, failed, expired, aborted}`. Six intermediate states
   exist (`queued`, `cloning`, `indexing`, `scanning`, `awaiting_user`, `awaiting_clarifications`) —
   "not running ⇒ finished" is wrong. **`expired` means success** (the run completed and its TTL lapsed).
3. **Never trust `startedAt` / `finishedAt` / `expiresAt`** (negative int32-truncated values).
4. `429` carries `Retry-After`; back off to `max(Retry-After, poll interval)`, cap ~15 min.
5. `artifacts/patch` and `artifacts/commits` are **always empty** for a mounted worktree (the
   container's git sees dubious ownership); produce the diff on the host — which is what this
   suite's gate does anyway.
6. The container holds **zero git/GitHub credentials**; `git push`, `gh pr create`, `rm -rf`, `--force`
   are auto-rejected in headless mode. Push and PR remain the host's job (this suite's `ship`).
7. Scanner runs as root: set `OLA_AGENT_WORKSPACE_CHOWN=<uid>:<gid>` or the caller cannot delete the
   agent's files. Memory per run is committed up front (`MAX_CONCURRENT_SCANS × memory`).
8. **The API has no authentication layer.** Bind it to loopback only and restart it only with the
   server compose override — a bare `docker compose up` exposes it on all interfaces.

## What the container executor would return

The same attempt dict as `run_agent()`: `agent="codesec"`, `agent_status` from the run summary
(`expired`→`completed`), `agent_cost_usd` from `usage.estCostUsd` (an **estimate** from a price
table when the backend runs on a subscription — label it as such), `fail_class` `agent_error` /
`timeout` / `codesec_busy` (429 exhausted) as applicable, and the artifacts saved as
`agent-response.md` / `agent-events.jsonl`.
