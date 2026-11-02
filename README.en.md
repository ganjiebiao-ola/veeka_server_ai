# AI Workspace Template

English | [简体中文](README.md)

A team-level AI-Workspace is a **skeleton for AI capability**: no business code, no capability of its
own — only structure, mount points, and conventions. Your team `git clone`s its **business repos,
reusable skills, and knowledge bases** into the mount points, and the framework organizes them,
together with your context and engineering rules, into one environment that agents and members can
reliably **read, compose, and reuse**. Content is always mounted in, never copied in, and keeps its
own version.

**Why bother — information equality.** Without a framework, who can use AI comes down to individual
experience, and capability stays locked in a few heads. Once repos are wrapped in the framework, tacit
knowledge becomes explicit assets an agent can consume and anyone can reuse: a member new to a project,
or not skilled at prompting, draws on the same context and produces work of the same quality. Every
design trade-off downstream is judged by "does this lower the barrier."

## Quick start

1. **Create your repo** from this template ("Use this template" on GitHub, or clone and change the remote).
2. **Mount your assets** — `git clone` (never copy) business repos → `repos/`, skills → `skills/`,
   knowledge bases → `knowledge/`. Several workspace-native skills already ship with the template
   (see `skills/README.md` for the list); mount more as needed.
3. **Edit `workspace.yaml`** — fill in the owner and replace `repo_catalog` (and optionally `skill_catalog`)
   with your team's real lists; `repositories:` stays a frozen `[]` (the real mount list is the gitignored
   `workspace.local.yaml`, kept by `scripts/setup-repos`).
4. **Check it** — `scripts/ws validate`, then `scripts/ws health`.
5. **(Optional) Generate the code map** — `ws map install` installs `codebase-memory-mcp` to
   `~/.local/bin` (no sudo), then `ws map generate --all` writes `knowledge/maps/<id>/README.md`
   for every mounted repo; `ws map verify` smoke-tests the result. Fully unattended: a repo with no
   `.cbmignore` yet gets one written first by your own agent CLI (`--no-auto-cbmignore` to skip).
   Backs the `code-map-query` skill's structural queries — skip it and everything else above
   still works.

Then fill in your team's rules in `agent-instructions/` and `rules/` as you go. **Directories may stay
empty — do not try to fill everything on day one.** The security defaults are already active out of
the box.

> **You only need to read two documents to start: this one and
> [`agent-instructions/mount-points.md`](agent-instructions/mount-points.md).** Everything else is reached on
> demand from the tables below.

## Syncing with the upstream template (downstream teams: read this)

A workspace created from this template is the **downstream**; this repo is the **upstream**. Upstream keeps
improving and downstream pulls those changes in regularly. There is one rule:

**Use `merge`. Never `rebase`.**

- Every path has exactly one owner (`platform-internals/ownership.yaml`): framework paths are byte-identical
  on both sides, so a merge cannot conflict on them; seed files (`README`, `rules/`, `workspace.yaml`, …)
  keep your version through `.gitattributes merge=ours`; `CLAUDE.md` / `AGENTS.md` /
  `team-context/manifest.yaml` are rendered — re-render after the merge.
- A rebase makes git swap ours / theirs: seed files get replaced by the upstream version and **your edits
  vanish silently, with no conflict** (`scripts/lib/merge-keep-team` catches that mistake, but a rebase still
  needs a force-push, which the ship script refuses).
- The sync PR must be merged with a **merge commit**. A squash resets the merge base, and the next sync
  replays every change again.

The bundled `workspace-upstream-sync` skill runs the steps: say "sync with the template" to your agent and it
will `git merge upstream/main`, record the synced upstream commit with `scripts/upstream-pin`, re-render, run
`ws validate / health / test`, then push and open the PR through `scripts/sync-upstream-ship`. A workspace
adopting the ownership model for the first time follows that skill's "First adoption" section.

The other direction — generic changes to framework paths (`agent-instructions/`, `scripts/`, bundled skills, …)
— goes upstream first: cut a `contrib/<topic>` branch from this repo's `main`, open the PR here, then sync it
down. A local edit to a framework path turns the `ownership` line of `ws health` red. Upstream changes to seed
files do not reach you automatically — adopt them by hand from [`CHANGELOG.md`](CHANGELOG.md).

## Keeping the workspace up to date

Teammates keep merging PRs into this workspace's `main`. Each time Claude Code or Codex starts a session,
it checks whether your clone is behind `origin`'s default branch (fetching at most once an hour, so start-up
stays fast). When you are behind, the agent tells you and offers to update; **only after you agree** does
the bundled `workspace-update` skill run: it says what teammates changed, runs `git pull --ff-only origin <default branch>`, and
walks the follow-ups (restart the session when entry or hook files changed, newly catalogued repos and
skills, …). You can also say "update my workspace" at any time, or check by hand:

```sh
scripts/ws freshness
```

It updates this workspace only — never `repos/` (that is `scripts/update-repos`) and never the upstream
template (that is `workspace-upstream-sync`, above). Codex runs a project hook only after you review it: the
first time, open `/hooks` in Codex and trust this hook in `.codex/hooks.json`.

## Using the bundled skills

The workspace-native skills that ship with the template live under `skills/` (full list: [`skills/README.md`](skills/README.md)). Claude Code / Codex discover
them automatically at the workspace root — no install step. Trigger one by stating the task in chat,
or invoke it explicitly with `/<skill-name>`:

| skill | When to use | Example (say it to the agent) |
|---|---|---|
| `workspace-context-bootstrap` | A new business repo was mounted and needs its trusted per-repo context | "Bootstrap repos/mall-backend and write its team-context file" |
| `workspace-onboarding` | A new hire wants a guided, citation-backed tour and ramp-up plan | "I'm new here, walk me through this workspace" |
| `spec-authoring` | Lift a requirement doc / raw material into a four-part structured Spec | "/spec-authoring — the project is an XX match-3 minigame, engine leaning cocos, material in this doc"; for an existing Spec: "run a gap check on it" |
| `token-usage-analysis` | Analyze your own local AI-coding token consumption (data never leaves this machine; sanitized report under `runs/`), with task-instance drill-down and a local HTML page | "Analyze my local token usage for the last 30 days — which repo burns the most?"; "break down these two weeks by task — where did tokens burn, with what result?" |
| `ai-usage-weekly` | Weekly AI-usage update (usage / cost / what it was used for / value produced): local usage × price table = an **estimated** cost, an AI-drafted, human-confirmed narrative, one submission file in the team reports repo; the lead aggregates a week into the team report page (no ranking by cost; three amounts kept apart, never summed) | "Write my weekly AI usage update and submit it"; lead: "build the team AI usage report for 2026-W37" |

`token-usage-analysis` is the chat entry point (a skill), driven by two report scripts underneath —
which you can also run directly, no chat needed (full commands and the optional ccusage install
note are in [`skills/README.md`](skills/README.md)):

```sh
scripts/token-usage-report                # aggregate report: five threads + cost + cross-check
scripts/token-usage-report --html --open  # same, rendered as a local HTML page
scripts/token-usage-tasks report          # task instances: where it burned, doing what, result
```

`ai-usage-weekly` builds on it and can be run directly too (reports repo defaults to
`knowledge/ai-usage-reports/`; when it is missing, `submit` creates a local one and prints how to
connect it to the team's repo; the tool never pushes or networks — `--commit` is a local commit only):

```sh
scripts/ai-usage-weekly submit --week 2026-W37          # local usage + estimate → reports/<week>/<human_id>.{json,md,html}
scripts/ai-usage-weekly team --week 2026-W37 --open     # lead: aggregate the week → team-report.html/.md
scripts/ai-usage-weekly request --form <request.json>   # resource-request draft (company approval flow; the tool never approves)
scripts/ai-usage-weekly month --allocation <september_2026.xlsx>   # lead: monthly report (real cost by team + weekly roll-up + repos) → reports/months/<YYYY-MM>/
```

**token-usage-analysis examples**:

- **Example 1 · monthly overview** — say: "Analyze my local token usage for the last 30 days —
  which repo burns the most?" The skill states the privacy contract first (data never leaves this
  machine; sanitized report), then interprets the five threads — daily trend and spike days,
  mounted-repo × branch ranking, model mix, session patterns — and asks whether you want a
  **local HTML page** or a **terminal digest**. Reports land in `runs/token-usage/` (gitignored).
- **Example 2 · task retrospective** — say: "Break down these two weeks by task — where did tokens
  burn, with what result?" You get the task-instance view: one auto-split instance per row (stage
  sequence like explore→edit→test, per-stage tokens, git signals), optionally labeled for a more
  accurate retrospective:
  `scripts/token-usage-tasks annotate --instance '<id-from-report>' --result success --ref '#123'`

Outputs respect the mount rules: anything written into a business repo goes through **that repo's own
branch/PR**. Each skill's full workflow and hard rules live in its own `SKILL.md`; the list is in
[`skills/README.md`](skills/README.md).

## Directories

| Path | What it is |
|---|---|
| `CLAUDE.md` / `AGENTS.md` | Agent root entry (signpost) — Claude Code and Codex respectively; runtime-equivalent, not byte-identical |
| `workspace.yaml` | Workspace declaration: owner, mounted repos, local permissions, known limitations |
| `agent-instructions/` | Agent policy — security defaults (always on) + the on-demand specs below |
| `rules/` | Team engineering rules (coding / PR / testing / ownership); start at `rules/team-rules.md` |
| `team-context/` | **Framework-tracked** per-mounted-repo context (`team-context/mounted-repos/<id>.md`) + the read-order manifest — trusted sources |
| `repos/` `skills/` `knowledge/` | **The three mount points** — see `agent-instructions/mount-points.md` |
| `suites/` | **Framework-tracked** suite contracts, commands, and tests, registered in `workspace.yaml`. `sre-autofix` produces fix PRs. `sre-inspect` produces root-cause reports. `security-patch` includes its app and agent instructions for batch security PRs. Start at each suite's `docs/quickstart.md`. Convention: `platform-internals/suites/README.md`. |
| `scripts/` | The `ws` execution interface (`init` / `validate` / `test` / `regression` / `health` / `golden`), zero-dependency `check-*` guards, and `lib/harness.sh` |
| `platform-internals/` | The self-proving layer — fixtures, specimens, schemas, and the golden sample pack. Platform-maintained; **you never need to read it** — except `ownership.yaml`, which says which paths are the template's and which are yours |
| `CHANGELOG.md` | Upstream changes to seed files (README, rules, workspace.yaml, …), for downstream teams to adopt by hand |

One more appears as you work, gitignored: `runs/` (local run records, created on first `ws` call).
A golden-pack replay keeps its scaffolding inside its own pack directory (`.origin/` + `.mount/`,
also gitignored) — nothing it generates touches the mount points.

## `agent-instructions/` — what loads when

Each file states what it is; the one thing you cannot see from any single file is **when it loads**:

| File | Loads | Ticket |
|---|---|---|
| `security-defaults.md` | **always on** — imported into every task, not overridable by anything downstream | #42 |
| `mount-points.md` | on demand — mounting anything, or deciding where something belongs. **Read this one up front.** | #93 |
| `claude-md-hierarchy.md` | on demand — writing or reviewing a `CLAUDE.md` / `AGENTS.md` | #42 |
| `asset-metadata.md` | on demand — authoring, moving, deprecating, or auditing an asset | #48 |
| `context-manifest.md` | on demand — authoring or auditing a read-order list or a context doc | #49 |
| `handoff-checklist.md` | on demand — at handoff | #50 |

Only the first row is `@import`ed by `CLAUDE.md` (and inlined into `AGENTS.md`). The rest are reached
by task type through `team-context/manifest.yaml` — that file, not this table, is what an agent consults.

## Three ground rules

- **People are accountable** — one human owner per workspace (in `workspace.yaml`); agents collaborate
  through the shared workspace with no separate agent identity.
- **Everything merges via PR** — additions, improvements, and maintenance all enter through PRs.
- **No credential ever enters the repo** — everything runs by reusing the operator's own local
  permissions (gh CLI login, browser sessions, IP allowlist, personal SSH config).

## Status

MVP. In place today: the three mount points and the manifest (#41), agent entry + rule templates
(#42), the suite mounting convention (#43), asset types & metadata (#48), Context Manifest governance
(#49), the `ws` execution interface + destructive-action harness + handoff checklist (#50), and the
golden sample pack (#44) — `scripts/ws golden campaign-validator` replays one requirement from
structured requirement to acceptance, which is what makes the handoff checklist's independent-re-run
bar something you *run* rather than something you claim.

Growing in as their tickets ship: vertical suites mount at top-level `suites/` — the first,
`sre-autofix` ([#141](https://github.com/olaola-projects/ai-native-issues/issues/141), the
coding-agent half of Agentic SRE in local form), is in; #7/#8/#9/#10 follow; the
Spec system (#31 — S1–S4 shipped as `skills/spec-authoring`: template skeleton, gap analysis, Q&A
completion loop with readiness gates, and the downstream handoff contract; pioneer-project testing
and template consolidation follow #117); evaluation & regression (#36); troubleshooting runbooks
(#17/#18); packaged tools (#32/#16).

Implements [#41](https://github.com/olaola-projects/ai-native-issues/issues/41) as revised by
[#93](https://github.com/olaola-projects/ai-native-issues/issues/93); parent is
[#28](https://github.com/olaola-projects/ai-native-issues/issues/28).
