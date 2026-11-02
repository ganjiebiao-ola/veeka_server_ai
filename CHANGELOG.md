# CHANGELOG — template changes that teams adopt by hand

Framework-owned paths reach a team workspace automatically on sync (`skills/workspace-upstream-sync`).
**Seed** files (`platform-internals/ownership.yaml` `seed:`) do not: the team's copy is kept. Every
template change to a seed is listed here, newest first, so a team can decide whether to adopt it. After a
sync the exact diff is `git diff <old-pin>..<new-pin> -- <file>`.

## 2026-11-02 — workspace freshness: `ws freshness` and `workspace-update` (#527)

- `README.md` and `README.en.md`: a new section, "保持 workspace 最新" / "Keeping the workspace up to date",
  after the upstream-sync section. It tells teammates about the session-start check and the
  `workspace-update` skill, and that Codex asks each person to trust the new hook once in `/hooks`.
- Framework paths reach a team workspace on sync: `scripts/check-freshness` (`ws freshness`), its SessionStart
  hooks in `.claude/settings.json` and `.codex/hooks.json`, the `workspace-update` skill and its test
  `platform-internals/tests/test_freshness.py`. A team that already runs its own copy of this check (for
  example `scripts/check-freshness.py` plus a `skills/workspace-update/` of its own) should delete that copy
  when it syncs, so only one hook fires.

## 2026-11-02 — `pa-skills-loader` renamed `skills-source-loader`, generalized

- Framework paths reach a team workspace on sync: the bundled skill moves from `skills/pa-skills-loader/` to
  `skills/skills-source-loader/` and works with whatever repo `workspace.yaml` `skill_catalog.source` names.
  It no longer reads a `consolidated_skills.md` kept inside the source repo: the new read-only
  `scripts/setup-skills --index` scans `repos/<source>/<category>/<id>/SKILL.md` live. Invoke it as
  `/skills-source-loader` from now on; `/pa-skills-loader` is gone.
- Nothing to adopt by hand. A team whose skills source has its own conventions (the language its
  descriptions are written in, what its categories mean) can write them into
  `team-context/mounted-repos/<source>.md`, which the loader now reads first.
- The comment that `scripts/setup-skills` writes above the `skills:` block of `workspace.local.yaml` changes
  wording on the next run. The entries are unchanged.
- `scripts/setup-skills --id <id> --category <category>` now fails (exit 2) when `skill_catalog` records a
  different category for that id. It used to print a NOTE and mount the catalogued skill, which is not
  the one that was asked for. Drop `--category` to mount the catalogued one.

## 2026-10-27 — repo tooling: `setup-repos --team`, `update-repos` (contrib/repo-tooling)

- `workspace.yaml`: a `repo_catalog` entry can add `team: [<team>]`. `scripts/setup-repos --team <team>`
  then clones only that team's repos. An entry without `team:` matches no `--team` filter.
- Framework paths reach a team workspace on sync: the `--team` option in `scripts/setup-repos`, and the new
  `scripts/update-repos`, which fast-forwards each mounted repo that is clean and on its default branch.

## 2026-10-19 — ai-usage-weekly monthly report (#359)

- `README.md` and `README.en.md`: the `ai-usage-weekly` command list gains `month --allocation <file.xlsx>`.
  The command turns the monthly LiteLLM key allocation file into a monthly report under `reports/months/<YYYY-MM>/`:
  real cost by team, a roll-up of the month's weekly reports, and the git history of the mounted repos.
  The month comes from the file name. Details: `skills/ai-usage-weekly/SKILL.md` § Phase 2c.

## 2026-10-13 — code map (contrib/code-map)

- `README.md` and `README.en.md`: add quick-start step 5, an optional `ws map install` and `ws map generate --all`.
- New seed `knowledge/maps/overview.md`: a stub project map. `ws health` needs at least one map, so a new workspace passes.
  A team that already has an `overview.md` keeps its own copy on sync.
- Framework paths reach a team workspace on sync: `ws map`, the code-map scripts and hooks, the `code-map-query` and
  `code-map-scope` skills, `agent-instructions/code-map.md`, and the manifest's `structural-code` and `repo-orientation` read orders.

## 2026-10-12 — security-patch includes its app

- `workspace.yaml`: set the security-patch source to `olaola-chat/ai-native-workspace-template` and its version to the template source version.
- `README.md` and `README.en.md`: describe the bundled app instead of a separately installed tool.
- Sync the suite and operator skill together. Use `suites/security-patch/run start` from the workspace root.
- Import provenance lives in `suites/security-patch/SUITE.md`. Future app changes belong to the template's git history.

## 2026-09-04 — README: how downstream syncs (contrib/readme-sync-merge)

- `README.md` / `README.en.md`: new section "跟上游模板同步 / Syncing with the upstream template" — merge, never
  rebase; merge-commit PRs; the `workspace-upstream-sync` skill; contributing back via `contrib/*`. Quick-start
  step 3 now describes `repo_catalog` and the frozen `repositories: []`; the directory table gains `CHANGELOG.md`
  and points at `platform-internals/ownership.yaml`.

## 2026-09-03 — ownership model (contrib/ownership-split)

- New seeds: `team-context/security-defaults.team.md` (the three former `TODO(owner)` slots of
  `agent-instructions/security-defaults.md`), `team-context/agent-entry.team.md` (slots rendered into
  `CLAUDE.md` / `AGENTS.md`), `team-context/manifest.d/50-team.yaml` (this team's manifest rows). A workspace
  adopting the model creates them once — the sync skill's "first adoption" section says how.
- `workspace.yaml`: `repositories:` is a frozen `[]` (the real mount list is the gitignored
  `workspace.local.yaml`), `repo_catalog` is required by `scripts/setup-repos`, and an optional `upstream:`
  block (`url`, `branch`, `synced_commit`) is the pin `scripts/check-ownership` compares framework paths
  against; `scripts/upstream-pin` bumps it.
- `knowledge/README.md` is a seed: the template ships a stub, the team's own knowledge index replaces it.
- `README.md` / `README.en.md`: the fixed skill count is gone — the list is `skills/README.md`.
- `rules/team-rules.md`: precedence lists `agent-instructions/security-defaults.md` as the floor between
  org rules and team rules (adopted from pa-ai-native-workspace).
