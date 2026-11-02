# repos/ — business-code mount point

`git clone` your team's real business repos here (clone, never copy — the framework reads each repo's
`.git`), then register each one in `workspace.local.yaml` under `repositories` (gitignored — which
repos you've mounted is local, per-developer state; see `agent-instructions/mount-points.md` for why
`workspace.yaml`'s own `repositories:` key is never edited).

New to the team? Run `scripts/setup-repos --list` to see the role → repo mapping, then
`scripts/setup-repos <role>` (e.g. `backend`, `frontend`, `client`) to clone and register the right
subset for you in one step. Add `--team <team>` to clone only one team's repos. Later,
`scripts/update-repos` pulls each mounted repo that is clean and on its default branch.

Full conventions, admission criteria, and why it must be a clone: `agent-instructions/mount-points.md`.
