# Asset types & unified metadata (delivered by #48)

The authoritative spec for **what kinds of reusable asset this workspace holds** and **the metadata
every asset carries**. It closes the gap called out across the repo ("types are enumerated, but the
directory has no landing spot") and gives agents and `#50`'s validator a single machine-readable
contract.

**On-demand, not always-on.** This file is read when an agent authors, moves, deprecates, or audits
an asset — it is **not** imported into every task via `@import` (that stays reserved for
`security-defaults.md` and the team rules). Read it before you create or change an asset.

**Why unify metadata at all.** Without it, a prompt/skill/evaluator is just a file: you cannot tell
its owner, whether it is still current, what it depends on, or whether a change broke it. Uniform
metadata turns loose files into assets an agent can **discover, compose, trust, and retire** — which
is the whole point of the workspace as a shared capability base. We keep the field set small on
purpose (see *Reserved for v0.2*): heavy metadata rots faster than it helps.

## The nine asset types → where each lands

The eight D3 asset types plus **Tool** (a packaged, agent-callable utility). Each type has a **home**
in the skeleton; we do **not** create empty top-level directories just to have one per type — most
missing types either land in an existing directory, ride along with the asset they serve, or reserve
a name that grows in when its owning ticket ships. Only **Skill** lives in a mount point; every other
type is **framework-tracked**, because a trusted instruction source must never sit in a mount point
(`security-defaults.md` §1).

| # | Type | Home (production landing spot) | Tracked? | Admission (short) |
|---|---|---|---|---|
| 1 | **Instruction** | `agent-instructions/` | framework-tracked | Applies stably to all/a class of tasks; executable & checkable. |
| 2 | **Prompt** | Prefer promoting to a skill or composing into a suite; a `prompts/` dir grows in only once reusable templates accumulate. | framework-tracked | Reusable, has a trigger scenario; one-off prompts do not enter. |
| 3 | **Skill** | `skills/` (mount point, gitignored) | **mounted** | `SKILL.md` with `name`/`description` + this metadata, kept & checked **in the skill's own repo**; proven once. Template-bundled skills are the tracked exception, scanned in-repo by `ws health` (#119). |
| 4 | **Agent Profile** | Reserved name `profiles/`; v1 lives only as a `platform-internals/examples/` specimen until real profiles exist. | framework-tracked | A reusable role/tools/constraints preset. **Not an agent identity.** |
| 5 | **Workflow** | `suites/<id>/` (an end-to-end multi-step flow is a suite contract; reserved — the contract + stub live in `platform-internals/suites/` until the first real suite ships) | framework-tracked | Flow definition tracked, per the `SUITE.md` contract. |
| 6 | **Spec Module** | The Spec-template system's dir (**#31** — its entry skill shipped as `skills/spec-authoring`; the spec-module home itself is still future) / inline in a suite contract meanwhile. | framework-tracked | Reusable requirement/design fragment. |
| 7 | **Evaluator** | Rides along with the asset it grades (same dir / inside the suite), by pointer. | framework-tracked | Must declare `evaluates: <target-id>`; paired with a generating capability. |
| 8 | **Regression Case** | Rides along with the asset it tests (`<asset>/regression/`, in the suite, or in a mounted skill's own repo). | framework-tracked (a skill's rides with the mounted skill) | Minimal case per important asset; referenced by `regression:`. |
| 9 | **Tool** | The tools dir (**#32/#16**, future). | framework-tracked (a tool is agent-callable trusted code) | Clear wrapper boundary; no credential committed. |

> Directory authority stays with `README.md`'s directory table and each directory's own README
> (`Purpose / Admission criteria / What does NOT go here`). This table maps **types onto that
> skeleton**; it does not redefine any directory's purpose.

The nine types each get one worked specimen under `platform-internals/examples/` (see `platform-internals/examples/README.md`), so the
enumeration has a landing spot **today** even where the production directory grows in later.

## Unified metadata schema

Metadata lives in the asset file's **YAML frontmatter** (the same habit as `skills/<name>/SKILL.md`
and `suites/<id>/SUITE.md`). It is **distributed** — there is no central asset index; the stable
`id` carries identity so moving a file never changes what it is. The machine-readable contract is
`platform-internals/schemas/asset-metadata.schema.json`; this table is its human companion (keep the two in step).

| Field | Required | Meaning / values |
|---|---|---|
| `id` | ✅ | Stable asset ID, **path-independent**, immutable once `active`. Form `type:slug`, e.g. `evaluator:campaign-copy-eval`. |
| `type` | ✅ | One of the nine types (enum). |
| `owner` | ✅ | human-id (the accountability convention; **not** an agent identity). |
| `version` | ✅ | Full commit SHA / digest (40 or 64 lowercase hex; display may truncate to 6). This is the asset's **own lifecycle version** — see the disambiguation below. |
| `status` | ✅ | Lifecycle: `draft` / `active` / `deprecated` / `retired` / `quarantined`. |
| `summary` | ✅ | One line: what this is. |
| `use_when` | ✅ | When to use it (the trigger scenario). |
| `usage` | ✅ | How to use it (one line + a pointer to the body / entry). |
| `dependencies` | ✅ (may be `[]`) | IDs of other assets/tools this one depends on (carries composition). |
| `regression` | ✅ (non-empty for important assets) | Regression-case ID(s) — carries the *asset ↔ regression* pairing. |
| `evaluates` | conditional | Evaluator only: the ID of the asset it grades. |
| `evaluator` | conditional | A generating capability: the evaluator ID that scores it. |
| `reuse_scope` | optional | Promotion/training **annotation only**: `team` / `promotion-candidate` / `training-candidate`. |

> **Three "first-6-chars" versions, three different subjects — never conflate them.** (a) a suite's
> `agent_suites[].version` = that suite's **upstream source** commit (`platform-internals/suites/README.md`); (b) an
> artifact's `ws-<sha6>` = the **framework workspace** commit when the artifact was produced
> (`rules/review.md`); (c) this schema's `version` = a **single asset's own** lifecycle version. All
> three show 6 chars for humans and record the full SHA for machines, but they version different
> objects.

### Reserved for v0.2 — do not add now

To stop metadata bloat, the first version stops at the fields above. These are named but **must not
be added yet**: `io_contract` (input/output contract), `compat_range`, `risk_level`,
`required_capabilities`. Add them only when a concrete need proves the weight is worth it.

## Lifecycle state machine

`draft → active → deprecated → retired` is the main line; `quarantined` is an orthogonal emergency
stop reachable from any state.

| Status | Meaning | Entry trigger | Exits to | Who |
|---|---|---|---|---|
| `draft` | Being authored; not yet trusted for reuse. | Asset created. | `active` | owner |
| `active` | Current, recommended, safe to compose. | Meets its type's admission + has a minimal Regression Case + (if a generating capability) has its paired Evaluator + PR merged + owner named. | `deprecated`, `quarantined` | owner |
| `deprecated` | Superseded / no longer recommended, still usable. | A newer asset replaces it; note points to the replacement. | `retired`, `active` | owner |
| `retired` | Withdrawn from use. | Deprecated long enough / no consumers. | — (archive or delete) | owner |
| `quarantined` | Emergency stop — disabled pending triage. | Regression fails, a security/trust concern, or it produced a bad artifact. | `draft` (rework) or `active` (after clearing) | owner |

> Text state diagram: `draft ─▶ active ─▶ deprecated ─▶ retired`, with `any ─▶ quarantined ─▶
> {draft | active}`. A `quarantined` asset must not be composed by others until it leaves that state.

## Two pairing conventions

Both are expressed through fields, so `#50` can later resolve them by reading metadata — this file
does not implement the cross-reference check (that is `#50`).

- **Evaluator ↔ generating capability.** Quality judgement exists *in pairs* with the capability it
  judges: the evaluator declares `evaluates: <target-id>`, and the generating asset points back with
  `evaluator: <evaluator-id>`. Why: an output nobody grades cannot be trusted to stay good.
- **Asset ↔ Regression Case.** Every important asset carries a minimal regression case via
  `regression: [<case-id>]`. Why: it is how you tell whether editing the asset broke what already
  worked.

The `platform-internals/examples/` specimens demonstrate both at once with a **prompt ↔ evaluator ↔ regression-case**
triple (`prompt:campaign-copy` ↔ `evaluator:campaign-copy-eval` ↔ `regression-case:campaign-copy-basic`).

## Promotion / training annotation (identify-and-tag only)

When an asset (a) has been reused several times / by more than one person, (b) has no strong
team-coupling blocking reuse, and (c) passes its regression and evaluation, its owner may tag
`reuse_scope: promotion-candidate` (or `training-candidate`) with a one-line rationale. This is
**identification and tagging only** — actually promoting an asset to cross-team reuse is **#38**, and
turning it into training material is **#34**. This workspace builds neither platform.

## Admission criteria (for any asset carrying this metadata)

- Frontmatter validates against `platform-internals/schemas/asset-metadata.schema.json` (run `scripts/check-asset-metadata`).
- `id` is stable and unique; `type` matches the directory/home it lands in.
- Important assets carry a non-empty `regression`; generating capabilities carry their paired `evaluator`.
- `owner` is a human-id; no credential appears anywhere in the asset.

## Not in scope (goes elsewhere)

- The `validate` / `regression` / `health` interface, cross-reference (pairing) checking, aggregate
  runners, and the destructive-action harness → **#50**. This spec only defines the schema + specimens.
- Any `workspace.yaml` manifest field / central `reusable_assets[]` index → **#41 (+#50)**; metadata
  stays distributed in frontmatter, so #48 invents no manifest field.
- Cross-team asset marketplace → **#38**; training platform → **#34**; Spec-template system → **#31**;
  packaged-tools directory → **#32/#16**.
- A separate agent identity — an `agent-profile` is a reusable configuration, **never** an identity.

## Example & anti-example

- **Good:** "`evaluator:campaign-copy-eval` declares `evaluates: prompt:campaign-copy` and
  `regression: [regression-case:campaign-copy-basic]`; `status: draft` until the pair and case land.
  Owner: @alice." — every field checkable, pairing explicit, lifecycle honest.
- **Anti:** "This prompt is good and reusable, tag it however." No id, no owner, no lifecycle, no
  regression — not discoverable, not trustable, not checkable.
