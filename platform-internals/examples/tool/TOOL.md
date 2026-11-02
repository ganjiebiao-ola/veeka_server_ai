---
id: tool:openusage-export
type: tool
owner: alice
version: "0000000000000000000000000000000000000000"
status: draft
summary: Packaged CLI wrapper that exports local token-usage statistics.
use_when: A task needs local token-usage numbers without hand-writing API calls each time.
usage: A packaged, agent-callable tool; run its entry point. No credential is committed.
dependencies: []
regression: []
---

# tool:openusage-export (reference specimen)

A tracked **reference specimen** of a Tool asset — a packaged, agent-callable utility with a clear
wrapper boundary and no credential in the repo (it reuses the operator's local permissions, per
`rules/access-and-credentials.md`). Tool packaging and its production home are **#32/#16**; this
specimen only anchors the `tool` type in `platform-internals/examples/`.
