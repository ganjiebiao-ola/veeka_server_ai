# Verification gate — four hygiene checks + the repo's own check commands

`run gate` (and every `ship`) harvests the worktree and runs `lib/gate.py evaluate` (port of
`fixgate.go`). Pure data in — `diff`, `git apply --check --reverse` verdict, changed/untracked file
lists, `verification.json` text, and the recorded results of the repo's check commands — so the gate
replays on archived fixtures. All five checks run even after the first failure (the green-light table
in the PR body shows every row).

| # | Check (name is verbatim) | Passes when | Fail class |
|---|---|---|---|
| 1 | `补丁非空且能干净应用` | `git diff` is non-empty **and** the patch reverse-applies cleanly (`git apply --check --reverse -`, patch on stdin) | `patch_empty` / `patch_not_applicable` |
| 2 | `改动限定在业务路径` | no scaffold file (`INCIDENT.md`, `FIXNOTES.md`, `.sre-evidence/`) in the changed list (checked first) and every changed file is under a `scope` prefix; untracked new files are *reported*, not failed | `scaffold_tracked` / `diff_out_of_scope` |
| 3 | `补丁不含密钥` | no secret-kind hit from `lib/scrub.py` (12 patterns + optional exact values from `SRE_AUTOFIX_EXTRA_SECRETS_FILE`); PII patterns do not apply to diffs | `secret_hit` |
| 4 | `验证证据已申报` | `.sre-evidence/verification.json` parses, has boolean `all_passed`, a non-empty `checks[]`, every `checks[].passed == true`, and `all_passed == true` (tolerant: nothing else is required) | `verification_failed` |
| 5 | `仓库自检命令通过` | **local only.** Every command in `config.yaml repos[<id>].checks` exited 0 when `cli.run_gate` ran it in the worktree (`sh -c`, cwd = worktree; `{files}` = changed files shell-quoted, `{worktree}` = its absolute path, `{root}` = the workspace root's absolute path; `checks_wall_sec` per command; full output in `runs/…/repo-checks.log`). Not configured ⇒ passes with a loud 『未配置』 detail; configured but the patch is empty ⇒ fails (nothing was checked) | `repo_check_failed` |

An empty `scope` list is a hard failure (everything is out of scope) — `run plan` refuses to start
with a `TODO(owner)` scope for that reason.

**Post-commit recheck** (`ship`, port of `fixleg.go:435-449`): after `git commit --only <files>`,
`git show --name-only HEAD` is re-evaluated against check 2. The gate ran on a dirty tree and commit
is a later step; if the file list were ever wrong the scaffold could slip in — the recheck stops that
before any push.

## Fail classes (parity with upstream `attempts.jsonl` / evals)

| Class | Meaning | Origin |
|---|---|---|
| `patch_empty`, `patch_not_applicable`, `diff_out_of_scope`, `scaffold_tracked`, `secret_hit`, `verification_failed`, `timeout` | as above / agent exceeded the wall clock | upstream, unchanged |
| `agent_error` | the agent CLI exited non-zero or reported `is_error` | replaces upstream `codesec_error` |
| `agent_missing` | neither `claude` nor `codex` on PATH (headless) | local only |
| `repo_check_failed` | a `repos[].checks` command exited non-zero (124 = killed by `checks_wall_sec`) | local only |
| `codesec_busy`, `workspace_root_owned` | reserved; only meaningful for the container executor | not emitted |

Every attempt line in `runs/sre-autofix/<id>/attempts.jsonl` carries `fail_class` so "the same class
keeps recurring" is visible across incidents (upstream decision #81-2).

## What the gate is not

Straight from `fixgate.go:4-16`: it does **not** replicate CI (syntax, style, compile → the target
repo's `on: pull_request` job, visible on the PR), does **not** run regression (N3 / #82, out of this
suite's scope), and carries **no language knowledge of its own**. Checks 1–4 are the same for every
language; check 5 is the same *mechanism* for every language — the operator supplies the commands.

## Why check 5 exists (2026-08-26 drill)

The first real run (`INC-20260826-005500-4c1d7d91`, PHP) passed checks 1–4 and shipped a patch that
throws `Error: Cannot pass parameter 2 by reference` on the very path it was meant to fix: a literal
`[]` passed to a by-reference constructor parameter. `php -l` does not see it (runtime error), the
target repo's own lint (`php -l` + phpcs) does not see it, and the agent's `verification.json` was
static-only because the machine had no PHP. A static analyser does see it (PHPStan `argument.byRef`);
`go build` / `go vet` would have seen the Go equivalent at compile time. Which tool applies is a
property of the repo, not of the suite — hence `repos[].checks`, with `run doctor` warning when it is
empty or a listed binary is missing, and `INCIDENT.md`'s 环境事实 telling the agent exactly what the
gate will run so it can run the same thing first. When `checks` is empty, `run doctor` suggests
what to put there from the repo's own CI `run:` steps and toolchain markers (`lib/suggest.py`,
advisory only — see the runbook's "Which check commands does my repo need?").

For a legacy PHP repo with no composer autoload and no maintained baseline (the drill's case: 17.8k
files, a whole-tree baseline does not finish in 10 min), `docs/examples/phpstan-new-errors.sh` is a
ready-made check command: it baselines the changed files' HEAD versions in a temp dir, then analyses
the patched versions with that baseline, so only errors the patch *introduces* fail the gate. Measured
on the drill: bad patch → exit 1 naming the by-ref line in 25 s; good patch (#1925) → exit 0 in 9 s
(warm cache). Needs docker; framework stubs via `PHPSTAN_STUBS` (e.g. phalcon/ide-stubs `src/`);
`argument.byRef` needs level ≥ 5.
