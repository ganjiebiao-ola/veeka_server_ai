---
id: regression-case:sre-autofix-smoke
type: regression-case
owner: EricZhang
version: "558e3866b00b2607740ba0c35bd49559c4f12b92"
status: draft
summary: Pins the sre-autofix operator-driver contract — the suite entry points and docs it drives exist and are executable, the five verbs and the hard rules (harness_guard, never auto-merged, Closes→Refs, local-path-only input, TODO(owner)) survive in SKILL.md, and no project-specific noun or mounted repo id leaked in.
use_when: Run after editing anything under skills/sre-autofix/ or the suites/sre-autofix entry points it names, before merging.
usage: sh skills/sre-autofix/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:sre-autofix"]
regression: []
---

# regression-case:sre-autofix-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:sre-autofix` 的 `regression:`
指针能被 `check-asset-refs` 解析(#119);可执行体是同目录的 `smoke.sh`,守卫内容见其头部注释
(suite 入口与文档存在且可执行、动词序列与硬规则短语、专名与挂载仓 id 黑名单)。
