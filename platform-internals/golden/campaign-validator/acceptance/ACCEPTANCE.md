---
req: REQ-001
req_version: v2
current_round: 2
produced_by: "Claude Code (claude-opus-5)"
workspace: ws-61c17c
operator: ericzhang
---

# REQ-001 — acceptance record

One row per `AC-<n>`, per round. A round is a full pass over the criteria as they stand at that
requirement version — not a diff of what changed, because "we only re-checked what moved" is how a
criterion nobody touched quietly stops holding.

Two invariants govern this file, both machine-checked by `scripts/check-golden-pack`:

- **I2** — the latest round covers **exactly** the current `AC-<n>` set. An acceptance row with no
  criterion is an orphan; a criterion with no row was never accepted.
- **I3** — every row's evidence is at a `req_version` **not older than** its criterion's version.
  This is the one that catches the realistic failure: a criterion changes, and last round's green run
  gets quietly reused as proof.

---

## Round 2 — REQ-001 v2 (current)

**Verdict: accepted.** Verified at tag `s4-v2-done`.

| AC | Req version | Criterion | Result | Evidence | Evidence version |
|---|---|---|---|---|---|
| AC-1 | v1 | `end` not after `start` is rejected (`FAIL: AC-1 window`) | PASS (unchanged by v2, re-verified) | `../test/TEST-REPORT-02-v2-red-to-green.md` §Green, case `02-window-order` | v2 |
| AC-2 | v2 | `discount_percent` outside `(0, 60]` is rejected (`FAIL: AC-2 discount`) | PASS | `../test/TEST-REPORT-02-v2-red-to-green.md` §Green, cases `03-zero-discount`, `04-over-cap` | v2 |
| AC-3 | v2 | window longer than 90 days is rejected (`FAIL: AC-3 duration`) | PASS | `../test/TEST-REPORT-02-v2-red-to-green.md` §Green, case `05-long-window` | v2 |

Verify command for every row:

```sh
git -C platform-internals/golden/campaign-validator/.mount checkout -q s4-v2-done && platform-internals/golden/campaign-validator/.mount/test
# 1..5
# OK: campaign-validator tests (5 passed)
```

AC-1 is re-verified even though v2 did not touch it. Carrying Round 1's evidence forward would have
been permitted by I3 (v1 evidence for a v1 criterion), and would still have been the wrong habit: the
implementation moved underneath it between rounds.

---

## Round 1 — REQ-001 v1 — **superseded by Round 2**

Kept as the true record that these criteria were accepted at v1. Deleting it would leave a history in
which the requirement had always been at v2.

**Verdict at the time: accepted.** Verified at tag `s2-fixed`.

| AC | Req version | Criterion | Result | Evidence | Evidence version |
|---|---|---|---|---|---|
| AC-1 | v1 | `end` not after `start` is rejected | PASS | `../test/TEST-REPORT-01-ac2-red-to-green.md` §Green, case `02-window-order` | v1 |
| AC-2 | v1 | `discount_percent` outside `(0, 80]` is rejected | PASS (after PF-1 fixed) | `../test/TEST-REPORT-01-ac2-red-to-green.md` §Green, case `03-zero-discount` | v1 |

> Round 1's AC-2 row is **not** valid evidence for the current AC-2: its criterion says cap 80, the
> current one says 60. That is exactly the substitution I3 exists to prevent — and the reason evidence
> carries a version rather than just a link.

---

## Sign-off

| Role | human-id | Date | Decision |
|---|---|---|---|
| Requirement owner | ericzhang | 2026-07-29 | Round 2 accepted; REQ-001 closed at v2 |
