---
id: regression-case:code-map-query-smoke
type: regression-case
owner: EricZhang
version: "5c4e41985724c62090ed0569f5fd3fee6b1b8ec2"
status: active
summary: Pins the code-map-query skill's contract — SKILL.md keeps its tool names (search_graph, trace_path, get_code_snippet, check_index_coverage), evidence-tier names (Scout/Verify/Auditor), MCP-server prerequisite note, and the First Move/What Counts As Enough/Retrieval Budget/Stop working-discipline sections.
use_when: Run after editing skills/code-map-query/SKILL.md, before merging.
usage: sh skills/code-map-query/regression/smoke.sh — the executable check is smoke.sh beside this record.
dependencies: ["skill:code-map-query"]
regression: []
---

# regression-case:code-map-query-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:code-map-query` 的
`regression:` 指针能被 `check-asset-refs` 解析(#119);可执行体是同目录的 `smoke.sh`,
守卫内容见其头部注释。
