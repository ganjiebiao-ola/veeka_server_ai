---
name: project-onboarding
description: Turn the agent into a new-hire onboarding assistant; triggers on "help me get familiar with this project".
id: skill:project-onboarding
type: skill
owner: alice
version: "0000000000000000000000000000000000000000"
status: active
summary: New-hire onboarding assistant built on the team context system.
use_when: A new hire asks to get familiar with a project or walk through its code.
usage: Mounted under skills/ in its own repo; runtimes discover it via this SKILL.md.
dependencies: []
regression: []
---

# skill:project-onboarding (reference specimen)

A tracked **reference specimen** of a Skill asset. It shows how the #48 metadata **overlays** the
agentskills.io frontmatter (`name` + `description`) a runtime uses for discovery — both coexist,
which is why the schema keeps `additionalProperties: true`.

A production Skill lives in the mount point `skills/` (gitignored), keeps its own `.git`, and is
validated **in its own repo** — not here. This specimen exists only so the `skill` type has a landing
spot in `platform-internals/examples/`.
