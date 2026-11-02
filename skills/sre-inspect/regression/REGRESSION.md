---
id: regression-case:sre-inspect-smoke
type: regression-case
owner: EricZhang
version: "9e83219ae2c7d76c80b16e5a7adbb1fb122661da"
status: draft
summary: Pins the sre-inspect driver contract — the suite entry points and docs it drives exist and are executable, the verb sequence (doctor → intake → dive → finish → autofix claim) and the discipline phrases (injected time facts, anchor check, layers, cause_locus, never-list) survive in SKILL.md, and no project-specific noun or mounted repo id leaked in.
use_when: Run after editing anything under skills/sre-inspect/ or the suites/sre-inspect entry points it names, before merging.
usage: sh skills/sre-inspect/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:sre-inspect"]
regression: []
---

# regression-case:sre-inspect-smoke

本文件是该回归用例的**资产记录**（#48 frontmatter），使 `skill:sre-inspect` 的 `regression:` 指针能被
`check-asset-refs` 解析；可执行体是同目录的 `smoke.sh`：suite 入口与文档存在且可执行、动词序列与纪律短语、
专名与挂载仓 id 黑名单。
