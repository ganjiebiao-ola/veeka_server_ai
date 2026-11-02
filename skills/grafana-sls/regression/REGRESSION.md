---
id: regression-case:grafana-sls-smoke
type: regression-case
owner: EricZhang
version: "9e83219ae2c7d76c80b16e5a7adbb1fb122661da"
status: draft
summary: Pins the grafana-sls skill contract — the script and suite entry points it names exist, the hard rules (colon keys unquoted, epoch-only time, count-before-raw, limit cap, error table keys) survive in SKILL.md, the script's --help lists the four subcommands, and no project noun leaked in.
use_when: Run after editing skills/grafana-sls/ or suites/sre-inspect/tools/grafana-sls/sls_query.py, before merging.
usage: sh skills/grafana-sls/regression/smoke.sh <workspace-root> — the executable check is smoke.sh beside this record.
dependencies: ["skill:grafana-sls"]
regression: []
---

# regression-case:grafana-sls-smoke

本文件是该回归用例的**资产记录**（#48 frontmatter），使 `skill:grafana-sls` 的 `regression:`
指针能被 `check-asset-refs` 解析；可执行体是同目录的 `smoke.sh`。守卫内容：脚本与 suite 入口存在且
可执行、`sls_query.py --help` 列出四个子命令、SKILL.md 保留硬规则短语（冒号 key 不加双引号 / 注入 epoch /
先 count 后原文 / limit 上限 / 错误对照键）、专名与挂载仓 id 黑名单。
