---
report_id: TEST-REPORT-01
req: REQ-001
req_version: v1
covers: [AC-2]
planted_failure: PF-1
produced_by: "Claude Code (claude-opus-5)"
from: "breakdown/TASKS.md T-2, T-3"
workspace: ws-61c17c
operator: ericzhang
---

# PF-1 — a case fails and the failure is not where the test points

## Symptom

At `s1-initial`, `platform-internals/golden/campaign-validator/.mount/test`:

```
ok 1 - 01-valid
ok 2 - 02-window-order
not ok 3 - 03-zero-discount: expected exit 1, got 0
    OK: Zero Discount passes all criteria
1..3
FAIL: campaign-validator tests (1 of 3 failed)
```

The validator accepted a config it was supposed to reject. Note what the output does *not* say: no
file, no line, no rule name. It says a config the requirement calls invalid was called valid.

## Localization

Four commands, each ruling out one thing. The order matters — the cheapest disqualifying check first.

**1. Is the case itself wrong?**

```sh
$ cat platform-internals/golden/campaign-validator/.mount/tests/cases/03-zero-discount.json
{ "name": "Zero Discount", ..., "discount_percent": 0, ... }
$ cat platform-internals/golden/campaign-validator/.mount/tests/cases/03-zero-discount.expected
exit=1
contains=FAIL: AC-2 discount
```

The case expects a `discount_percent` of `0` to be rejected. Whether that expectation is *correct* is
a requirement question, not a code question — parked, not answered yet.

**2. Is it the harness or the validator?**

```sh
$ python3 platform-internals/golden/campaign-validator/.mount/validate.py platform-internals/golden/campaign-validator/.mount/tests/cases/03-zero-discount.json
OK: Zero Discount passes all criteria
$ echo $?
0
```

The validator itself accepts it. The test harness is reporting accurately — rules out the harness.

**3. Which criterion should have caught it?** Back to the requirement, not to the code:

> `REQ-001` §5, AC-2 — *a `discount_percent` outside `(0, 80]` is rejected*

`(0, 80]` is a half-open interval: `0` is **excluded**. So AC-2 says this config must be rejected, and
the case is right. The defect is in the implementation.

**4. Where does the implementation disagree?**

```sh
$ grep -n 'MAX_DISCOUNT\|discount' platform-internals/golden/campaign-validator/.mount/validate.py
16:MAX_DISCOUNT = 80  # AC-2: upper bound of the discount range
43:    discount = config.get("discount_percent")
46:    elif not 0 <= discount <= MAX_DISCOUNT:
47:        problems.append(
48:            f"FAIL: AC-2 discount: discount_percent must be in (0, {MAX_DISCOUNT}], got {discount}"
```

Line 46 tests `0 <= discount` — a **closed** lower bound. Line 48 prints `(0, ...]` — an **open** one.
The code contradicts its own message, and the message is the one that matches AC-2.

## Root cause

`validate.py:46` implements AC-2's lower bound as inclusive (`0 <=`) where the criterion states it as
exclusive (`(0,`). A `discount_percent` of `0` therefore passes a check meant to reject it.

This is a **semantic** disagreement between implementation and criterion, not a typo. Nothing crashes,
nothing looks wrong on inspection, and every other case still passes — `01-valid` sits in the middle
of the band and never probes an edge. It surfaces only because AC-2 states an interval and T-3 added a
case at its boundary.

## Fix

```diff
-    elif not 0 <= discount <= MAX_DISCOUNT:
+    elif not 0 < discount <= MAX_DISCOUNT:
```

Recorded as step 02 (`s2-fixed`) in `../execution/EXEC-LOG.md`.

## Green

```
ok 1 - 01-valid
ok 2 - 02-window-order
ok 3 - 03-zero-discount
1..3
OK: campaign-validator tests (3 passed)
```

## Prevention

- `03-zero-discount` now pins the open lower bound. It is not a redundant case: it is the only one
  that distinguishes `<` from `<=`.
- **A criterion stated as an interval needs a case at each end.** `01-valid` (mid-band) cannot fail
  when a bound is wrong by one comparison operator. This generalizes past this validator.
- When a failure message asserts a contract (`must be in (0, 80]`) and the code disagrees with it,
  **the message is evidence** — it usually got written straight from the requirement, while the
  comparison got written from memory.
