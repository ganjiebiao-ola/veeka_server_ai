---
id: regression-case:workspace-update
type: regression-case
owner: EricZhang
version: "034fcef1472564ff8472f166c7ab6e921ab4be6c"
status: active
summary: Offline tests of scripts/check-freshness against a temp clone with a bare origin — up to date, behind on the default branch and on another branch, a default branch other than main, the session-start files (including CLAUDE.md's @imports) that need a restart, the data label on commit subjects, the hourly fetch throttle, an unreachable or hanging origin, a folder that is not a git repo, and both tracked hook commands (Codex from inside a mounted repo).
use_when: Run after editing scripts/check-freshness, its hooks in .claude/settings.json / .codex/hooks.json, or this skill. ws test runs it.
usage: python3 platform-internals/tests/test_freshness.py
dependencies: ["skill:workspace-update"]
regression: []
---

# regression-case:workspace-update

The skill starts from `scripts/ws freshness`, and the session-start hook points agents at the skill, so
its case is the script's test, `platform-internals/tests/test_freshness.py`. It needs no network.
`scripts/ws test` runs it in the framework green line, so this case has no `smoke.sh`.
