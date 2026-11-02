---
name: workspace-upstream-sync
description: Syncs a team AI-Workspace with its upstream template (merge-based, never rebase) under the path-ownership model — framework paths follow upstream, seed and generated files keep the team's copy and are re-rendered — then pins the upstream commit, runs the full green line and ships a merge-commit PR via scripts/sync-upstream-ship. Use when the user says "sync upstream", "sync with the template", "pull in upstream changes", "跟上游同步", "同步上游模板", asks to contribute a generic change back ("反哺模板", "upstream this"), or when check-ownership reports framework drift. Also covers a workspace adopting the ownership model for the first time. Not for pulling teammates' merged PRs from this workspace's own origin — that is workspace-update.
id: skill:workspace-upstream-sync
type: skill
owner: muchen
version: "ed0ddf2b9f4bffd233cf927df421c7bcc45aadcf"
status: active
summary: Merge-based upstream→downstream sync under platform-internals/ownership.yaml — merge, pin, render, verify, ship (harness_guard-gated); contributions back go on contrib/* branches cut from upstream/main.
use_when: The operator wants this workspace brought up to date with its upstream template, wants a generic change contributed back to it, or check-ownership fails.
usage: Mounted under skills/ (bundled, framework-owned). Ships via scripts/sync-upstream-ship, which this skill's body must call for the final push + PR rather than running git push / gh pr create itself.
dependencies: []
regression: ["regression-case:workspace-upstream-sync-smoke"]
---

# workspace-upstream-sync

Under the ownership model (`platform-internals/ownership.yaml`, explained in
`agent-instructions/mount-points.md` § "Ownership: template vs team") a sync cannot conflict: framework
paths are byte-identical on both sides, seed and generated files carry `merge=ours`. What is left is a
short, mechanical routine. If a conflict *does* appear, it is on a framework path someone edited locally —
the fix is to take upstream's version and move that edit upstream (§ Contributing back), never to
resolve it by hand on the sync branch.

**Never rebase** onto `upstream/<branch>` (git swaps ours/theirs under rebase, so `merge=ours` would keep
the *upstream* side of every seed — `scripts/lib/merge-keep-team` makes even that mistake harmless, but a
rebase still needs a force-push, which the ship script refuses), never force-push, never let the sync PR
be **squash**-merged: a squash resets the merge base, and the next sync replays every change again.

## 1. Preflight

- Read `workspace.yaml` `upstream:` (`url`, `branch`, `synced_commit`). If the block is missing, this
  workspace has not adopted the model yet → § First adoption.
- `git remote get-url upstream` must equal `upstream.url`; if the remote is missing, `git remote add
  upstream <url>`. Then `git fetch upstream <branch>` and `git fetch origin`.
  **Known gotcha**: fetch and any `gh` call may need this session's sandbox disabled here (SSH-over-proxy /
  TLS interception fail with "Operation not permitted" / certificate errors that look like real bugs).
- Once per clone: `git config merge.ours.driver 'scripts/lib/merge-keep-team %O %A %B'` and
  `git config rerere.enabled true`. Without the driver every seed conflicts instead of keeping the team's
  copy (`regression/sync-fixture.sh` case 5); with a plain `true` driver an accidental `git rebase` would
  silently drop the team's seed edits, which `merge-keep-team` prevents (case 6).
- `scripts/ws health` must be green *before* the sync (especially `ownership` and `generated files`) —
  a red start makes the post-sync verdict meaningless.
- Branch: `git checkout -b sync/upstream-$(date +%Y%m%d) main`. One short-lived branch per sync; the old
  long-lived `sync-upstream-main` is retired (leave it; do not delete or reuse it).

## 2. Merge

`git merge --no-ff upstream/<branch>`. Expected: no conflict. If `git diff --name-only --diff-filter=U`
lists anything: every listed path is framework-owned (anything else means `.gitattributes` was missing
or the driver unset — abort, fix the preflight, redo). Resolve each with
`git checkout --theirs -- <path> && git add <path>`, note the path for § Contributing back, and finish
the merge. **Known gotcha**: writes under `skills/*` can be blocked by this session's sandbox
(`denyWithinAllow`) even for a plain merge — `git merge --abort` and redo unsandboxed rather than
patching a half-applied state.

## 3. Pin, render, verify

```
scripts/upstream-pin "$(git rev-parse upstream/<branch>)"
scripts/render-agent-entries && scripts/render-context-manifest
scripts/ws validate && scripts/ws health && scripts/ws test
```
`ws health` must show `[OK  ] ownership: … framework vs pin: matches upstream <sha>` and
`[OK  ] generated files`. Commit the pin + renders on the sync branch ("同步上游 <old-sha6>..<new-sha6>：pin + 重新渲染").

## 4. Seed changes to consider (report, do not apply)

Seeds kept the team's copy. Tell the operator what the template changed in them so they can adopt by hand:

```
git diff <old-pin>..<new-pin> --stat -- README.md README.en.md workspace.yaml rules/ \
  team-context/security-defaults.team.md team-context/agent-entry.team.md team-context/manifest.d/50-team.yaml
```
plus the matching `CHANGELOG.md` entries (`git diff <old-pin>..<new-pin> -- CHANGELOG.md`). Put the list in
the PR body; adopting is a separate, team-owned change.

## 5. Ship

**Never call `git push`, `git push --force*`, or `gh pr create` from this skill.** Write the PR title and
body to two temp files (Chinese, concise: upstream range, whether conflicts on framework paths were taken
from upstream and which, the seed-change list from § 4), then:

```
scripts/sync-upstream-ship <branch> main <title-file> <body-file>
```
It gates push and PR creation behind `harness_guard` (`/dev/tty`), refuses force-push, and derives
`--repo` from `origin` (with two remotes, `gh` can silently pick the wrong one). Ask the reviewer to merge
with a **merge commit** (if the repo still allows squash/rebase merges, say so in the body).

## Contributing back (generic change → upstream first)

A change to a framework-owned path is a template change. Do not make it here:

1. `git fetch upstream <branch>` then `git checkout -b contrib/<topic> upstream/<branch>` (a branch of the
   *template*, never of the team's `main` — a sync branch mixes in team content and cannot be upstreamed).
2. Apply the change there (cherry-pick a local commit if it touches only framework paths:
   `git cherry-pick <sha>`; otherwise re-apply by hand). Run the template's `scripts/ws validate && ws test`.
3. Push to the template repo and open the PR there (`gh pr create --repo <upstream owner/repo>`); after it
   merges, run this skill to bring it down. The team's local edit, if any, disappears in § 2 by design.

## First adoption (a workspace without the ownership model yet)

1. Commit upstream's `.gitattributes` first (`git checkout upstream/<branch> -- .gitattributes && git commit`):
   attributes take effect from the working tree, so they must be present *before* the first merge.
2. Set the driver (§ 1), merge (§ 2 — expect framework conflicts on files the workspace changed; take
   upstream's), then create the team files from their seeds: `team-context/security-defaults.team.md` (move
   the tiers from the old `security-defaults.md`), `team-context/agent-entry.team.md`,
   `team-context/manifest.d/50-team.yaml` (move the team's concrete rows out of the old `manifest.yaml`).
3. Add `upstream:` to `workspace.yaml` (uncomment the seed's block, fill `url`/`branch`), pin, render,
   verify, ship (§ 3–5).

## Never

- Never rebase a sync branch onto `upstream/<branch>`; never squash-merge the sync PR.
- Never force-push a sync branch — if a force-push looks necessary, stop and ask the operator; something
  upstream of the normal flow has gone wrong.
- Never resolve a framework conflict by hand-editing — take upstream's version and upstream the edit.
- Never edit `CLAUDE.md`, `AGENTS.md` or `team-context/manifest.yaml` directly — edit their sources and re-render.
- Never call `git push` or `gh pr create` from anywhere but `scripts/sync-upstream-ship`.
