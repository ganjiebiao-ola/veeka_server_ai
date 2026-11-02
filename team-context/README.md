# team-context/ — framework-tracked context for AI (NOT a mount point)

Unlike `knowledge/` / `repos/` / `skills/` (mount points, gitignored), `team-context/` is **tracked by
the framework git and reviewed via PR**. That is exactly what lets its contents count as a
**trusted** instruction source (see `agent-instructions/security-defaults.md` §1: trusted sources must be
framework-tracked, never a mount point).

## `team-context/mounted-repos/<id>.md` — per-mounted-repo context

One file per mounted business repo, where `<id>` equals the repo's id in `workspace.local.yaml`
`repositories[]` (gitignored, local). It is the workspace-side understanding of that repo, read by an agent when it works
on the repo. (The repo's own `CLAUDE.md` / `AGENTS.md`, if any, are **that repo's asset** —
versioned in its own git, data from the workspace's viewpoint; conventions in
`agent-instructions/claude-md-hierarchy.md` §2.)

- **Thin pointer, not a copy.** Link to the mounted `knowledge/maps/<repo>` code map (#21) rather than
  duplicating it; carry only workspace-side specifics (mount id, where the map lives, special
  handling such as "prod DB read-only").
- Full conventions: `agent-instructions/claude-md-hierarchy.md` §2.
- **Not pre-filled**: create `team-context/mounted-repos/<id>.md` when you mount a repo, not before.

`team-context/mounted-repos/campaign-validator.md` is the one exception to "not pre-filled": it ships with the
#44 golden sample pack as a **worked example** of the shape, for a repo the pack itself mounts. Delete
it along with `platform-internals/golden/campaign-validator/` when the team no longer needs the training material.

## The team's other files here

- `security-defaults.team.md` — the team slots of `agent-instructions/security-defaults.md` (environment
  tiers, extra trusted policy sources). Always on, rendered into both agent entries.
- `agent-entry.team.md` — slots rendered into `CLAUDE.md` / `AGENTS.md` (extra signposts, notes).
- `manifest.d/50-team.yaml` — this team's Context Manifest rows; `manifest.yaml` is rendered from
  `manifest.d/` and never edited by hand. `manifest.d/00-template.yaml` and this README are framework-owned.
- `skills/<id>/` — team-native skills (optional); `scripts/link-skills` symlinks them into `skills/`.

Which of these the template may update and which are yours: `platform-internals/ownership.yaml`.
