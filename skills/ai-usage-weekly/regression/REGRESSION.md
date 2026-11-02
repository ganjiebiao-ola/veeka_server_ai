---
id: regression-case:ai-usage-weekly-smoke
type: regression-case
owner: EricZhang
version: "0000000000000000000000000000000000000000"
status: draft
summary: Pins the ai-usage-weekly contract (#22) - skill files, the weekly script and its submission schema exist, the transparency hard-rules survive in SKILL.md, frontmatter stays complete, `submit` on the planted token-usage fixtures yields a schema-valid submission with a price-table cost and no raw paths/session ids, `team` aggregates the planted submissions, quarantines a broken file, lists the missing member, renders self-contained SVG charts and keeps people in name order, and both refuse to green on empty input.
use_when: Run after editing anything under skills/ai-usage-weekly/, scripts/ai-usage-weekly, or platform-internals/schemas/ai-usage-submission.schema.json, before merging.
usage: sh skills/ai-usage-weekly/regression/smoke.sh <workspace-root> - the executable check is smoke.sh beside this record.
dependencies: ["skill:ai-usage-weekly"]
regression: []
---

# regression-case:ai-usage-weekly-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:ai-usage-weekly` 的 `regression:`
指针能被 `check-asset-refs` 解析;可执行体是同目录的 `smoke.sh`,守卫内容见其头部注释。
