---
req: REQ-001
req_version: v2
produced_by: "Claude Code (claude-opus-5)"
workspace: ws-61c17c
operator: ericzhang
---

# REQ-001 — execution log

One entry per step. Each step is a real commit in the mounted repo, reachable by tag, so "what
changed" is answered by git rather than by prose. `replay` walks these tags with `git merge --ff-only`
— advancing the branch, not copying files over it.

The tracked file variants live in `steps/<nn>-<slug>/` and are what `replay` uses to build the
upstream history. They are **whole files, not patches**: a patch's context lines break the moment
`seed/` is edited, and this pack's whole value is that it still replays years from now.

| Step | Tag | Task | Change | Suite after |
|---|---|---|---|---|
| 01 | `s1-initial` | T-1, T-2, T-3 | v1 implementation and the first three cases | **RED** (PF-1) |
| 02 | `s2-fixed` | T-2 | correct AC-2's lower bound to be exclusive | GREEN |
| 03 | `s3-v2-cases` | T-4, T-5 | v2 cases land before v2 code | **RED** (PF-2) |
| 04 | `s4-v2-done` | T-4, T-5 | implement the v2 criteria | GREEN |

---

## Step 01 — `s1-initial`

The v1 validator and cases `01`–`03`. Suite is red; see
`../test/TEST-REPORT-01-ac2-red-to-green.md` for the investigation.

```
not ok 3 - 03-zero-discount: expected exit 1, got 0
    OK: Zero Discount passes all criteria
1..3
FAIL: campaign-validator tests (1 of 3 failed)
```

## Step 02 — `s2-fixed` (fixes PF-1)

`0 <= discount` reads AC-2's lower bound as inclusive; AC-2 says `(0, 80]`, which is exclusive. One
character.

```diff
--- a/validate.py
+++ b/validate.py
@@ -43,7 +43,7 @@
     discount = config.get("discount_percent")
     if not isinstance(discount, int):
         problems.append(f"FAIL: AC-2 discount: discount_percent must be an integer, got {discount!r}")
-    elif not 0 <= discount <= MAX_DISCOUNT:
+    elif not 0 < discount <= MAX_DISCOUNT:
         problems.append(
             f"FAIL: AC-2 discount: discount_percent must be in (0, {MAX_DISCOUNT}], got {discount}"
         )
```

```
1..3
OK: campaign-validator tests (3 passed)
```

> The message string already said `(0, 80]`. The code and the text it printed disagreed, and the text
> was right — a reminder that a failure message asserting a contract is worth reading as evidence.

## Step 03 — `s3-v2-cases` (creates PF-2)

REQ-001 moved to v2. The two new cases land **before** any implementation change, so the suite states
the gap out loud instead of the gap living in someone's head.

New files: `tests/cases/04-over-cap.json|.expected` (a 70% discount, now over the cap),
`tests/cases/05-long-window.json|.expected` (a 184-day window).

```
not ok 4 - 04-over-cap: expected exit 1, got 0
    OK: Deep Discount passes all criteria
not ok 5 - 05-long-window: expected exit 1, got 0
    OK: All Summer Long passes all criteria
1..5
FAIL: campaign-validator tests (2 of 5 failed)
```

Both failures are honest: the code was written against v1 and satisfies v1 exactly.

## Step 04 — `s4-v2-done`

Implements the v2 criteria. `README.md`'s criteria table gains AC-3 in the same commit — a criterion
the code enforces but the repo's own docs do not mention is how the next reader learns to distrust the
docs.

```diff
--- a/validate.py
+++ b/validate.py
@@ -13,7 +13,8 @@
 import json
 import sys

-MAX_DISCOUNT = 80  # AC-2: upper bound of the discount range
+MAX_DISCOUNT = 60  # AC-2: upper bound of the discount range (tightened at REQ-001 v2)
+MAX_WINDOW_DAYS = 90  # AC-3: longest campaign window (REQ-001 v2)

@@ -48,6 +49,13 @@
             f"FAIL: AC-2 discount: discount_percent must be in (0, {MAX_DISCOUNT}], got {discount}"
         )

+    # AC-3 — a window longer than MAX_WINDOW_DAYS days overloads the downstream reporting pipeline.
+    span = (end - start).days
+    if span > MAX_WINDOW_DAYS:
+        problems.append(
+            f"FAIL: AC-3 duration: window is {span} days, must be at most {MAX_WINDOW_DAYS}"
+        )
+
     return problems
```

```
1..5
OK: campaign-validator tests (5 passed)
```

`MAX_DISCOUNT` and `MAX_WINDOW_DAYS` are named constants carrying the AC id in a comment, so the next
requirement change has one place to land — see `../test/TEST-REPORT-02-v2-red-to-green.md` §Prevention.
