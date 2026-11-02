---
req: REQ-001
req_version: v2
produced_by: "Claude Code (claude-opus-5)"
workspace: ws-61c17c
---

# REQ-001 — task breakdown

Every task points back at an `AC-<n>`. A task that cannot name the criterion it serves is either
scope nobody agreed to, or a criterion missing from the requirement — both worth catching here rather
than at acceptance. `check-golden-pack` enforces this (check 3).

Tasks are sized so that each one ends at a runnable command. "Implement the validator" is not a task;
"a config with a backwards window exits 1 and prints `FAIL: AC-1 window`" is.

| Task | Covers | Description | Ends when |
|---|---|---|---|
| T-1 | AC-1 | Reject a config whose `start` is not strictly before its `end`. | `02-window-order` passes |
| T-2 | AC-2 | Reject a `discount_percent` outside the agreed band. *(re-opened by v2 — the band moved)* | `03-zero-discount` and `04-over-cap` pass |
| T-3 | AC-2 | Add the boundary case for a zero discount — the open lower bound has no case pinning it. | `03-zero-discount` exists and passes |
| T-4 | AC-2 | *(v2)* Tighten the cap from 80 to 60 and add the case that pins the new bound. | `04-over-cap` passes |
| T-5 | AC-3 | *(v2)* Reject a campaign window longer than 90 days; add its case. | `05-long-window` passes |

## Notes on the breakdown

**T-3 exists because of a gap, not a feature.** AC-2 states an open lower bound (`(0, ...]`), and the
initial case set had nothing exercising it — `01-valid` sits in the middle of the band and
`02-window-order` tests a different criterion. An untested boundary is where PF-1 lived: the
implementation read the bound as closed and every existing case still passed. The lesson generalizes
past this pack: **a criterion stated as an interval needs a case at each end of it.**

**T-2 is re-opened rather than replaced.** v2 moved the band, so the task that owns AC-2 is not done
any more — even though it was accepted once at v1. Closing T-2 and opening a fresh "T-6: change the
cap" would lose the fact that these are the same obligation at two versions.

**T-4 and T-5 land cases before implementation.** That ordering is what makes the second planted
failure real: at `s3-v2-cases` the suite is red because the criteria moved and the code has not, which
is exactly the state a requirement change puts a codebase into.
