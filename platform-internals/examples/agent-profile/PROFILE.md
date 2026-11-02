---
id: agent-profile:security-patch-reviewer
type: agent-profile
owner: bob
version: "0000000000000000000000000000000000000000"
status: draft
summary: Reusable reviewer preset (role, tools, constraints) for security-patch review.
use_when: Reviewing a security patch; load this preset instead of re-specifying the role each time.
usage: A configuration preset applied to a task; see body for the role and constraints.
dependencies: []
regression: []
---

# agent-profile:security-patch-reviewer (reference specimen)

A tracked **reference specimen** of an Agent Profile asset — a reusable **role / tools / constraints
preset**. It is emphatically **not** an agent identity: accountability still lands on the human-id who
runs the task (`security-defaults.md` §4, `rules/review.md`). The reserved home is `profiles/`, which
grows in when real profiles exist; until then the type is anchored here.
