---
id: evaluator:campaign-copy-eval
type: evaluator
owner: bob
version: "0000000000000000000000000000000000000000"
status: draft
summary: Scores campaign-copy output for tone and compliance.
use_when: Grading any output of prompt:campaign-copy before it ships.
usage: Run against prompt:campaign-copy outputs; see body for the rubric.
dependencies: ["prompt:campaign-copy"]
regression: ["regression-case:campaign-copy-basic"]
evaluates: prompt:campaign-copy
---

# evaluator:campaign-copy-eval (reference specimen)

A tracked **reference specimen** of an Evaluator asset, and the **judging** member of the triple. It
declares `evaluates: prompt:campaign-copy` (the *Evaluator ↔ generating capability* pairing) and
carries its own `regression`. Evaluators exist **in pairs** with the capability they judge — an
output nobody grades cannot be trusted to stay good. An Evaluator rides along with the asset it
grades; it does not need a top-level directory.
