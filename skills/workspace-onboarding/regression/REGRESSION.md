---
id: regression-case:workspace-onboarding-phase0-smoke
type: regression-case
owner: EricZhang
version: "18333cb252c19f0f52cb848726ecffc2b510b127"
status: active
summary: Pins the workspace-onboarding phase-0 contract — orientation paths resolve and the SKILL.md keeps its workspace-first / citations-always phrases.
use_when: Run after editing anything under skills/workspace-onboarding/, before merging.
usage: sh skills/workspace-onboarding/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:workspace-onboarding"]
regression: []
---

# regression-case:workspace-onboarding-phase0-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:workspace-onboarding` 的
`regression:` 指针能被 `check-asset-refs` 解析(#119);可执行体是同目录的 `smoke.sh`,
守卫内容见其头部注释。
