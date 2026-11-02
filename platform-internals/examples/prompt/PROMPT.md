---
id: prompt:campaign-copy
type: prompt
owner: bob
version: "0000000000000000000000000000000000000000"
status: draft
summary: Draft on-brand marketing copy for a campaign from a short brief.
use_when: Generating a first draft of campaign copy that a human then edits.
usage: Fill the brief slots, run, then hand output to evaluator:campaign-copy-eval before ship.
dependencies: []
regression: ["regression-case:campaign-copy-basic"]
evaluator: evaluator:campaign-copy-eval
---

# prompt:campaign-copy (reference specimen)

A tracked **reference specimen** of a Prompt asset, and the **generating** member of the
`prompt ↔ evaluator ↔ regression-case` triple: it points at its evaluator (`evaluator:`) and its
regression case (`regression:`), demonstrating both pairing conventions from one file.

A production Prompt prefers being promoted to a skill or composed into a suite; a bare `prompts/`
directory grows in only once reusable templates accumulate.
