---
id: regression-case:skills-source-loader-smoke
type: regression-case
owner: EricZhang
version: "71350fbfee0db17677ca0dc4703bdc863d77253d"
status: active
summary: Pins the skills-source-loader contract — workspace prerequisites (workspace.yaml, scripts/setup-skills, agent-instructions/mount-points.md) exist and are executable, workspace.yaml declares skill_catalog, scripts/setup-skills keeps its --index/--id/--category/--list flags, and SKILL.md keeps its key mechanics phrases (live --index discovery, trial mount mode, fresh-subagent handoff). The --index scan itself is tested in platform-internals/tests/test_repo_tooling.py.
use_when: Run after editing anything under skills/skills-source-loader/ or scripts/setup-skills, before merging.
usage: sh skills/skills-source-loader/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:skills-source-loader"]
regression: []
---

# regression-case:skills-source-loader-smoke

本文件是该回归用例的**资产记录**(#48 frontmatter),使 `skill:skills-source-loader` 的
`regression:` 指针能被 `check-asset-refs` 解析(#119);可执行体是同目录的 `smoke.sh`,
守卫内容见其头部注释。`setup-skills --index` 的扫描行为由 `platform-internals/tests/test_repo_tooling.py`
测试。
