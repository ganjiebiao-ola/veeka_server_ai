# platform-internals/examples/ — asset-metadata reference specimens (#48)

One worked specimen per asset type, each carrying complete #48 frontmatter that validates against
`platform-internals/schemas/asset-metadata.schema.json`. These are **tracked reference specimens** (like
`platform-internals/suites/campaign-stub/`), **not production assets**: they exist so every one of the nine types has a
landing spot today, and so `scripts/check-asset-metadata` has something to check. Delete or replace a
specimen once a real asset of that type exists in its production home (see the type→home map in
`agent-instructions/asset-metadata.md`) — but **wire the real home into the scans first**:
`check-asset-metadata` / `check-asset-refs` default to scanning only this directory (override with
argv[1]), so a specimen deleted before `ws health` covers the production home leaves the real asset
unchecked while health stays green. (Wired so far: the Skill home — template-bundled skills under
`skills/` are scanned by `scripts/check-bundled-skills` inside `ws health`, #119. The skill/
regression-case specimens here stay until the *mounted*-skill story has its own coverage.)

## Coverage checklist (nine types)

What each type *is*, where it lands in production, and what it must satisfy is the type→home table in
`agent-instructions/asset-metadata.md` — that table is the single copy. This one says only what the
**specimen** contributes, so adding a type means editing the spec's table, not both.

| Type | Specimen | What the specimen adds |
|---|---|---|
| instruction | `instruction/EXAMPLE.md` | the minimal required set and nothing else; `reuse_scope: team` |
| prompt | `prompt/PROMPT.md` | **generating** node — carries both pairings (`evaluator:` + `regression:`) |
| skill | `skill/SKILL.md` | #48 fields **overlaid** on agentskills.io `name`/`description` |
| agent-profile | `agent-profile/PROFILE.md` | a role preset expressed purely as metadata |
| workflow | `workflow/WORKFLOW.md` | anchors the type until a real suite contract carries one |
| spec-module | `spec-module/SPEC.md` | anchors the type until #31 gives it a home |
| evaluator | `evaluator/EVALUATOR.md` | **judging** node — `evaluates:` back-pointer |
| regression-case | `regression-case/CASE.md` | **pinning** node — its own `regression` is empty |
| tool | `tool/TOOL.md` | anchors the type until #32/#16 gives it a home |

## The pairing triple

`prompt:campaign-copy` ↔ `evaluator:campaign-copy-eval` ↔ `regression-case:campaign-copy-basic`
demonstrates **both** pairing conventions in one place:

- *Evaluator ↔ generating capability*: the prompt's `evaluator:` and the evaluator's `evaluates:`
  point at each other.
- *Asset ↔ Regression Case*: the prompt and evaluator reference the case via `regression:`; the case
  lists what it tests via `dependencies:`.

## Verify

```sh
python3 scripts/check-asset-metadata
```

Passes when every specimen's frontmatter satisfies the schema (required fields, enums, `id` and
`version` patterns). This is a schema-conformance guard only — it does not run assets, resolve the
pairing cross-references, or judge health (those are #50).
