---
id: regression-case:token-usage-analysis-smoke
type: regression-case
owner: EricZhang
version: "2268be104de9033410225f369626bdbc0bd90197"
status: active
summary: Pins the token-usage-analysis contract - skill files and collector exist, the privacy hard-rules survive in SKILL.md, frontmatter stays complete, the collector run on planted fixtures aggregates correctly (subagents/ recursion, keep-max streaming dedup), anonymizes non-workspace projects, drives the ccusage hybrid adapter (correlatable set, source label, reconciliation, >5% flag, schema/fallback paths, no auto-download), refuses to green on empty sources, and the task-instance view splits by session/idle gap with stage sequences, stays zero-manual, quarantines legacy cluster annotations, renders local HTML, and surfaces annotations as 标注 confidence.
use_when: Run after editing anything under skills/token-usage-analysis/ or scripts/token-usage-report, before merging.
usage: sh skills/token-usage-analysis/regression/smoke.sh <workspace-root> - the executable check is smoke.sh beside this record.
dependencies: ["skill:token-usage-analysis"]
regression: []
---

# regression-case:token-usage-analysis-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:token-usage-analysis` 的
`regression:` 指针能被 `check-asset-refs` 解析(#119);可执行体是同目录的 `smoke.sh`,
守卫内容(含对 `scripts/token-usage-report` 的 fixture 行为测试)见其头部注释。
