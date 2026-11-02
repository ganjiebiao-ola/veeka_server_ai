---
id: instruction:cite-sources
type: instruction
owner: alice
version: "0000000000000000000000000000000000000000"
status: active
summary: Every conclusion must cite a code location or a test result.
use_when: Applies by default to every task that reports a finding or conclusion.
usage: Read before reporting; cite file:line or test output for each claim.
dependencies: []
regression: []
reuse_scope: team
---

# instruction:cite-sources (reference specimen)

A tracked **reference specimen** of an Instruction asset — it shows the #48 frontmatter shape, not a
rule this workspace enforces (the real always-on rules live in `security-defaults.md`, which is left
untouched on purpose). Delete or replace when authoring a real instruction.

A production Instruction lands in `agent-instructions/` and applies by default to matching tasks.
