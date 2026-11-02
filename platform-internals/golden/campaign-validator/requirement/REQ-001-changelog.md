# REQ-001 — change history

One row per version of `REQ-001-campaign-config-validation.md`. Invariant I1: a requirement version
with no row here is a silent edit, and `check-golden-pack` fails the pack for it.

A row is not a diff. It answers the questions a diff cannot: **who asked, why, what it invalidates.**

| Version | Date | Raised by | Change | Affected AC | Artifacts to regenerate |
|---|---|---|---|---|---|
| v1 | 2026-07-29 | ericzhang | Initial requirement: window ordering (AC-1) and a discount band of `(0, 80]` (AC-2). | AC-1, AC-2 | — (initial) |
| v2 | 2026-07-29 | ericzhang | **AC-2 cap tightened 80 → 60**, and **AC-3 added**: a campaign window may not exceed 90 days. | AC-2 (changed), AC-3 (new), AC-1 (unchanged, re-verify) | `breakdown/TASKS.md` (T-4, T-5), `execution/EXEC-LOG.md` (steps 03, 04), `test/TEST-REPORT-02-v2-red-to-green.md`, `acceptance/ACCEPTANCE.md` (Round 2) |

## v2 — why

Two separate asks that arrived together:

- **The cap moves to 60.** Operations found that discounts above 60% were being approved case by case
  anyway, through a channel this validator does not model. A validator whose limit is looser than the
  real limit gives false assurance — worse than no check, because people stop looking.
- **A 90-day ceiling on the window (AC-3).** The reporting pipeline materializes a row per campaign-day;
  a multi-month campaign is what pushed the nightly job past its window last quarter. 90 days is the
  number the pipeline owner is willing to commit to, not a round guess.

## v2 — where it was written back

The point of recording a change is that every downstream artifact that assumed the old requirement
gets revisited. Five places, none optional — the same five `PACK.md` and the replay name; this
changelog row is the record of the change itself, not one of them:

| # | File | What changed |
|---|---|---|
| 1 | `REQ-001-campaign-config-validation.md` | `version: v1` → `v2`; AC-2 annotated `**v2** (was v1: cap 80)`; AC-3 added; evidence pointers repointed |
| 2 | `breakdown/TASKS.md` | T-2 marked `re-opened by v2`; T-4 and T-5 added, each pointing back at an AC |
| 3 | `execution/EXEC-LOG.md` | steps 03 (cases first) and 04 (implementation) recorded with diffs |
| 4 | `test/TEST-REPORT-02-v2-red-to-green.md` | authored for v2: the red-before-code run (PF-2) and the green run after `s4-v2-done` |
| 5 | `acceptance/ACCEPTANCE.md` | Round 2 opened covering all three AC; Round 1 kept and marked `superseded by Round 2` |

Round 1 is kept rather than deleted: it is the true record that AC-1 and AC-2-as-of-v1 were once
accepted. Deleting it would make the pack's history a story about a requirement that was always at v2.
