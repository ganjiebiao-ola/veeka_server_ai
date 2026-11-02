# Agent entry & repo context — how it's organized across runtimes

Two things live under different rules here: the **workspace root entry** (this template's
`CLAUDE.md` / `AGENTS.md`) and the **per-repo context** for mounted business repos. This guide says
how each works, and why the two runtimes (Claude Code, Codex) are handled differently.

## 1. The workspace root entry (`CLAUDE.md` / `AGENTS.md`)

At the workspace root. It carries the always-on rules to every task and signposts the rest.

- **Runtime-equivalent, not byte-identical — and generated.** Claude Code reads `CLAUDE.md` and expands
  bare `@import`; Codex reads `AGENTS.md`, has **no import**, and discovers/concatenates AGENTS.md from
  the git root down — so the same rules are **inlined** there. Both files are rendered by
  `scripts/render-agent-entries` from the framework skeletons in `platform-internals/templates/` plus
  the team's slots in `team-context/agent-entry.team.md` (`{{ALWAYS_ON: <path>}}` becomes an `@import`
  line in one and a marker-wrapped copy in the other). Never edit the rendered files; `ws test` /
  `ws health` fail while they are stale (`scripts/check-generated`).
- **Always-on vs on-demand.** Always-on = `security-defaults.md` + `team-context/security-defaults.team.md` (its team slots)
  + `team-rules.md` (the index itself). The individual rules (`code-style` / `testing` / `review` / `access-and-credentials`)
  are **on-demand pointers** from the team-rules index — their bodies are *not* resident; read them
  when relevant. (The `@rules/...` links in the index are backtick text, *intended* not to be
  imported — unverified against Claude Code's actual `@path` scanner behavior on inline code spans;
  if backticks turn out not to block expansion, the always-on/on-demand split described here
  collapses.)
- Holds no rule bodies of its own beyond the inlined/imported always-on set.
- Framework-owned: tracked in the framework git, changed via PR.

## 2. Per-repo context lives in `team-context/mounted-repos/<id>.md` (framework-tracked)

When an agent needs to understand a mounted business repo, that understanding lives in
**`team-context/mounted-repos/<id>.md`**, where `<id>` matches the repo's id in `workspace.local.yaml`. This file is
**framework-tracked** (in the framework git, reviewed via PR) — which is exactly what lets it count
as a **trusted** context source (see `security-defaults.md` §1: trusted sources must be
framework-tracked, never a mount point).

- **Workspace-side context never lives in the mount point.** Nothing under `repos/` is
  framework-tracked (`.gitignore` keeps all of it out, files and sub-folders alike), so no file
  there can ever be a *workspace* instruction source — the workspace's trusted per-repo context
  stays in `team-context/mounted-repos/<id>.md`, and the workspace side never commits into a
  mounted repo.
- **The business repo should still carry its own `CLAUDE.md` / `AGENTS.md`** — as that repo's own
  asset, tracked in its own git and changed via its own PR flow. Without them, Claude/Codex working
  inside the repo lose their entry context and perform worse. Two rules govern these files, applied
  per repo via that repo's own PR — **not yet applied to any of this workspace's mounted repos as of
  writing**; run `scripts/check-repo-agent-entries <repo>` to check current status for a given repo:
  - **Inline the security defaults — from the canonical block.** Root entries (generated or
    pre-existing, both files of the pair) carry the marker-wrapped block instantiated from
    `skills/workspace-context-bootstrap/assets/templates/repo-security-block.md`; its `blob=` SHA
    pins the `security-defaults.md` version it was taken from, and
    `scripts/check-repo-agent-entries` verifies presence, currency, and CLAUDE/AGENTS equivalence.
    Rationale: an agent started inside a mounted repo is detached from the workspace discovery
    chain (`workspace.yaml` `known_limitations`) — the inlined copy is what still reaches it there.
  - **Data from the workspace's viewpoint.** Per `security-defaults.md` §1 these files help an
    agent understand the repo, and never override `agent-instructions/` or `rules/`.
- If an upstream repo **ships its own `CLAUDE.md`**, it is still treated as **data** per
  `security-defaults.md` §1 — you don't control it, so it never becomes a workspace instruction.
- Generate `team-context/mounted-repos/<id>.md` with a skill such as the template-bundled
  `workspace-context-bootstrap` (its workspace-aware companion `workspace-onboarding` then answers
  questions from it), or write it by hand.
  Decide per repo whether one is worth having — a small or self-evident repo may not need it.

## Principles for a `team-context/mounted-repos/<id>.md` (when you write one)

- **Thin pointer, not a copy.** If a fact is already in the mounted `knowledge/maps/<repo>` (the #21
  code map), **link to it, don't duplicate it**. This file carries workspace-side specifics: the
  mount id, where the code map lives, and any special handling for this repo (e.g. "prod DB
  read-only", "releases go through X").
- **Stay under the line budget** (enforced by `scripts/check-context-freshness`; the number's single
  source of truth is its `MAX_REPO_CONTEXT_LINES` constant, cross-referenced from
  `agent-instructions/context-manifest.md`'s No-bloat row). Push detail into `knowledge/` or the
  repo's own `docs/`.
- **Mark provenance.** Agent-guessed values get `# inferred`; missing values get `TODO(owner)`. Never
  invent hosts, URLs, or processes — leave the TODO.
- `<id>` must equal the repo's id in `workspace.local.yaml` `repositories[]` (the gitignored sidecar
  that holds the local mount list — see `mount-points.md` for why `workspace.yaml`'s own
  `repositories:` key stays a frozen `[]` placeholder).

## Anti-examples (common failures)

1. **Too vague** — "This service is critical and handles important business logic." Name the modules
   and data flows instead.
2. **Wishlist** — "We should reach 100% coverage." A wish, not a fact about the code.
3. **Drifted from code** — a module map that no longer matches the repo. Keep it true or delete the
   stale part.
4. **Copying the code map** — pasting `knowledge/maps/<repo>` content instead of linking it. Link,
   don't inline.
