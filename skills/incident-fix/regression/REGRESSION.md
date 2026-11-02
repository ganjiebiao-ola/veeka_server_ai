---
id: regression-case:incident-fix-smoke
type: regression-case
owner: EricZhang
version: "558e3866b00b2607740ba0c35bd49559c4f12b92"
status: draft
summary: Pins the incident-fix contract — the workspace paths the skill points at resolve, its templates/references exist with their fixed anchors (FIXNOTES 《改了什么》, verification.json defaulting to all_passed:false), the incident-fix:contract markers appear exactly once so the suite can splice on them, the v3/v4 contract anchors upstream evals grep for survive, and no project-specific noun or team repo id leaked in.
use_when: Run after editing anything under skills/incident-fix/, before merging.
usage: sh skills/incident-fix/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:incident-fix"]
regression: []
---

# regression-case:incident-fix-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:incident-fix` 的 `regression:`
指针能被 `check-asset-refs` 解析(#119);可执行体是同目录的 `smoke.sh`,守卫内容见其头部注释
(工作区路径、模板/references 锚点、契约标记计数与上游 eval 锚点、专名黑名单)。
