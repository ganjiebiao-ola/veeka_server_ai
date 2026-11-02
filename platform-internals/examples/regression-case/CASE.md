---
id: regression-case:campaign-copy-basic
type: regression-case
owner: bob
version: "0000000000000000000000000000000000000000"
status: draft
summary: Minimal fixture pinning prompt:campaign-copy output shape and its evaluator verdict.
use_when: Run after editing prompt:campaign-copy or evaluator:campaign-copy-eval to detect regressions.
usage: Provides a fixed brief, an expected-output shape, and the expected evaluator verdict.
dependencies: ["prompt:campaign-copy", "evaluator:campaign-copy-eval"]
regression: []
---

# regression-case:campaign-copy-basic (reference specimen)

A tracked **reference specimen** of a Regression Case asset, and the **pinning** member of the
triple. It is referenced by the prompt's and evaluator's `regression:` fields (the *asset ↔
regression case* pairing) — the way you tell whether editing either one broke what already worked. A
regression case's own `regression` is empty: it is the test, not the thing under test. It rides along
with the assets it tests, not in a top-level directory.
