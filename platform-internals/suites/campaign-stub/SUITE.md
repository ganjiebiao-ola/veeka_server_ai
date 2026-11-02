---
id: campaign-stub
type: campaign
kind: spec-driven-pipeline
level: Lv4
source: olaola-projects/ai-native-issues#43
version: "0000000000000000000000000000000000000000"
entry: platform-internals/suites/campaign-stub/
description: >-
  Reference stub for a campaign (spec-driven pipeline) suite. Demonstrates the three mounting
  requirements — directory location, manifest registration, command entry points — with a
  self-contained no-op payload. Replace with the real #8 suite.
---

# campaign-stub — a mounting demo (not a real suite)

A **tracked reference implementation** of a campaign-type suite contract. Its payload is a
deterministic no-op so the demo runs on a fresh clone with nothing mounted. Delete it when a real
campaign suite is mounted.

## Trust

SUITE.md trust = SKILL.md trust (`agent-instructions/security-defaults.md` §1): trusted within the scope
declared here, but this suite performs **no** destructive action, needs **no** credential, and
touches **no** production. A real suite that does must route destructive actions through the #50
harness block.

## Composes (pointers — none for the stub)

A real campaign suite composes assets by pointer (never by copy), e.g.:

- skill: `skills/spec-review` (mounted)
- spec template: the four-part Spec (feature / UI / technical / framework constraints)
- regression cases: `knowledge/...` (mounted)

The stub composes nothing; it is contract-shape only.

## Command entry points

- `platform-internals/suites/campaign-stub/run` — main flow (stub: prints a marker, exits 0).
- `platform-internals/suites/campaign-stub/test` — tests (stub: asserts this SUITE.md's id/entry are consistent, exits 0).

## Register it (copy into `workspace.yaml` `agent_suites`)

```yaml
agent_suites:
  - id: campaign-stub
    source: olaola-projects/ai-native-issues#43
    version: "0000000000000000000000000000000000000000"   # real suites record the full source SHA
    entry: platform-internals/suites/campaign-stub/
```
