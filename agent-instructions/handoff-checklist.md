# FDE handoff checklist (delivered by #50)

The item-by-item confirmation an FDE walks through when handing a workspace to the business team. The
bar is parent #28's "independent re-run": the team runs the workspace without the FDE. Most items map
to a `ws` command so the check is evidence, not opinion.

**On-demand.** Read this at handoff time; it is not an always-on rule.

## Structure & manifest
- [ ] `scripts/ws validate` passes — required directories/files present, `workspace.yaml` declares all required keys.
- [ ] `workspace.yaml` `owner` names a real human-id; `agent_suites` reflects what is actually mounted. (`workspace.local.yaml` is the real, gitignored mount list — see `agent-instructions/mount-points.md`.)
- [ ] `workspace.local.yaml` `repositories` (gitignored, local) reflects what is actually mounted under `repos/`.
- [ ] `known_limitations` has been read (esp. "run agents from the workspace root").

## Health
- [ ] `scripts/ws health` is green — structure, asset metadata, cross-refs, context freshness, permissions, secret scan. A `[WARN]` is tolerated only for secret scan on a workspace with no `.git` yet (pre-first-commit); after the first commit, secret scan must show `OK`, not `WARN` or `FAIL`.
- [ ] `scripts/ws health --self-test` shows 6/6 — the six planted-problem detectors work in this checkout.
- [ ] `scripts/ws test` and `scripts/ws regression` pass.

## Local permissions (reuse the operator's own — no shared key)
- [ ] `required_local_permissions` is structured `{mechanism, check, guide}`; every `TODO(owner)` (e.g. the IP-allowlist host) is filled.
- [ ] A **non-FDE** member runs `scripts/check-permissions` on their own machine and clears each mechanism (gh CLI, IP allowlist) using the printed guidance.

## Assets & context
- [ ] Real assets carry #48 metadata (`scripts/check-asset-metadata` extended to their home) and their pairings resolve.
- [ ] The Context Manifest (`team-context/manifest.yaml`) lists the read-order for this team's task types; `scripts/check-context-freshness` is green; a stale-content drill is recorded in `team-context/freshness-log.md`.

## Safety
- [ ] Destructive scripts route through `harness_guard` (`scripts/lib/harness.sh`); one interception is demonstrated and recorded in `runs/harness-log.jsonl` (run id + approver). *(`platform-internals/golden/campaign-validator/replay --clean` produces one on demand.)*
- [ ] `scripts/check-secret-scan` prints `OK` (not `WARN`/`FAIL`) — it actually scanned tracked files and found no credential, not merely "nothing to scan yet".

## Independent re-run (the acceptance bar)
- [ ] A non-FDE member runs `scripts/ws init <dir>` from empty, then in the new workspace `scripts/ws golden campaign-validator` — it must end `OK: golden pack campaign-validator replayed (5 stages, 2 planted failures handled)`.
- [ ] Both planted failures were worked through using **only** the pack's own records, with **no** reliance on the original FDE: (a) the AC-2 test failure — `platform-internals/golden/campaign-validator/test/TEST-REPORT-01-ac2-red-to-green.md`; (b) the v2 requirement change written back and re-accepted — `.../TEST-REPORT-02-v2-red-to-green.md`.
- [ ] `scripts/ws test` is green — it runs `platform-internals/golden/*/verify`, so every acceptance row still resolves to a requirement item at the right version.
- [ ] Accountability is clear: the workspace has a single human owner; agent output attributes to the human-id who initiated it (no separate agent identity).
- [ ] The pack's `## Handoff sign-off` table is filled in by both parties (`platform-internals/golden/campaign-validator/PACK.md`). *(Migrating an existing real pipeline is the sibling drill — #45.)*

## After sign-off — retire the training material

A pack is training material, not a permanent fixture: it is someone else's already-recorded work, and it is
**someone else's** recorded work. Once the sign-off table above is filled in, the receiving team
deletes it — keeping it costs every future reader a directory they will never replay twice.

- [ ] Both sign-off rows are filled in (the deletion is what the signature buys, not a shortcut past it).
- [ ] Retire the pack **by id, not by directory** — `platform-internals/golden/README.md` and any
      other pack stay. Order matters: clean the local mounts first, because the entry point lives
      inside the pack.
      1. `platform-internals/golden/campaign-validator/replay --clean` — removes the pack's two
         gitignored scaffolding dirs (its `.mount/` working clone and `.origin/` stand-in upstream)
         behind `harness_guard`: a human approves on `/dev/tty`, and the decision lands in
         `runs/harness-log.jsonl` either way (`security-defaults.md` §2). Do not `rm -rf` these by
         hand — the gated entry exists precisely so this step never bypasses the harness.
      2. `git rm -r platform-internals/golden/campaign-validator/` — the tracked pack; the deletion
         lands via a PR like every other change.
- [ ] Drop the pack's rows from `team-context/manifest.yaml` (`golden-replay`) and the
      `campaign-validator` entry from `team-context/mounted-repos/`.
- [ ] `scripts/ws test` and `scripts/ws health` still pass. They are built to degrade: `ws test`
      skips a missing `platform-internals/golden/*/verify`, `ws golden` reports `no golden sample pack present`,
      and `ws validate` requires `platform-internals/` itself, never a pack inside it. A red build here means
      something other than the pack was deleted with it.

> Keep the pack only for a deliberate reason — onboarding more members later, or authoring a second
> pack against it as a model. "We might need it" is not one; it is in git history either way.
