# platform-internals/golden/ — end-to-end sample packs (#44)

**Purpose**: carry one real requirement from structured requirement through to acceptance, with a
tracked artifact at every stage and failure deliberately planted, so a new team can **replay** the
loop instead of reading a description of it. This is the material behind the handoff checklist's
independent-re-run bar (`agent-instructions/handoff-checklist.md`) and the joint half of #50's acceptance.
The spec is `platform-internals/golden-sample-pack.md`.

**Admission criteria**:

What a pack must *contain* — five stage directories with real artifacts, at least one planted failure
with a root-cause report, the ordered-convergence invariants, an idempotent `replay` — is the spec's
`## Admission criteria`, and it is stated **only** there. This directory adds what is true of the
*directory*:

- One directory per pack, `platform-internals/golden/<pack-id>/`, declaring itself in `PACK.md` (id, stages, planted
  failures, boundaries, training path).
- Two executables at the pack root: `replay` (re-runs the loop) and `verify` (static closure check,
  called by `ws test`).
- `python3 scripts/check-golden-pack` passes — it enforces the spec's contract over every pack here.
- **Nothing here trips `check-secret-scan`**, which scans every tracked file in the repo. Two traps
  worth naming: a file name matching `key.*\.json$` matches anywhere in the basename (`monkey.json`
  counts), so keep `key` / `credentials` / `secrets` / `token` out of file names; and the content
  pattern `(password|secret|token|api[_-]?key)\s*[:=]\s*<8+ chars>` means sample config fields and
  prose examples must not take that shape.

**What does NOT go here**:

- **Reusable assets.** A pack is the record of one piece of work, not something you compose into
  future work. Nothing here carries #48 metadata. If a fragment turns out to be genuinely reusable,
  *promote* it — make it a `spec-module` (or whichever of the nine types fits) and move it to the home
  `agent-instructions/asset-metadata.md` names. Do not leave it here wearing asset frontmatter.
- **A vertical suite.** A suite (`platform-internals/suites/`) tracks a contract and points at a mounted payload; a pack
  tracks its own seed. Different two-layer model, different directory.
- **Inert fixtures.** `platform-internals/tests/` holds problems that exist to be *detected* and are
  never executed. A pack exists to be *run*.
- **A second copy of a requirement.** Revisions live inside the one file, annotated by version — the
  spec's *"A requirement is one file"* has the reasoning. A `REQ-001-v1.md` sibling is the
  "no inconsistency" red line (`agent-instructions/context-manifest.md`) in its purest form.
- **Business code meant to be maintained.** A pack's `seed/` is a specimen sized to teach a loop, with
  a hard ceiling (~150 lines). When it starts wanting features, it has stopped being a sample.

**A note on deliberately-broken content**: a pack's `seed/` contains an implementation that fails its
own tests — that is the planted failure, not rot. It stays inert here for the same reason
`platform-internals/tests/` sits outside `platform-internals/examples/`: no scanner executes it, and the main green line
stays green. It only ever runs after `replay` clones it into the pack's own `.mount/`, which is
gitignored — `repos/` stays reserved for real business mounts.

**Contents of this directory**:

| Pack | Type | Planted failures | Replay |
|---|---|---|---|
| `campaign-validator/` | campaign config validation (python3 stdlib, zero dependency) | a test failure; a requirement change | `scripts/ws golden campaign-validator` |
