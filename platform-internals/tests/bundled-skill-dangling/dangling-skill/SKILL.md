---
id: skill:dangling-skill
type: skill
owner: alice
version: "0000000000000000000000000000000000000000"
status: active
summary: Planted problem — a bundled skill whose regression pointer resolves to nothing.
use_when: Never; this is a check-health --self-test fixture, not a real skill.
usage: Consumed by check-bundled-skills via the argv[1] override during the health self-test.
dependencies: []
regression: ["regression-case:dangling-skill-smoke"]
---

# dangling-skill (planted problem)

栽种的问题:`regression:` 指向 `regression-case:dangling-skill-smoke`,但本目录**没有**携带
frontmatter 的 REGRESSION.md 资产记录 —— 正是 PR olaola-chat/ai-native-workspace-template#3
review 在三个真实 bundled skill 上发现的缺口(#119)。`check-bundled-skills` 扫到本目录必须
FAIL 并报 "does not resolve";self-test 以此证明接线真的在检,不是空转绿。
