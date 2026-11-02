# runs/ — run records (#50), format spec

A lightweight, append-only audit trail of workspace command runs and harness decisions. Each `ws`
invocation and each destructive-action gate appends one JSONL line here.

**Local, not committed.** `runs/*` is gitignored (records may hold local paths and are per-operator);
what *is* tracked lives in `platform-internals/`: this format spec and
`runs-example-harness-block.jsonl` (a scrubbed demo specimen). A record must never contain a
credential — that is the same red line `scripts/check-secret-scan` enforces.

## Three logs

**`run-log.jsonl`** — one line per `ws` invocation:
```json
{"run_id":"run-20260724T101500Z-2f0ce51","ts":"2026-07-24T10:15:00Z","workspace_sha":"<full 40-hex>","command":"ws health","exit_code":0,"operator":"ericzhang"}
```

**`harness-log.jsonl`** — one line per destructive-action gate (see `scripts/lib/harness.sh`):
```json
{"run_id":"run-20260724T101812Z-2f0ce51","ts":"2026-07-24T10:18:12Z","workspace_sha":"<full 40-hex>","action":"git push --force origin main","target":"origin/main","decision":"blocked","approver":null,"channel":"no-tty"}
```

**`golden/<pack>/replay-log.jsonl`** — one line per golden-sample-pack replay (#44):
```json
{"run_id":"replay-20260729T092623Z-f020a7a","ts":"2026-07-29T09:26:23Z","workspace_sha":"<full 40-hex>","pack":"campaign-validator","stages":9,"planted_failures":2,"exit_code":0,"operator":"ericzhang"}
```

A replay is logged whether it passes or fails — a pack whose recorded loop stopped reproducing is the
thing most worth having a record of. `ws golden <pack>` therefore leaves two lines: the `ws`
invocation in `run-log.jsonl` and the replay itself here. Running `replay` directly still leaves this
one.

## Fields

- `run_id` — `run-<UTC compact>-<short-sha>` (`replay-…` for replay-log lines); correlates a
  run-log line with its harness events.
- `ts` — UTC ISO-8601.
- `workspace_sha` — the **full** workspace commit SHA in effect at run time.
- `command` / `action` — the `ws` subcommand / the destructive action guarded.
- `target` — what the destructive action would touch.
- `pack` / `stages` / `planted_failures` — replay only: which golden pack ran, and what it asserted.
  `stages` counts the replay's executed stages (9 for `campaign-validator`), not the pack's five
  stage *directories* — the replay's closing "5 stages" line refers to the latter.
- `exit_code` / `decision` — outcome (`0..n` / `approved`|`blocked`).
- `operator` / `approver` — the **human-id** who ran it / who approved it.
- `channel` — how approval was obtained: `tty` (a human at the controlling terminal) or `no-tty`
  (no terminal → fail-safe blocked).

## Provenance notes (versioning boundaries)

- `workspace_sha` here is the **same source** as `rules/review.md`'s artifact `ws-<sha6>` (both are
  the workspace commit), but a **different use**: this is a run-audit trail, that is artifact naming.
  Do not conflate them.
- `operator`/`approver` are **human-id**s (the accountability convention, `rules/review.md`) — not the
  `owner` field of the #48 asset metadata.
- Format is aligned toward the **#19 evidence chain** for later provenance evolution; #19 has no anchor
  in the repo yet, so full lock/provenance is out of scope here (a placeholder, per #50 non-goals).
