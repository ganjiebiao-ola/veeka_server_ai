# platform-internals/suites/ — vertical Agent suite mounting convention (framework-tracked)

> **Where a real suite lives.** This directory holds the *convention* and the `campaign-stub` that
> proves it — framework self-proving material. A real vertical suite mounts at **top-level
> `suites/<id>/`**, created by the first real suite to land (`suites/sre-autofix/`, #141); #7–#10
> follow. `ws test` / `ws regression` run both locations, so a mounted suite is
> never silently untested. Paths written `suites/<id>/` below mean that top-level home.

A **vertical Agent suite** is a bundle of assets (from D3's nine asset types — instruction /
prompt / skill / agent-profile / workflow / spec-module / evaluator / regression-case / tool;
see `agent-instructions/asset-metadata.md`) packaged for **one project type**: mini-game (#7), campaign (#8), security-patch (#9), legacy (#10). This
directory defines **how a suite mounts into the workspace** — its location, manifest registration,
command entry points, and how the four types differ. It does **not** implement suite contents
(those ship with #7–#10), and it is **not** a cross-team suite marketplace (that is #38, long-term).

## Two layers: contract (tracked) vs payload (mounted)

| Layer | Where | Tracked? | What |
|---|---|---|---|
| **Contract** | `suites/<id>/SUITE.md` (+ `run`/`test`) | ✅ framework-tracked, PR-reviewed | Type, entry, command entry points, **which assets it composes (by id/path pointer, not copied)**, pipeline/governance steps, human-confirm points, destructive-action declaration, the `agent_suites` registration block. |
| **Payload** | `skills/` `knowledge/` `repos/` (mount points) | ⛔ mounted (gitignored, own version) | The real skill packages, knowledge, business code. The contract **points** at them; it never pastes their bodies. |

Why: a `SUITE.md` steers agent behavior, so it must be a **trusted source** — and per
`agent-instructions/security-defaults.md` §1, trusted sources must be framework-tracked, never a mount
point. Heavy or independently-versioned payload stays in the mount points. This mirrors
`team-context/mounted-repos/<id>.md ↔ repos/<id>`.

**SUITE.md trust = SKILL.md trust**: a suite is a composition of skills, so its `SUITE.md` falls
under the same activation-≠-privilege rule as a skill — authoritative statement in
`agent-instructions/security-defaults.md` §1.

## Directory & naming

- One directory per suite: `suites/<suite-id>/`. `<suite-id>` is stable and matches the `id`
  registered in `workspace.yaml` `agent_suites[]`.
- Required: `suites/<id>/SUITE.md` (the contract), plus `run` and `test` entry points alongside it.

## Manifest registration (`agent_suites` in `workspace.yaml`)

Register each mounted suite under the top-level `agent_suites` list:

```yaml
agent_suites:
  - id: campaign-pipeline                       # stable suite id (= suites/<id>/)
    source: olaola-projects/ai-native-issues#8  # where the suite comes from (ticket / repo)
    version: <full commit SHA / digest>         # machine records the full SHA; humans show the first 6
    entry: suites/campaign-pipeline/            # the suite's contract directory
```

- The **field slot** and any machine schema validation belong to #41 (manifest spec) / #50
  (execution interface); **this file defines how to fill it** (#43).
- `version` is the **suite's own source version**. Do not confuse it with (a) `rules/review.md`'s
  artifact provenance `ws-<sha6>` (the workspace state when an artifact is produced) or (b) the
  per-asset lifecycle metadata in #48. All three show the first 6 chars but describe different things.

## Command entry points (per-suite)

Every suite exposes the same two entry-point **names** so a non-FDE member re-runs any suite the
same way:

- `suites/<id>/run` — run the suite's main flow.
- `suites/<id>/test` — run its tests.

Only the **names** are fixed here; the interpreter/implementation is the suite's own choice (sh,
python3, …). The aggregated top-level entry and the `validate` / `regression` / `health` interface
are `scripts/ws` (#50) — `ws test` and `ws regression` invoke each suite's `test`.

## The project types mount differently ("pick a strategy per project type, don't reuse one template")

| Type (ticket) | Level | Kind | Contract composes |
|---|---|---|---|
| mini-game (#7) | Lv4 | **spec-driven pipeline** | four-part Spec (feature / UI / technical / framework constraints) → generate → test → verify |
| campaign (#8) | Lv4 | **spec-driven pipeline** | same pipeline shape; Spec templates reused across campaigns |
| security-patch (#9) | Lv5 | **governance suite** | input format + risk template + fix recipes + checks + recurrence check + PR checklist. `suites/security-patch/` includes the app and instructions. |
| legacy (#10) | Lv5 | **governance suite** | code-tiering + risk tagging + safe-change scope + rollback + logging hardening |
| incident-fix (#141) | Lv5 | **governance suite** | SRE report input contract + eligibility (cause_locus = code_defect) + INCIDENT.md fix brief + hygiene gate / fail classes + PR checklist (never auto-merge, `Refs` not `Closes`) — shipped as `suites/sre-autofix/` |
| sre-inspect (#146) | Lv5 | **governance suite** | Grafana-native alert intake (filter → routes → recurrence ledger) + INSPECT.md dive brief (injected time facts, layers, L7 deploy table) + report.json v1.1 contract + scrub — read-only on one Grafana data plane; shipped as `suites/sre-inspect/` |

**Common** (all types): live in `suites/<id>/`, register in `agent_suites`, expose `run`/`test`,
`version` = source commit (show first 6), all **Soft Rec** (only parent #28 is a Hard Gate),
SUITE.md trust = SKILL.md, payload via mount-point pointers.

**Differ**: contract structure (pipeline vs governance), Level (Lv4 vs Lv5), and red lines — #9
never auto-merges a security fix / never bypasses the security owner; #10 never promises one-shot
modernization / no auto feature-growth in high-risk legacy code.

## Red lines

- **Bind to a project type.** A suite's `SUITE.md` and entry declare their `type`; no "universal
  agent" (vertical agents #6/#7/#8 are pipeline-ized and type-bound).
- **Destructive actions go through the #50 harness block** (interception / confirmation / dry-run).
- **No credential in the repo**; reuse the operator's local permissions (see
  `rules/access-and-credentials.md`).

## Admission criteria

- The contract is framework-tracked and PR-reviewed; it composes payload by pointer, not by copy.
- `<id>` is stable and matches the `agent_suites[]` registration; `entry` matches the real directory.
- At least `run` and `test` exist and are runnable.

## Not in scope (goes elsewhere)

- Suite **contents** → #7 / #8 / #9 / #10.
- Cross-team / org suite marketplace → #38 (long-term research).
- Manifest schema skeleton & validation → #41 / #50. Asset metadata schema → `agent-instructions/asset-metadata.md` (#48). Context
  read-order (Context Manifest) → `agent-instructions/context-manifest.md` (#49).
