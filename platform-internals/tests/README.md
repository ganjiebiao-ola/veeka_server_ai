# platform-internals/tests/ — planted problems for `ws health --self-test` (#50)

Six isolated, inert fixtures — one per class of problem `ws health` must detect. They live **outside
`platform-internals/examples/`** on purpose, so the real asset scanners (`check-asset-metadata`, `check-asset-refs`) do
**not** pick them up and the main green line stays green. `ws health --self-test` scans this directory
and asserts each planted problem is caught (6/6), proving the detection capability without failing
normal health.

| Fixture | Class | Planted problem | Detected by |
|---|---|---|---|
| `missing-asset/ASSET.md` | missing asset | `evaluator:` points at a non-existent id | `check-asset-refs` (cross-ref resolution) |
| `wrong-version/ASSET.md` | wrong version | `version` is not a valid SHA | `check-asset-metadata` (schema version pattern) |
| `stale-context/fragment.yaml` | stale context | an `expires` date in the past | `check-context-freshness` (pointed at the fragment) |
| `regression-decay/CASE.md` | regression decay | a regression case whose `dependencies` no longer resolve | `check-asset-refs` (cross-ref resolution) |
| `unguarded-destructive/bad.sh` | destructive-op unguarded | a force-push not routed through `harness_guard` | the self-test's built-in scan — no standalone lint exists yet |
| `empty-asset-dir/` (no asset) | vacuous green | an asset scan with nothing to scan | `check-asset-metadata` — `checked == 0` is a FAIL |

The first five plant a **wrong fact**; the sixth plants the **absence of any fact to check**. That
asymmetry is deliberate: a workspace whose assets were deleted used to pass every check precisely
because there was nothing left to disagree with, which is the one failure mode the other five cannot
see. Keep `empty-asset-dir/` empty — putting an asset in it disarms the detector it exists to prove.

These files are never executed and carry no credentials; they are data scanned by the self-test.

**This directory is not optional.** It is what makes a green `ws health` mean something: without it,
the six detectors are claims rather than demonstrated behavior. It costs ~60 lines and `ws validate`
does not require it — deleting it is silent, which is exactly why it is called out here.
