---
id: regression-case:workspace-upstream-sync-smoke
type: regression-case
owner: muchen
version: "ed0ddf2b9f4bffd233cf927df421c7bcc45aadcf"
status: active
summary: Smoke for workspace-upstream-sync — required scripts present with their CLI contract, SKILL.md keeps its key mechanics, and regression/sync-fixture.sh runs two synthetic upstream sync rounds (seed kept, framework followed, rename clean, guard + pin) plus the no-driver negative case.
use_when: Run after editing anything under skills/workspace-upstream-sync/ or scripts/sync-upstream-ship, before merging.
usage: sh skills/workspace-upstream-sync/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:workspace-upstream-sync"]
regression: []
---

# regression-case:workspace-upstream-sync-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:workspace-upstream-sync` 的
`regression:` 指针能被 `check-asset-refs` 解析(#119);可执行体是同目录的 `smoke.sh`,
守卫内容见其头部注释。
