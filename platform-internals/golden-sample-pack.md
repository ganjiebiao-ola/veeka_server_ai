# Golden sample pack & the structured-requirement minimal field set (delivered by #44)

The authoritative spec for a **golden sample pack**: one requirement carried end to end — structured
requirement → task breakdown → execution → test → acceptance — with a real, tracked artifact at every
stage, and with failure deliberately planted so that working through it is part of the material. A
pack is the thing a new team **replays** rather than reads about.

**On-demand, not always-on.** Read this when authoring, auditing, or replaying a pack under `platform-internals/golden/`
— it is **not** imported into every task. `team-context/manifest.yaml`'s `golden-replay` task type names
what to read when you do.

**Why a golden sample pack at all.** Every other ticket in #28 delivered a *convention*: a directory
skeleton, an asset metadata schema, a read-order list, an execution interface. Conventions are
checkable in isolation and still collectively unusable — nothing proved a person could start from an
empty directory and come out the other end with an accepted piece of work. That gap has a name in the
parent's acceptance bar: *"a non-FDE member … handles one planted failure … with no reliance on the
original FDE."* A sample pack is how that sentence becomes runnable. It also decides what "handoff"
means: a pack that replays is a training material; a walkthrough that only its author can reproduce is
a demo, and demos do not survive the person who gave them.

## What a golden sample pack is (and is not)

- It is **a record of one real piece of work**, not a reusable asset. Nothing in a pack carries #48
  metadata — an asset is something you compose into future work; a pack is evidence that a loop closed.
- It is **executable**. `replay` re-runs the recorded loop and *asserts* each planted failure occurs
  and each recorded fix clears it. A pack that stops replaying is broken, and `ws test` says so.
- It is **deletable**. A team that has learned from a pack should delete it. Nothing in the workspace
  skeleton depends on `platform-internals/golden/` existing (`ws validate` does not require it; `ws test` degrades to a
  no-op when the directory is gone).

## The five stages and their artifacts

| # | Stage | Directory | Artifact | What proves it happened |
|---|---|---|---|---|
| 1 | Structured requirement | `requirement/` | `REQ-<n>-<slug>.md` + `REQ-<n>-changelog.md` | the field set below, filled |
| 2 | Task breakdown | `breakdown/` | `TASKS.md` | every task points back at an `AC-<n>` |
| 3 | Execution | `execution/` | `EXEC-LOG.md` + `steps/<nn>-<slug>/` | a real commit per step, diff included |
| 4 | Test | `test/` | `TEST-REPORT-<nn>-<slug>.md` | symptom → localization → root cause → fix → green |
| 5 | Acceptance | `acceptance/` | `ACCEPTANCE.md` | one row per `AC-<n>`, each with evidence |

The pack's own contract is `PACK.md` (id, stages, planted failures, boundaries, training path) — the
same shape a suite declares in `SUITE.md`.

## Structured requirement — the #26 minimal subset

#26 (Super Ticket Template) defines twelve first-class items. A sample pack consumes **six** of them
and explicitly defers the rest — deferring by name, never by silence, so a reader can tell a decision
from an oversight.

```markdown
---
req_id: REQ-001
title: <one line>
owner: <human-id>                 # accountable person; not an agent identity
status: drafted | breakdown-done | in-execution | verified | accepted
version: v1                       # bump on every change; every version needs a changelog row
spec_source: "#26-minimal-subset-v0 (temporary field names; mapping: platform-internals/golden-sample-pack.md)"
produced_by: "<tool/model that drafted it>"
workspace: ws-<sha6>              # workspace commit this revision was written against
---

## 1. Context sources (#26 item 1)
| Source | Authority | Why it was read |
|---|---|---|
> Read-order comes from `team-context/manifest.yaml`, not a repo-wide scan.

## 2. Background & goal (#26 item 2)
## 3. Scope & non-goals (#26 item 2)

## 4. Constraints (#26 item 4)
| # | Constraint | Why |
|---|---|---|

## 5. Acceptance criteria (#26 items 2 + 6 + 7)
| AC | Req version | Criterion | Verify command | Evidence |
|---|---|---|---|---|

## 6. Sign-off (#26 item 12)
| Role | human-id | Date | Decision |
|---|---|---|---|

## Change history
See `REQ-<n>-changelog.md`.
```

### Mapping to #26 (the single copy of this table)

| #44 temporary field | #26 item | Action when #26 lands | Note |
|---|---|---|---|
| `context_sources` (§1) | 1 knowledge-base support | rename to #26's field | rows come from `team-context/manifest.yaml` |
| `background` / `goal` (§2) | 2 main requirement doc | rename | |
| `scope` / `non_goals` (§3) | 2 main requirement doc | rename | |
| `constraints` (§4, `C<n>`) | 4 technical constraints | rename | every row carries a `Why` |
| `acceptance_criteria` (§5, `AC-<n>`) | 2 + 6 + 7 | **the `AC-<n>` id scheme must survive** | it is the join key |
| `sign_off` (§6) | 12 human sign-off | rename | human-id + date + decision |
| — | 3, 5, 8, 9, 10, 11 | **not adopted by #44** | design-final, code, release plan, production acceptance, data loop, feedback → #26 / #19 / #36 |

> **`AC-<n>` is the one thing that must not be renamed.** It is the join key between the requirement,
> the breakdown, the test reports, and the acceptance record — and the key
> `scripts/check-golden-pack` closes over. Rename it and four files silently stop referring to each
> other.

**Realigning when #26 is final** — three steps, in order: (1) `grep -rl spec_source` lists every file
to touch; (2) rename field by field, deleting the mapping row as each one lands; (3) once the table is
empty, set `spec_source` to `#26-v1`. Check 6 of `check-golden-pack` fails if a requirement uses a
field the mapping table does not list, so drift shows up as a red build rather than as a surprise.

## Ordered convergence — the three invariants

A requirement that changes mid-flight is the normal case; a requirement that changes *without the
acceptance record following it* is how a project stops knowing what it agreed to. Three invariants,
each machine-checked:

| | Invariant | Failure it prevents |
|---|---|---|
| I1 | Every `version` in the requirement frontmatter has a changelog row | a silent edit |
| I2 | The latest acceptance round covers **exactly** the current `AC-<n>` set | an orphan acceptance row, or an unverified requirement item |
| I3 | Each AC's evidence file has `req_version` **not older than** that AC's `Req version` | passing off pre-change evidence as proof of a post-change criterion |

**A requirement is one file.** Revisions live *in* it, annotated with the version that introduced
them (`**v2** (was v1: cap 80)`); superseded rows are marked, never forked into a `-v1.md` sibling.
Two files claiming to be the same requirement is exactly the "no inconsistency" red line from
`context-manifest.md` — a pack cannot teach governance while modelling its violation.

## Planted failures — why every pack must carry at least one

A recorded loop where everything worked the first time teaches the one thing that never happens. Each
pack plants at least one failure and records how it was worked through; `replay` asserts the failure
still occurs, so the teaching material cannot quietly rot into a happy path.

A planted failure is worth planting when finding it requires **re-reading the requirement** — a
boundary the implementation got subtly wrong beats a typo, which teaches only that typos exist.

Two shapes cover the ground:

- **A test failure** — implementation disagrees with an acceptance criterion; localize, fix, go green.
- **A requirement change** — the criterion itself moves; write it back and re-accept against it.

The pack states its planted failures in `PACK.md`; check 7 verifies each has a report with a real
`## Root cause` and `## Green` section.

## Verify

```sh
python3 scripts/check-golden-pack        # static closure over every pack under platform-internals/golden/
scripts/ws golden PACK_ID                # replay the loop, asserting the planted failures
```

## Admission criteria

- The pack has all five stage directories, each with a real artifact — no placeholders.
- Every acceptance row resolves to a current `AC-<n>`, and vice versa (I2).
- Every planted failure declared in `PACK.md` has a report with root cause and green output (I1, I3).
- `replay` is idempotent, needs no controlling terminal on its main path, and routes its one
  destructive path (`--clean`) through `harness_guard`.
- Nothing in the pack carries #48 asset metadata, and no file name or content trips
  `check-secret-scan`.

## Not in scope (goes elsewhere)

- The full Super Issue lifecycle and the final field names → **#26**; this spec takes a minimal subset
  under temporary names and carries the mapping back.
- A regression/evaluation system → **#36**; a pack's `test/` records one loop, it is not a suite.
- The evidence-chain format for AI-assisted acceptance → **#19**; the pack's `Evidence` column is a
  pointer, not a provenance scheme.
- Migrating an existing real pipeline into workspace shape → **#45**; that is the sibling drill against
  real code, this one is a controlled, self-contained specimen.
- A second project type → out (non-goal); one type replayed end to end is the bar.

## Example & anti-example

- **Good:** "`AC-2` moved from `(0, 80]` to `(0, 60]` at v2. The changelog names who asked and why;
  `ACCEPTANCE.md` opened Round 2 and marked Round 1 `superseded`; `AC-2`'s evidence now points at
  `TEST-REPORT-02` (`req_version: v2`); `check-golden-pack` confirms no acceptance row still cites v1
  evidence." — the change is written back, and the write-back is checkable.
- **Anti:** "The sample shows the complete workflow from requirement to acceptance." Nothing is
  falsifiable — no join key, no assertion, no failure. A reader cannot tell whether the loop closed or
  whether someone wrote down that it did.
