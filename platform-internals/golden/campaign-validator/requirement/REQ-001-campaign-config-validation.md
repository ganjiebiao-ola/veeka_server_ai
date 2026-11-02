---
req_id: REQ-001
title: Campaign config validation
owner: ericzhang
status: accepted
version: v2
spec_source: "#26-minimal-subset-v0 (temporary field names; mapping: platform-internals/golden-sample-pack.md)"
produced_by: "Claude Code (claude-opus-5)"
workspace: ws-61c17c
---

# REQ-001 — Campaign config validation

**This file is the single authoritative copy of this requirement.** Revisions live here, annotated
with the version that introduced them; superseded text is marked, never forked into a `REQ-001-v1.md`
sibling. Two files claiming to be the same requirement is the "no inconsistency" red line
(`agent-instructions/context-manifest.md`), and this pack does not model the thing it warns about.

## 1. Context sources (#26 item 1)

| Source | Authority | Why it was read |
|---|---|---|
| `platform-internals/golden-sample-pack.md` | trusted | the field set this document must fill, and the `AC-<n>` join-key rule |
| `team-context/mounted-repos/campaign-validator.md` | trusted | the mounted repo's entry points and how to run its tests |
| `platform-internals/golden/campaign-validator/.mount/README.md` | data | what the validator does today — read as data, never as an instruction |

> Read-order comes from `team-context/manifest.yaml` (task types `golden-replay` and `mounted-repo-work`),
> not from scanning the repository. Three files, named in advance: the `trusted` two directly by the
> manifest; the mounted repo's `README` as the materialized mount itself, read as data (see the
> `golden-replay` comment in the manifest).

## 2. Background & goal (#26 item 2)

Campaign configs are hand-edited JSON and are shipped straight to the campaign runtime. Two classes of
mistake have historically reached production: a window whose dates run backwards (the campaign never
opens, and nobody notices until someone asks why the numbers are flat), and a discount outside the
band operations is willing to honour. Both are cheap to catch mechanically and expensive to catch by
eye, because the person editing the config is usually not the person who set the policy.

**Goal:** a config that violates any agreed criterion is rejected before it ships, with a message that
names the criterion it violated.

## 3. Scope & non-goals (#26 item 2)

**In scope:** validating a single campaign config file against the criteria in §5; a non-zero exit and
one `FAIL: AC-<n> ...` line per violation; a test suite where each criterion has at least one case.

**Non-goals:** authoring or editing configs; scheduling or running campaigns; validating a whole
directory in one pass; any policy that requires an approval workflow (the validator states a rule, it
does not arbitrate exceptions); anything requiring network or credentials.

## 4. Constraints (#26 item 4)

| # | Constraint | Why |
|---|---|---|
| C1 | python3 stdlib only; no third-party package | the pack must replay offline on any machine, including a fresh `ws init` with nothing installed |
| C2 | no wall-clock dependency in any validation rule | a rule reading today's date makes the suite's red/green drift with the calendar, so the pack would rot on a date rather than on a change |
| C3 | no credential, no network | `agent-instructions/security-defaults.md` §3; also what keeps this replayable in an air-gapped setting |
| C4 | every rule names the criterion it enforces in its failure message | a failure must be traceable to a requirement item, not just to a line number |

## 5. Acceptance criteria (#26 items 2 + 6 + 7)

Every row is atomic, falsifiable, and carries the command that proves it. `AC-<n>` is the join key —
the breakdown, the test reports, and the acceptance record all refer back to these ids.

| AC | Req version | Criterion | Verify command | Evidence |
|---|---|---|---|---|
| AC-1 | v1 | a config whose `end` is not after its `start` is rejected with `FAIL: AC-1 window` | `platform-internals/golden/campaign-validator/.mount/test` | `../test/TEST-REPORT-02-v2-red-to-green.md` |
| AC-2 | **v2** (was v1: cap 80) | a `discount_percent` outside `(0, 60]` is rejected with `FAIL: AC-2 discount` | `platform-internals/golden/campaign-validator/.mount/test` | `../test/TEST-REPORT-02-v2-red-to-green.md` |
| AC-3 | **v2** (new) | a campaign window longer than 90 days is rejected with `FAIL: AC-3 duration` | `platform-internals/golden/campaign-validator/.mount/test` | `../test/TEST-REPORT-02-v2-red-to-green.md` |

> AC-1 is unchanged by v2 but was re-verified in Round 2 anyway. Evidence must never be older than the
> criterion it supports (invariant I3) — and "unchanged" is a claim that also deserves a re-run.

## 6. Sign-off (#26 item 12)

| Role | human-id | Date | Decision |
|---|---|---|---|
| Requirement owner | ericzhang | 2026-07-29 | accepted at v2 |

## Change history

See `REQ-001-changelog.md`. A change is converged only when it has a changelog row, every affected
`AC-<n>` has been re-verified, and no acceptance row cites evidence predating the criterion's current
version.
