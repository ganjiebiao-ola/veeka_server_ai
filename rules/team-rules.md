# <Team> engineering rules (index)

Entry point for this team's engineering rules. This file states precedence and indexes the
individual rule files in this directory. Keep rule bodies in their own files; keep this one short.

## What belongs in `rules/`

The team's engineering-management conventions: coding standards, PR standards, testing requirements,
the ownership field (human-id accountability), collaboration & versioning rules (everything merges via
PR, artifacts version-stamped with the first 6 characters of the commit id, personal-branch
conventions), the credential & permission red line, and code-management rules & legacy-governance
strategy (#10). Legacy governance *strategy* lives here; the executable legacy *suite* is a suite
contract — policy vs suite, don't conflate.

A rule qualifies when it is a convention the team has agreed on, with a clear scope and a named owner.

**Division of labor with `agent-instructions/`**: here you write **how people and the team collaborate**;
agent default-behavior constraints go in `agent-instructions/`.

**What does NOT go here**: business rules and product logic (`knowledge/product/`; the four-part
Spec templates shipped by #31 live in `skills/spec-authoring/assets/templates/`); usage constraints
for a specific skill (write those into the skill's own definition).

Templates delivered by [#42](https://github.com/olaola-projects/ai-native-issues/issues/42) — fill
them in per your team.

## Precedence

1. **Org-level mandatory rules** (cannot be overridden): `TODO(platform team)`.
   <!-- Where org-wide rules live, once defined. The field/manifest that carries this is owned by
        #41/#50 — do not invent a workspace.yaml field here; leave the TODO until it exists. -->
2. **`agent-instructions/security-defaults.md`** — the safety floor. A team rule below never relaxes it.
3. **This team's rules** — this file and the sibling files under `rules/` (evolve as the team needs).

## Rule index

Bodies are read on demand — these links are pointers, not always-on imports:

- `@rules/code-style.md` — coding standards
- `@rules/testing.md` — testing requirements
- `@rules/review.md` — PR / branch / review + responsibility (human-id) + artifact version SHA
- `@rules/access-and-credentials.md` — credential red line & reusing local permissions

## Writing rules

- For every rule, write not just the **what** but the **why**. When agents and new hires
  understand the motive, they make the right call in edge cases the rule never anticipated.
- Every rule names a **human owner** (human-id). Responsibility stays with people and the team,
  not with an agent — this workspace introduces no separate agent identity.
- **One rule, one place.** When an agent needs to be aware of a team rule, `agent-instructions/`
  *references* the file here — it does not copy the text.

## Example & anti-example

- **Good:** "PRs touching `payments/` need two approvals, one from a payments owner — because a
  bad charge is unwinding-expensive and hard to detect. Owner: @alice."
- **Anti:** "Write good code and review carefully." No why, no owner, not checkable.
