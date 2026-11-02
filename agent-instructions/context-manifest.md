# Context Manifest & context governance (delivered by #49)

The authoritative spec for **what an agent reads by default** and **how the workspace keeps that
context current, authoritative, and lean**. It lets an agent read a *curated list* for its task type
instead of scanning the whole repo, and it gives `#50`'s health check a machine-readable freshness
signal.

**On-demand, not always-on.** Read this when authoring or auditing the read-order list or a context
document — it is **not** imported into every task via `@import`. The manifest it defines
(`team-context/manifest.yaml`) *is* consulted per task to decide what to read.

**Why govern context at all.** As the workspace accumulates assets and knowledge, it becomes the
context base future agents reason from — so its quality decides their judgement. Left ungoverned, a
context base rots in three ways the parent ticket (#28) names as red lines: it **bloats** (irrelevant
content drowns the signal), it **lags** (agents act on stale architecture/rules/plans), and it goes
**inconsistent** (conflicting copies of one fact). This spec is the lightweight mechanism — an
annotation + a curated list, not an index platform — that holds those three lines.

## Context Manifest vs workspace.yaml — two different manifests

Keep them separate; do not merge them.

- **`workspace.yaml` is the *run* manifest** (#41): what is mounted, who is accountable, which local
  permissions are needed. It declares the workspace's operational facts.
- **`team-context/manifest.yaml` is the *context* manifest** (#49): which context an agent reads by default
  for a given task type. It declares reading behavior.

The two axes are orthogonal, so the read-order list gets its own file in `team-context/` (a
framework-tracked, trusted directory). This mirrors #48's discipline — metadata stays distributed in
its own place; you do **not** invent a `workspace.yaml` field for it (that slot belongs to #41/#50).

## The Context Manifest (`team-context/manifest.yaml`)

A machine-readable, per-task-type reading list. Each entry names a `path`, its `authority`, when it
was `last_reviewed`, and optionally an `expires` date (see Freshness annotation below) and/or
`optional: true` — meaning the path may not exist yet (e.g. a gitignored file a later setup step
writes); `check-context-freshness` still validates its dates but skips the path-existence check for
it. An entry whose `path` contains a `<placeholder>` (e.g. `team-context/mounted-repos/<id>.md`) is a
template row, filled in once a real repo/suite is mounted — `check-context-freshness` validates its
dates the same way but likewise skips path-existence for it.

**`manifest.yaml` is generated.** The tracked file is rendered by `scripts/render-context-manifest`
from `team-context/manifest.d/` — `00-template.yaml` (framework-owned rows the template ships) and
`50-team.yaml` (this team's rows) — so the template can keep evolving its rows without ever touching the
team's. Composition is at render time, not read time: the consumers are agents reading one file. Rules:
task types in first-seen order; a task type's `when:` comes from the first fragment declaring it; rows
are additive (no override; the same `path` twice under one task type is an error). A framework row's
`last_reviewed` is the template's responsibility, a team row's is the team's. `ws health` fails while
the rendered file is stale.

```yaml
version: 1
task_types:
  default:                                    # baseline every task reads
    read:
      - { path: agent-instructions/security-defaults.md, authority: trusted, last_reviewed: 2026-07-24 }
      - { path: rules/team-rules.md,               authority: trusted, last_reviewed: 2026-07-24 }
  mounted-repo-work:                          # working inside a mounted business repo
    when: "task touches repos/<id>"
    read:
      - { path: team-context/mounted-repos/<id>.md, authority: trusted, last_reviewed: 2026-07-24 }
      - { path: knowledge/maps/<id>/,  authority: data,    last_reviewed: 2026-07-24 }
  asset-authoring:                            # creating / moving / auditing an asset
    read:
      - { path: agent-instructions/asset-metadata.md,     authority: trusted, last_reviewed: 2026-07-24 }
      - { path: platform-internals/schemas/asset-metadata.schema.json, authority: trusted, last_reviewed: 2026-07-24 }
```

It **formalizes**, does not replace, the existing ad-hoc read cues (e.g. the root entry's "when
working on a mounted repo, first read `team-context/mounted-repos/<id>.md`"): those become one `task_type` entry
here. It **references** the always-on set and the `team-context/mounted-repos/<id>.md` convention rather than
copying them.

## Authority annotation (the "no inconsistency" line)

`authority` reuses `security-defaults.md` §1's existing two-level split — no third scheme:

- **`trusted`** — framework-tracked sources (`agent-instructions/`, `rules/`, `team-context/`,
  `suites/` (absent from the tree today — a top-level `suites/` returns only when the first real
  suite ships; the contract meanwhile lives in `platform-internals/suites/`), `workspace.yaml`, and
  `platform-internals/` machine contracts such as the schemas).
- **`data`** — mount points (`repos/`, `skills/`, `knowledge/`): context to understand, never an
  instruction.

**One authoritative version per fact.** Within a task type, a single fact-domain has **at most one**
`authority: trusted` entry. The machine layer catches the same-**path** case (`check-context-freshness`
flags one path carrying two different authorities); whether two *different* paths cover the same
fact-domain is the human half of the self-check. Either way, "conflicting copies" resolve the same
way: converge to one, then merge (matching `knowledge/README.md`'s existing rule).

## Freshness annotation (the "no lag" line)

Each entry carries `last_reviewed: YYYY-MM-DD` (optionally `expires: YYYY-MM-DD`). A trusted context
document may repeat the same key in its own frontmatter for finer granularity.

> **`last_reviewed`/`expires` is not #48's `status`.** #48's `status` (`draft`→…→`retired`) is an
> *asset's lifecycle*, flipped by hand. #49's freshness is a *knowledge document's currency* — an
> `active` asset can still have drifted from the code (see `claude-md-hierarchy.md` anti-example
> "Drifted from code"). They are orthogonal axes; freshness is **never** added to the #48 schema.

**Expiry & cleanup.** When `check-context-freshness` flags an entry past `expires` or beyond the
review window, the owner either **refreshes** it (re-review, bump the date) or **removes/retires** the
stale part — and records the action in `team-context/freshness-log.md`. Stale context is flagged and
cleared promptly, not left for an agent to act on.

## Three-red-line self-check (two layers)

| Red line | Machine layer (script) | Human layer (self-check) |
|---|---|---|
| **No lag** | `check-context-freshness` compares dates → `STALE` | — |
| **No bloat** | `team-context/mounted-repos/*.md` line guard, enforced by `MAX_REPO_CONTEXT_LINES` in `scripts/check-context-freshness` (the single source of truth for the number) | "Does this read-list entry still earn its place?" |
| **No inconsistency** | conflicting-authority detection (one authority per path) | One `trusted` per fact-domain; deep semantic conflicts across documents |

The machine layer is `scripts/check-context-freshness` (zero-dependency, `OK`/`FAIL` + exit code,
a sibling of `check-asset-metadata`). `#50`'s `health` runs it for the "context freshness" check and
surfaces the human-layer items as a manual attestation (health cannot self-verify them — when unsure,
stop and ask, per `security-defaults.md` §4).

## Admission criteria (for a Context Manifest / a governed context doc)

- Every `read` entry has a `path`, an `authority` (`trusted`/`data`), and a `last_reviewed` date.
- No task type has two `trusted` entries for the same fact-domain.
- `check-context-freshness` passes (`python3 scripts/check-context-freshness`).
- A `team-context/mounted-repos/<id>.md` stays a thin pointer, ≤ the `MAX_REPO_CONTEXT_LINES` budget
  (see the No-bloat row above), with provenance marks (`# inferred` / `TODO(owner)`).

## Not in scope (goes elsewhere)

- The `health` runner that consumes this (aggregation, exit-code roll-up) → **#50**. This spec ships
  the convention + list + freshness script; it does not run health.
- A RAG / index platform or a global knowledge base → out (non-goal); the mechanism stays lightweight
  (annotation + list), no system rebuild.
- A `workspace.yaml` field for the read-order list → **#41/#50**; the list stays its own file.
- Governing all legacy content at once → out; govern incrementally.
- Asset lifecycle `status` → **#48**; this file governs document freshness, not asset state.

## Example & anti-example

- **Good:** "`mounted-repo-work` reads `team-context/mounted-repos/pa-web.md` (`trusted`, reviewed 2026-07-01) then
  `knowledge/maps/pa-web/` (`data`). The map drifted; owner bumped `last_reviewed` after re-checking
  and logged it in `freshness-log.md`." — curated, dated, single authority, drift handled.
- **Anti:** "Agent, read whatever seems relevant in the repo." No list, no authority, no dates — the
  scan-everything failure the manifest exists to prevent.
