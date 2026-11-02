---
id: regression-case:workspace-context-bootstrap-smoke
type: regression-case
owner: EricZhang
version: "066c5fc7417768708ed8d7908018b17b08fbd9c6"
status: active
summary: Pins the workspace-context-bootstrap contract — preflight paths resolve, the mounted-repo-context template keeps its required sections, hard-rule phrases and portability hold, and the agent-entry checker greens the good fixture while rejecting every planted problem (missing file / no marker / stale SHA / diverged blocks).
use_when: Run after editing anything under skills/workspace-context-bootstrap/, before merging.
usage: sh skills/workspace-context-bootstrap/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:workspace-context-bootstrap"]
regression: []
---

# regression-case:workspace-context-bootstrap-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:workspace-context-bootstrap`
的 `regression:` 指针能被 `check-asset-refs` 解析(#119);可执行体是同目录的 `smoke.sh`,
守卫内容见其头部注释。
