---
id: campaign-validator
type: golden-sample-pack
level: Lv4
source: olaola-projects/ai-native-issues#44
version: "0000000000000000000000000000000000000000"
entry: platform-internals/golden/campaign-validator/
owner: ericzhang
description: >-
  One requirement carried from structured requirement to acceptance against a zero-dependency toy
  business repo, with two planted failures — a test failure worked back to its acceptance criterion,
  and a requirement change written back and re-accepted.
---

# campaign-validator — a golden sample pack

A complete, replayable loop: **structured requirement → task breakdown → execution → test →
acceptance**, run against a toy business repo cloned with the same `.git` provenance a real mount
has — but kept **inside this pack's directory**, so `repos/` stays reserved for real business
mounts. The spec this pack follows is `platform-internals/golden-sample-pack.md`; the directory's
admission rules are in `platform-internals/golden/README.md`.

Everything here is a real artifact from the recorded loop. `replay` re-runs that loop and **asserts**
both planted failures still happen and both recorded fixes still clear them — so if this material
rots, `ws golden` says so instead of quietly teaching a happy path.

## Trust

`PACK.md` trust = `SUITE.md` trust (`agent-instructions/security-defaults.md` §1): trusted within the scope
declared here. This pack needs **no credential**, touches **no production**, and reaches **no
network**. Its one destructive path (`replay --clean`) is routed through `harness_guard`.

## The five stages

| # | Stage | Artifact | What it demonstrates |
|---|---|---|---|
| 1 | Structured requirement | `requirement/REQ-001-campaign-config-validation.md` | the #26 minimal field set, filled; context read from a manifest list, not a repo scan |
| 1b | Change record | `requirement/REQ-001-changelog.md` | every version bump has a row naming who asked and why |
| 2 | Task breakdown | `breakdown/TASKS.md` | every task points back at an `AC-<n>` |
| 3 | Execution | `execution/EXEC-LOG.md` | one real commit per step, with its diff |
| 4 | Test | `test/TEST-REPORT-01-ac2-red-to-green.md` | planted failure (a): symptom → localization → root cause → fix → green |
| 4b | Test | `test/TEST-REPORT-02-v2-red-to-green.md` | planted failure (b): the requirement moved, so the criteria moved |
| 5 | Acceptance | `acceptance/ACCEPTANCE.md` | one row per `AC-<n>`, each with evidence at the right version |

Supporting: `seed/` (the toy repo's initial state) and `execution/steps/` (the recorded step
variants). Neither is read as documentation — `replay` turns them into git history.

## Planted failures

| ID | Kind | What goes wrong | Report |
|---|---|---|---|
| PF-1 | test failure | the implementation reads `AC-2`'s lower bound as inclusive; a `discount_percent: 0` config is accepted when it must be rejected | `test/TEST-REPORT-01-ac2-red-to-green.md` |
| PF-2 | requirement change | `AC-2`'s cap tightens and a new `AC-3` appears; the existing implementation cannot satisfy criteria that did not exist when it was written | `test/TEST-REPORT-02-v2-red-to-green.md` |

PF-1 is deliberately **not** a typo. Finding it requires re-reading `AC-2` and noticing the
implementation disagrees about whether the bound is open — which is the skill worth teaching. The test
output names the failing case, not the failing line.

## How the toy repo is materialized

The toy repo ships as a tracked **seed** and `replay` materializes it in three moves, all inside this
pack's own directory (the generated dirs are gitignored; `repos/` is never touched — that mount point
is reserved for real business repos):

```
platform-internals/golden/campaign-validator/seed/  tracked; ships with the template; plain files
   │   replay: git init + 4 commits with fixed author/date + 4 tags
   ▼
platform-internals/golden/campaign-validator/.origin/   gitignored; a real git repo standing in for upstream
   │   replay: git clone
   ▼
platform-internals/golden/campaign-validator/.mount/    the working clone: its own .git, an origin remote, 4 tags
```

This still **exercises** `repos/README.md`'s "must be clone, not copy" discipline: the working copy
really is a clone, with real history the framework can read. The four tags are the recorded steps —
advancing through them is `git merge --ff-only`, a real move forward, not a file copy.

| Tag | State | `…/campaign-validator/.mount/test` |
|---|---|---|
| `s1-initial` | v1 implementation, carrying PF-1 | RED |
| `s2-fixed` | the recorded fix for PF-1 | GREEN |
| `s3-v2-cases` | v2 cases land before v2 code (PF-2) | RED |
| `s4-v2-done` | v2 implemented | GREEN |

## Replay it

```sh
scripts/ws golden campaign-validator
```

Ends with `OK: golden pack campaign-validator replayed (5 stages, 2 planted failures handled)`.
Re-running is safe: `replay` never deletes, it resets the work branch back to `s1-initial`. It needs
no controlling terminal, so it runs under CI or an agent just as it does under a person.

To tear the mount down — the one destructive path, and the pack's demonstration of the #50 harness:

```sh
platform-internals/golden/campaign-validator/replay --clean   # blocks unless a human approves on /dev/tty
```

## The full independent re-run (the acceptance bar)

```sh
scripts/ws init ~/ws-demo                    # 1. from an empty directory
cd ~/ws-demo && scripts/ws validate          # 2. structure + manifest
scripts/ws golden campaign-validator         # 3. replay; both planted failures asserted and cleared
scripts/ws test                              # 4. main green line (runs this pack's verify)
scripts/ws health                            # 5. six health checks
platform-internals/golden/campaign-validator/replay --clean   # 6. harness interception, recorded in runs/
```

After step 3, `replay` prints what quick start step 3 (registering a repo in `workspace.local.yaml`)
would look like **for a real business repo** — the toy repo itself is deliberately not registered: it
lives inside the pack, and `workspace.local.yaml`'s `repositories:` stays a list of real mounts only
(`workspace.yaml`'s own `repositories:` key is a frozen `[]` placeholder — see workspace.yaml itself).

## Training path (30 minutes)

1. **Read the requirement** (`requirement/REQ-001-*.md`) — note that §1 lists what was read and why,
   and that §5's `AC-<n>` ids are what everything downstream joins on. (5 min)
2. **Replay** (`scripts/ws golden campaign-validator`) and watch the two RED stages go GREEN. (5 min)
3. **Work PF-1 yourself**: `git -C platform-internals/golden/campaign-validator/.mount checkout -f -B work s1-initial`,
   run `platform-internals/golden/campaign-validator/.mount/test`, and localize the failure *before*
   opening `test/TEST-REPORT-01-ac2-red-to-green.md`. Compare your path to the recorded one. (10 min)
4. **Trace the change** (`requirement/REQ-001-changelog.md`) into all five places it was written back:
   requirement, breakdown, execution log, test report, acceptance record. (5 min)
5. **Break it on purpose**: delete an `AC-3` row from `acceptance/ACCEPTANCE.md` and run
   `scripts/ws test`. Watch `check-golden-pack` catch the broken join. Restore it. (5 min)

## Boundaries

- **The upstream is local.** The pack's `.origin/` stands in for a remote so it replays offline. With
  a real business repo, `git clone` from your remote into `repos/` instead; nothing else in the loop
  changes.
- **The toy repo is a specimen, not a product** — ~150 lines, python3 stdlib + POSIX sh, inside the
  ceiling `platform-internals/golden/README.md` sets for a pack's `seed/`.
- **No wall-clock anywhere in the validation rules.** Rules compare only the dates inside a config, so
  RED and GREEN cannot drift with today's date.
- **POSIX sh.** On Windows, run under Git Bash or WSL — the same assumption `scripts/ws` and
  `platform-internals/suites/*/run` already make.
- **The requirement fields are temporary.** They carry a `spec_source` hook; #26 is the system of
  record once it lands, and `platform-internals/golden-sample-pack.md` holds the mapping.

## Handoff sign-off

| Role | human-id | Date | Confirmed |
|---|---|---|---|
| FDE (handing over) | `TODO(owner)` | `TODO(owner)` | ran the six steps above; both planted failures reproduce and clear |
| Receiving member (non-FDE) | `TODO(owner)` | `TODO(owner)` | completed the re-run without help from the FDE |

Filled in at the real handoff — the names are not invented ahead of time.
