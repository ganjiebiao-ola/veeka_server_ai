---
id: regression-case:spec-authoring-smoke
type: regression-case
owner: EricZhang
version: "30186cc1e97d06c384b0e769ad160256bc5ca199"
status: active
summary: Pins the spec-authoring contract — coverage-map anchors resolve in all four templates, the 00 gap-report template and gap-rules keep their four-class anchors, the qa-loop keeps its D1–D4 gates and exit conditions, the downstream contract keeps its mapping/gate/field anchors, checklists and clarification markers intact, frontmatter and discovery symlinks unbroken.
use_when: Run after editing anything under skills/spec-authoring/ (templates, coverage-map, SKILL.md, smoke.sh), before merging.
usage: sh skills/spec-authoring/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:spec-authoring"]
regression: []
---

# regression-case:spec-authoring-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:spec-authoring` 的
`regression:` 指针能被 `check-asset-refs` 解析(#119);可执行体是同目录的 `smoke.sh`,
守卫内容见其头部注释(coverage 逐条校验、防删行下限、S2 缺口契约、S3 问答/判定契约与
S4 下游对接契约锚点、frontmatter 与 discovery 检查等)。
