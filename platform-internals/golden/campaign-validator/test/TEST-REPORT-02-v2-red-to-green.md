---
report_id: TEST-REPORT-02
req: REQ-001
req_version: v2
covers: [AC-1, AC-2, AC-3]
planted_failure: PF-2
produced_by: "Claude Code (claude-opus-5)"
from: "breakdown/TASKS.md T-4, T-5"
workspace: ws-61c17c
operator: ericzhang
---

# PF-2 — the requirement moved, so the code is wrong without having changed

## Symptom

`REQ-001` went to v2 (`../requirement/REQ-001-changelog.md`): AC-2's cap tightened 80 → 60, and AC-3
was added (window ≤ 90 days). The two new cases landed first, at `s3-v2-cases`:

```
ok 1 - 01-valid
ok 2 - 02-window-order
ok 3 - 03-zero-discount
not ok 4 - 04-over-cap: expected exit 1, got 0
    OK: Deep Discount passes all criteria
not ok 5 - 05-long-window: expected exit 1, got 0
    OK: All Summer Long passes all criteria
1..5
FAIL: campaign-validator tests (2 of 5 failed)
```

This failure is a different species from PF-1. **Nothing is defective.** The code satisfies v1
exactly; v1 is simply not what was agreed any more. Reading this as a bug leads to the wrong first
move — opening `validate.py` instead of opening the changelog.

## Localization

**1. Did the code change?**

```sh
$ git -C platform-internals/golden/campaign-validator/.mount diff s2-fixed s3-v2-cases --stat
 tests/cases/04-over-cap.expected   | 2 ++
 tests/cases/04-over-cap.json       | 7 +++++++
 tests/cases/05-long-window.expected| 2 ++
 tests/cases/05-long-window.json    | 7 +++++++
```

Only cases were added. `validate.py` is untouched — so the code did not regress.

**2. What did the requirement say when this code was written?** `REQ-001` §5 now shows AC-2 annotated
`**v2** (was v1: cap 80)` and AC-3 marked `**v2** (new)`. The changelog names both, who asked, and
why. The implementation was correct against v1 and is incorrect against v2 — which is what a
requirement change means.

**3. Which criteria are now unsatisfied?**

| Case | Config | v1 verdict | v2 requires |
|---|---|---|---|
| `04-over-cap` | `discount_percent: 70` | accepted (70 ≤ 80) | rejected (70 > 60) |
| `05-long-window` | `2026-03-01` → `2026-09-01`, 184 days | accepted (no such rule) | rejected (184 > 90) |

AC-1 is untouched by v2, but is re-verified below rather than assumed.

## Root cause

Not a defect. `REQ-001` v2 changed one criterion and added another; `validate.py` at `s2-fixed`
implements v1. The red suite is the correct and desirable state between "the requirement moved" and
"the code caught up" — it is what makes the gap visible instead of leaving it in a ticket comment.

Ordering matters: had the implementation landed first, the suite would have gone green with nothing
ever recording that the requirement moved.

## Fix

Implement v2 — step 04 (`s4-v2-done`) in `../execution/EXEC-LOG.md`:

```diff
-MAX_DISCOUNT = 80  # AC-2: upper bound of the discount range
+MAX_DISCOUNT = 60  # AC-2: upper bound of the discount range (tightened at REQ-001 v2)
+MAX_WINDOW_DAYS = 90  # AC-3: longest campaign window (REQ-001 v2)
...
+    # AC-3 — a window longer than MAX_WINDOW_DAYS days overloads the downstream reporting pipeline.
+    span = (end - start).days
+    if span > MAX_WINDOW_DAYS:
+        problems.append(
+            f"FAIL: AC-3 duration: window is {span} days, must be at most {MAX_WINDOW_DAYS}"
+        )
```

`README.md`'s criteria table gains AC-3 in the same commit.

## Green

```
ok 1 - 01-valid
ok 2 - 02-window-order
ok 3 - 03-zero-discount
ok 4 - 04-over-cap
ok 5 - 05-long-window
1..5
OK: campaign-validator tests (5 passed)
```

All three criteria verified at v2 — including AC-1, which v2 did not change. This report is therefore
the evidence for all three rows in `REQ-001` §5, and satisfies invariant I3: no acceptance row cites
evidence older than its criterion's version.

## Prevention

- **Cases before code, on a requirement change.** The red suite at `s3-v2-cases` is the artifact that
  proves the change was received. Implementing first makes that moment unobservable.
- **Policy numbers live in named constants carrying their AC id** (`MAX_DISCOUNT`, `MAX_WINDOW_DAYS`).
  The next cap change is a one-line edit at a findable place, not a hunt through comparisons.
- **Re-verify criteria the change did not touch.** AC-1 was re-run, not assumed. "Unchanged" is a
  claim about the code's behaviour, and claims are what tests are for.
- **The changelog is the first thing to read, not the last.** PF-2's whole difficulty is mistaking it
  for PF-1; the changelog answers "did the target move?" before anyone opens the implementation.
