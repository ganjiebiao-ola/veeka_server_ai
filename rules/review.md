# PR, branches, review & responsibility

How work merges into this workspace, who is accountable, and how generated artifacts are versioned.

## Everything merges via PR

- All changes — human-written, agent-generated, or pipeline-produced — enter the workspace **through
  a PR**. FDE deliverables land as PRs; so do member fixes, improvements, and maintenance.
- **Why:** the repository's commit history becomes the single audit trail of how each capability evolved.

## Branches

- Personal / topic branches: `<human-id>/<topic>` (e.g. `alice/onboarding-map`). `TODO(owner)`: adjust
  to your naming if different.
- Members may keep a personal branch to carry their own customizations.

## Review

- `TODO(owner)`: how many approvals, and any per-area required reviewers (e.g. a `payments/` owner).
- **Why:** name the reviewer rule so "who reviews" is never "whoever is free".

## Responsibility (human-id)

- Every PR and every module has an explicit **human owner**. `TODO(owner)`: how ownership is recorded.
- **Agent output is attributed to the human-id who initiated it.** This workspace introduces **no
  separate agent identity** — accountability lands on the person and the team.
  > This human-id is a code/PR responsibility convention. It is **not** the asset-metadata schema
  > (owner/version/…) defined in #48 (`agent-instructions/asset-metadata.md`); don't conflate the two.

## Artifact provenance (versioning)

- Any artifact produced by an agent, tool, or pipeline records the **full workspace commit SHA** in
  effect when it was generated. Display and filenames may truncate to the **first 6 characters**.
- Naming example: `release-notes__ws-a1b2c3.md` (full SHA recorded inside; short form in the name).
- **Why:** the commit is the version of the capability that produced the artifact — provenance for
  free, so any output can be traced back to the exact workspace state.

## Best-to-have (recommended, NOT a gate)

The following are **recommendations, never admission gates** for this workspace: trace / correlation-id
across tools, a single SDD framework, an org-level asset platform. Adopt if useful; never block a merge
or a phase on them.

## Example & anti-example

- **Good:** "Artifacts stamp `ws-<sha6>`; PRs to `infra/` need one infra-owner approval — because infra
  changes fan out across teams. Owner: @bob."
- **Anti:** "Review carefully and version things properly." No rule, no owner, not checkable.
