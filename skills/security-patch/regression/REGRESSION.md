---
id: regression-case:security-patch-smoke
type: regression-case
owner: ziqi
version: "ce763fbb48efd647335cab19ee25cfe12ef3138e"
status: draft
summary: Checks the security-patch operator contract and its executable suite entry points. Checks the verbs and hard rules in SKILL.md. Checks for pilot data and mounted repo ids.
use_when: Run after editing anything under skills/security-patch/ or the suites/security-patch entry points it names, before merging.
usage: sh skills/security-patch/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:security-patch"]
regression: []
---

# regression-case:security-patch-smoke

This file is the asset record (#48 frontmatter) for this regression case, so the `regression:`
pointer of `skill:security-patch` resolves under `check-asset-refs`. The executable check is
`smoke.sh` in the same directory. Its header comment lists what it guards.
