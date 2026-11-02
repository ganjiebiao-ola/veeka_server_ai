# Security defaults — team slots (always on)

The team-filled half of `agent-instructions/security-defaults.md`. Same status: always on — imported by
`CLAUDE.md`, inlined into `AGENTS.md` by `scripts/render-agent-entries`. It **names** what the defaults
refer to; it never relaxes them. Team-owned (a seed in `platform-internals/ownership.yaml`): edit it
here, never in `agent-instructions/`.

## Environment tiers (§2 of the defaults)

- **Local dev tier (freely writable — not production)**: `TODO(owner)` — the local stack (hosts/ports)
  writes to which are never blocked.
- **Pre-prod/staging tier**: `TODO(owner)` — staging/test hosts per service, if any exist.
- **Production tier**: `TODO(owner)` — the real production hosts per service (may reference
  `workspace.yaml` `known_limitations`).

Until the pre-prod/production slots are filled, the defaults' fail-safe applies: anything not listed
under the local dev tier is treated as production.

## Additional trusted sources of workspace-level policy (§1 of the defaults)

Framework-tracked files outside any mount point that this team promotes to policy, beyond
`agent-instructions/`, `rules/` and `team-context/mounted-repos/<id>.md`:

- `TODO(owner)` — none yet.
