---
id: regression-case:code-map-scope-smoke
type: regression-case
owner: EricZhang
version: "08d9396deb83f5d447eab64aef3611b863cf3265"
status: active
summary: Pins the code-map-scope contract — the scripts it drives exist and keep their flags (generate-map --stamp-cbmignore, ws map), and SKILL.md keeps its canonical-location rule, the four buckets, and the never-write-into-repos hard rule.
use_when: Run after editing skills/code-map-scope/ or scripts/generate-map, before merging.
usage: sh skills/code-map-scope/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:code-map-scope"]
regression: []
---

# regression-case:code-map-scope-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:code-map-scope` 的
`regression:` 指针能被 `check-asset-refs` 解析(#119);可执行体是同目录的 `smoke.sh`,
守卫内容见其头部注释。
