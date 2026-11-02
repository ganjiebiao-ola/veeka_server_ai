# Runbook — report.json → fix PR on your machine

> New here? `quickstart.md` is the copy-paste path (中文, verified on a real operator machine
> 2026-08-26); this file is the reference behind it.

## Prerequisites (once per machine)

| Need | Check | Why |
|---|---|---|
| `git` with an identity | `git config user.name && git config user.email` | the suite commits with **your** identity, never a bot |
| `gh` logged in | `gh auth status` | `ship` opens the PR with your account (`workspace.yaml required_local_permissions`) |
| `python3 ≥ 3.8` | `python3 --version` | `lib/` is stdlib-only |
| an agent CLI (headless) | `command -v claude \|\| command -v codex` | `run fix --headless`; interactive use needs only your editor/agent session |
| the target repo mounted | `ls repos/<id>/.git` | `git clone` it under `repos/` and register it in `workspace.yaml repositories[]` |
| `suites/sre-autofix/config.local.yaml` filled | `cp config.yaml config.local.yaml`, then no `TODO(owner)` left in the target repo's entry (`run doctor` first row says which file is in effect) | `scope` (allowed path prefixes), `base`, `remote`, `github`, `checks`. The tracked `config.yaml` is a template the framework keeps editing — filling it in place makes every `git pull` conflict |
| the repo's check commands (recommended) | `config.yaml repos[<id>].checks` non-empty and their binaries on PATH (`run doctor` GATE rows) | gate check 5 runs them in the worktree (`go build ./... && go vet ./...`, `php -l {files}` + a static analyser — `docs/examples/phpstan-new-errors.sh` for legacy PHP —, the repo's own lint…); empty ⇒ only the agent's self-declared verification stands |

**One command checks all of it: `suites/sre-autofix/run doctor`** (MUST rows block claim/plan/gate;
SHIP/HEADLESS rows only affect `ship` / `--headless`). `scripts/ws health` covers the permission
rows; `suites/sre-autofix/test` proves the suite itself.

## Which agent? Any.

The contract travels **inside the worktree** (`INCIDENT.md` embeds the `incident-fix` block), not in
any runtime's config, so every coding agent that can read and edit files works:

| How you work | What to do |
|---|---|
| Interactive in Claude Code / Codex / OpenCode / … at the workspace root (**default**) | say "修复这份 SRE 报告 <path>" (the `sre-autofix` skill drives `claim`/`plan`), then let the same session fix under `INCIDENT.md`, then `gate`; you type `ship` in a terminal |
| Interactive, but you prefer opening the agent inside the worktree | `cd runs/sre-autofix/<id>/worktree && <your agent>` and tell it to follow `INCIDENT.md` |
| Unattended | `run fix <id> --headless` — picks `claude` / `codex` / `opencode` from PATH (`headless.agent`), or any CLI via `headless.command` (`{prompt}` `{worktree}` `{response}` placeholders; cwd is the worktree) |

Skill auto-discovery is a convenience on top: `.claude/skills` and `.agents/skills` already point at
`skills/` for Claude Code and Codex; a runtime that supports the agentskills.io layout can get the
same with one more symlink to `../skills`. Without it nothing is lost — the brief carries the contract.

## Where things live

```
runs/sre-autofix/<incident-id>/          gitignored (/runs/)
  input.json incident.json issue.draft.md eligibility.json status.json   ← claim
  workspace.json git-exclude INCIDENT.md                                  ← plan
  worktree/          the git worktree (branch autofix/<id>, .git → repos/<id>/.git/worktrees/…)
  attempts.jsonl last-run.json agent-prompt.txt agent-events.jsonl agent-response.md   ← fix
  verification-gate.json fix.patch FIXNOTES.md verification.json        ← gate
  pr-title.txt pr-body.md pr.json                                        ← ship
  run-log.jsonl
runs/harness-log.jsonl                    every harness_guard decision (platform-internals/runs-format.md)
```

Scaffold files (`INCIDENT.md`, `FIXNOTES.md`, `.sre-evidence/`) live in the worktree but never enter
a commit: every git call passes `-c core.excludesFile=runs/sre-autofix/<id>/git-exclude` (so
`repos/<id>/.git/info/exclude` is never touched), commits use `--only <gate files>`, and the gate's
check 2 plus the post-commit recheck refuse them.

## Walkthrough

```sh
# 1. claim — offline; five reasons; exit 3 = parked (legal stop)
suites/sre-autofix/run claim path/to/report-INC-….json          # or the archive directory
suites/sre-autofix/run claim path/to/archive --dry-run          # just look

# 2. plan — fetches <remote>/<base>, creates the worktree, renders INCIDENT.md
suites/sre-autofix/run plan INC-…                               # --dry-run prints the brief only
suites/sre-autofix/run plan INC-… --review review.txt           # 返修: reviewer verdict → 人工评审意见

# 3. fix — interactive (default): your current agent session edits runs/sre-autofix/INC-…/worktree
#    per its INCIDENT.md (incident-fix contract; no commit/push). Or unattended:
suites/sre-autofix/run fix INC-… --headless                     # claude / codex / opencode from PATH; gate runs after

# 4. gate — four hygiene checks + repos[].checks commands; exit 4 = fail class + reason
suites/sre-autofix/run gate INC-…
suites/sre-autofix/run fix INC-… --retry                        # reset + carry the failure into INCIDENT.md

# 5. ship — commit → recheck → body → harness_guard push → harness_guard gh pr create
suites/sre-autofix/run ship INC-… --dry-run                     # shows title, body path, exact commands
suites/sre-autofix/run ship INC-… --issue 123                   # answers on /dev/tty; PR body gets "Refs #123"

# 6. release (ship does it unless --keep-worktree)
suites/sre-autofix/run release INC-…
```

Fixture walk (no repo needed) — from the workspace root:
`suites/sre-autofix/run claim suites/sre-autofix/tests/fixtures/report-v11.json --dry-run` prints the
five-reason table; with the all-`TODO` config it parks at 修复目标可定位, which is the expected
answer until you configure a repo.

## Which check commands does my repo need?

Leave `repos[<id>].checks` empty and run `suites/sre-autofix/run doctor`: the GATE row prints, for
that repo, (a) the `run:` steps its own CI executes on pull_request — reuse those first, any language —
and (b) the canonical compile / static-check command for its toolchain marker (`go.mod` → `go build`
+ `go vet`, `pom.xml` → `mvn compile`, `tsconfig.json` → `tsc --noEmit`, `composer.json` → `php -l` …),
flagged **SYNTAX ONLY** when it would not catch a wrong signature. The rule behind the flag, if you
want to judge a command yourself: *if the patch passed one argument with the wrong type or by value
instead of by reference, would this command exit non-zero?* Compiled languages: the compiler says
yes. Interpreted ones (PHP, Python, Ruby): `-l` / `compileall` say no — you need a static analyser
(PHPStan, mypy, Sorbet), or fix the repo's CI to run one and reuse it. New language in the team → one
row in `lib/suggest.py TABLE`; the gate itself never changes.

## When things go sideways

- **`run doctor` shows [MISS]** — a MUST row: python3, git, harness.sh, the contract block, or no usable
  repo in `config.yaml` (still `TODO(owner)`, not registered, or not mounted). Fix that first.
- **parked at 修复目标可定位** — the named source file is not in any configured+mounted repo, or it
  exists in more than one. Use `claim --repo <id> --file <path>` to override, or configure the repo.
- **plan: 分支已存在** — a stale `autofix/<id>` from an earlier run; `run release <id>` or delete it by
  hand after checking it is not pushed.
- **gate: verification_failed** — read `runs/…/verification.json`; things the agent could not do belong
  in `not_verified[]`, not as failed checks (`skills/incident-fix/references/verification-schema.md`).
- **gate: repo_check_failed** — a `config.yaml repos[<id>].checks` command exited non-zero; full output
  in `runs/…/repo-checks.log`. Fix the patch (`run fix <id> --retry` carries the first failing line into
  INCIDENT.md), or fix the command if it is the command that is wrong. Exit 124 = `checks_wall_sec`.
- **doctor: [WARN] GATE repos[<id>].checks** — no check commands configured (only the agent's own
  verification stands; a runtime/compile error passes through) or a listed binary is not on PATH.
- **ship: BLOCKED (no controlling terminal)** — run from a real terminal; the harness only accepts
  approval typed on `/dev/tty`. The commit is kept; re-running `ship` resumes at the push.
- **ship: 远端分支已存在** — the suite never force-pushes; delete the remote branch or use a new id.
- **PR rejected** — save the review text, `run plan <id> --review review.txt`, then `fix` again; the
  brief carries the verdict as a must-follow section.
- Reconcile / recurrence after the PR is opened is **out of scope** (upstream's job).
