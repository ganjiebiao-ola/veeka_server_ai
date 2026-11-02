# AI Workspace 模板

[English](README.en.md) | 简体中文

> 英文版见 [`README.en.md`](README.en.md)。两者不一致时，以英文版为准（"每个事实只有一个权威版本"）。

团队级 AI-Workspace 是一个 **AI 能力的骨架**：不含业务代码、本身没有任何能力——只有结构、挂载点
和约定。团队把自己的**业务仓库、可复用 skill、知识库** `git clone` 进挂载点，框架把它们与团队上下
文、工程规则一起，组织成一个 agent 和成员都能可靠**读取、组合、复用**的环境。内容永远以挂载方式
进入、绝不拷贝，并且各自保留自己的版本。

**为什么要做——信息平权。** 没有框架时，谁能用好 AI 取决于个人经验，能力锁在少数人的脑子里。
仓库被框架包裹之后，隐性知识变成 agent 可消费、人人可复用的显性资产：新加入项目的成员、或不擅长
写 prompt 的成员，用同样的上下文产出同等质量的工作。下游的每一个设计取舍，都用"是否降低了门槛"
来评判。

## 快速开始

1. **用模板建仓** —— GitHub 上点 "Use this template"，或 clone 后改 remote。
2. **挂载资产** —— `git clone`（绝不拷贝）业务仓库 → `repos/`、skill → `skills/`、知识库 →
   `knowledge/`。模板已自带若干 workspace 原生 skill（清单见 `skills/README.md`），其余按需挂载。
3. **编辑 `workspace.yaml`** —— 填写 owner，把 `repo_catalog`（和可选的 `skill_catalog`）换成你团队的真实
   清单；`repositories:` 保持冻结的 `[]`（真实挂载列表在 gitignored 的 `workspace.local.yaml`，由
   `scripts/setup-repos` 维护）。
4. **检查** —— 先 `scripts/ws validate`，再 `scripts/ws health`。
5. **（可选）生成代码地图** —— `ws map install` 把 `codebase-memory-mcp` 装到 `~/.local/bin`
   （无需 sudo），再 `ws map generate --all` 为每个已挂载仓库写出
   `knowledge/maps/<id>/README.md`；`ws map verify` 做产物体检。全程无人值守：仓库还没有
   `.cbmignore` 时，会先由你自己的 agent CLI 写一份（`--no-auto-cbmignore` 可跳过）。为
   `code-map-query` skill 的结构化查询提供支持——跳过这一步不影响以上其他步骤。

团队规则随用随补进 `agent-instructions/` 和 `rules/`。**目录允许留空——不要试图在第一天填满一切。**
安全默认值开箱即生效。

> **起步只需要读两份文档：本文和
> [`agent-instructions/mount-points.md`](agent-instructions/mount-points.md)。** 其余内容都可以
> 从下面的表格按需到达。

## 跟上游模板同步（下游团队必读）

用本模板建出来的 workspace 是**下游**，本仓是**上游**。上游会持续改进，下游要定期把改动合进来，规则只有一条：

**用 `merge`，永远不要 `rebase`。**

- 每个路径只有一个主人（`platform-internals/ownership.yaml`）：框架路径两边逐字相同，merge 不会冲突；
  `README`、`rules/`、`workspace.yaml` 这些种子文件由 `.gitattributes merge=ours` 保留你们的版本；
  `CLAUDE.md` / `AGENTS.md` / `team-context/manifest.yaml` 是渲染产物，合并后重新渲染即可。
- rebase 会让 git 对调 ours / theirs：种子文件会被换成上游版本，**你们的改动静默丢失、没有冲突提示**
  （`scripts/lib/merge-keep-team` 能兜住这个失误，但 rebase 之后还得 force-push，发布脚本会拒绝）。
- 同步 PR 必须用 **merge commit** 合并。squash 会重置 merge base，下一次同步把所有改动重放一遍。

具体步骤由自带的 `workspace-upstream-sync` skill 执行：对 agent 说「跟上游同步」，它会 `git merge upstream/main`、
用 `scripts/upstream-pin` 记录同步到的上游提交、重新渲染、跑 `ws validate / health / test`，再经
`scripts/sync-upstream-ship` 推送并开 PR。首次采用所有权模型的 workspace 按该 skill 的 "First adoption" 一节操作。

反过来，通用改动（`agent-instructions/`、`scripts/`、自带 skill 等框架路径）先改上游：从本仓 `main` 切
`contrib/<topic>` 分支提 PR，合并后再同步下去。下游本地改了框架路径，`ws health` 的 `ownership` 项会报红。
上游改了种子文件不会自动到你们手里，看 [`CHANGELOG.md`](CHANGELOG.md) 手动采纳。

## 保持 workspace 最新

队友会不断往本 workspace 的 `main` 合 PR。Claude Code / Codex 每次开会话都会检查你的 clone 是否落后
`origin` 的默认分支（每小时最多 fetch 一次，不拖慢启动）。落后时 agent 会告诉你并提出更新，**你同意后**
才由自带的 `workspace-update` skill 执行：说明队友改了什么、`git pull --ff-only origin <默认分支>`、再做后续动作（入口或
hook 文件变了要重启会话、新挂的仓库和 skill 等）。随时也可以说「更新 workspace」，或手动检查：

```sh
scripts/ws freshness
```

它只更新本 workspace，不碰 `repos/`（那是 `scripts/update-repos`），也不同步上游模板（那是上一节的
`workspace-upstream-sync`）。Codex 只在你审核过项目 hook 后才运行它：第一次会提示你在 `/hooks` 里信任
`.codex/hooks.json` 的这条 hook。

## 自带 skill 怎么用

模板自带若干 workspace 原生 skill（在 `skills/` 下，完整清单见 [`skills/README.md`](skills/README.md)）。Claude Code / Codex 在 workspace 根打开即
自动发现，无需安装；在对话里说出你要做的事即可触发，也可用 `/<skill 名>` 显式调用：

| skill | 什么时候用 | 例子（直接对 agent 说） |
|---|---|---|
| `workspace-context-bootstrap` | 挂载了新业务仓，要为它生成受信的按仓上下文 | 「给 repos/mall-backend 初始化 workspace 上下文」 |
| `workspace-onboarding` | 新成员熟悉项目，要有引用出处的导览与上手计划 | 「我是新人，带我过一遍这个 workspace」 |
| `spec-authoring` | 把需求文档/原始资料抬升为四部分结构化 Spec | 「/spec-authoring 项目是 XX 消除小游戏，引擎倾向 cocos，资料在这份文档里」；对已有 Spec：「体检这份 Spec，找缺口」 |
| `token-usage-analysis` | 分析自己本机的 AI 编码 token 消耗（数据不出本机，报告脱敏落 `runs/`），支持任务实例级下钻与本地 HTML 页面 | 「分析我最近 30 天的本地 token 使用，哪个仓最耗?」；「按任务看这两周 token 烧在哪、结果如何」 |
| `ai-usage-weekly` | 每周 AI 使用周报（用量 / 费用 / 使用内容 / 产生的价值）：本机用量 × 价格表 = **估算**费用，AI 起草、人确认叙事，写入团队报告仓；组长汇总一周提交为团队报告页（不按费用排名，三种金额分列不相加） | 「生成我这周的 AI 使用小结并提交」；组长：「汇总本组 2026-W37 周报」 |

`token-usage-analysis` 是对话入口（skill），底层由两个报告脚本驱动，也可以不经对话直接跑
（完整命令与可选 ccusage 安装说明见 [`skills/README.md`](skills/README.md)）：

```sh
scripts/token-usage-report                # 聚合报告:五条线索 + 成本 + 对账
scripts/token-usage-report --html --open  # 同上,渲染为本地 HTML 并打开
scripts/token-usage-tasks report          # 任务实例视图:烧在哪/干了什么/结果如何
```

`ai-usage-weekly` 建在它之上，同样可以直接跑脚本（报告仓默认在 `knowledge/ai-usage-reports/`，
缺失时 `submit` 会自动建一个本地仓并给出接入团队仓的提示；工具从不 push、不联网，`--commit` 只做本地提交）：

```sh
scripts/ai-usage-weekly submit --week 2026-W37          # 本机用量 + 估算费用 → reports/<周>/<human_id>.{json,md,html}
scripts/ai-usage-weekly team --week 2026-W37 --open     # 组长:汇总一周提交 → team-report.html/.md
scripts/ai-usage-weekly request --form <request.json>   # 资源申请草稿(走公司既有审批流,工具不审批)
scripts/ai-usage-weekly month --allocation <september_2026.xlsx>   # 组长:月度报告(实际费用按团队 + 周报汇总 + 代码仓)→ reports/months/<YYYY-MM>/
```

**token-usage-analysis 使用示例**：

- **例 1 · 月度总览**——对 agent 说：「分析我最近 30 天的本地 token 使用，哪个仓最耗？」
  skill 会先声明隐私契约（数据不出本机、报告脱敏），跑完给出五条线索解读：日趋势与峰值日、
  挂载仓 × 分支消耗排行、模型分布、时段/会话模式，最后问你要**本地 HTML 页面**还是
  **terminal 摘要**。报告落在 `runs/token-usage/`（gitignored）。
- **例 2 · 任务复盘**——对 agent 说：「按任务看这两周 token 烧在哪、结果如何」。得到任务实例
  视图：每行一个自动切分的任务实例（阶段序列如 explore→edit→test、各阶段 token、git 信号），
  可选给实例补一条结果标注让复盘更准：
  `scripts/token-usage-tasks annotate --instance '<报告里的ID>' --result success --ref '#123'`

产出去向遵守挂载规则：写入业务仓的内容一律走**该仓自己的 branch/PR**。各 skill 的完整流程与
硬规则见其自身的 `SKILL.md`，清单见 [`skills/README.md`](skills/README.md)。

## 目录结构

| 路径 | 是什么 |
|---|---|
| `CLAUDE.md` / `AGENTS.md` | Agent 根入口（路标）——分别对应 Claude Code 和 Codex；运行时等价，但并非逐字节相同 |
| `workspace.yaml` | Workspace 声明：owner、挂载的仓库、本地权限、已知限制 |
| `agent-instructions/` | Agent 策略——安全默认值（始终生效）+ 下方按需加载的各规范 |
| `rules/` | 团队工程规则（编码 / PR / 测试 / 责任归属）；从 `rules/team-rules.md` 读起 |
| `team-context/` | **框架跟踪**的按仓上下文（`team-context/mounted-repos/<id>.md`）+ 读取顺序 manifest——受信来源 |
| `repos/` `skills/` `knowledge/` | **三个挂载点**——见 `agent-instructions/mount-points.md` |
| `suites/` | **框架跟踪**的垂直套件契约（`suites/<id>/SUITE.md` + `run`/`test`，在 `workspace.yaml agent_suites` 中登记）。第一个是 `sre-autofix`——把 SRE 根因报告变成可评审的修复 PR（从 `suites/sre-autofix/docs/quickstart.md` 读起）；第二个是 `sre-inspect`——在本地用部门 Grafana 单一数据面验真并深挖告警，产出 `sre-autofix` 能直接消费的 report.json（从 `suites/sre-inspect/docs/quickstart.md` 读起）；第三个是 `security-patch`——通过套件内的应用与 Agent 指令把安全发现变成小批量 PR，每个 bug 类型一个 GitHub issue 记录状态（从 `suites/security-patch/docs/quickstart.md` 读起）。约定见 `platform-internals/suites/README.md` |
| `scripts/` | `ws` 执行接口（`init` / `validate` / `test` / `regression` / `health` / `golden`）、零依赖的 `check-*` 守卫，以及 `lib/harness.sh` |
| `platform-internals/` | 自证层——fixture、样例、schema 和 golden 样例包。由平台维护；**你永远不需要读它**。例外是 `ownership.yaml`：它声明每个路径归模板还是归团队 |
| `CHANGELOG.md` | 上游对种子文件（README、rules、workspace.yaml 等）的改动公告，下游看这里手动采纳 |

还有一个目录会在使用中出现且被 gitignore：`runs/`（本地运行记录，首次调用 `ws` 时创建）。
golden 包 replay 的脚手架保存在各自包目录内（`.origin/` + `.mount/`，同样被 gitignore）——它生成
的任何东西都不会触碰挂载点。

## `agent-instructions/` —— 什么时候加载什么

每份文件都写明了自己是什么；唯一无法从单个文件里看出的是**它何时被加载**：

| 文件 | 加载时机 | Ticket |
|---|---|---|
| `security-defaults.md` | **始终生效**——注入每个任务，下游任何内容都不可覆盖 | #42 |
| `mount-points.md` | 按需——挂载任何东西、或判断某物该放哪时。**这份建议先读。** | #93 |
| `claude-md-hierarchy.md` | 按需——编写或评审 `CLAUDE.md` / `AGENTS.md` 时 | #42 |
| `asset-metadata.md` | 按需——创建、迁移、退役或审计资产时 | #48 |
| `context-manifest.md` | 按需——编写或审计读取顺序清单、上下文文档时 | #49 |
| `handoff-checklist.md` | 按需——交接时 | #50 |

只有第一行被 `CLAUDE.md` `@import`（并内联进 `AGENTS.md`）。其余按任务类型经
`team-context/manifest.yaml` 到达——agent 查询的是那份文件，不是这张表。

## 三条基本规则

- **人对结果负责** —— 每个 workspace 一位人类 owner（写在 `workspace.yaml`）；agent 通过共享
  workspace 协作，不设独立的 agent 身份。
- **一切经 PR 合入** —— 新增、改进、维护都通过 PR 进入。
- **凭证绝不进仓库** —— 一切都复用操作者本人的本地权限（gh CLI 登录、浏览器会话、IP 白名单、
  个人 SSH 配置）。

## 现状

MVP。已就位：三个挂载点与 manifest（#41）、agent 入口 + 规则模板（#42）、suite 挂载约定（#43）、
资产类型与元数据（#48）、Context Manifest 治理（#49）、`ws` 执行接口 + 破坏性操作 harness + 交接
清单（#50），以及 golden 样例包（#44）—— `scripts/ws golden campaign-validator` 把一条需求从结构化
需求重放到验收，让交接清单里"可独立重跑"这条标准变成**跑出来**的，而不是嘴上说说的。

随各自 ticket 交付逐步长入：垂直 suite 挂载到顶层 `suites/`——第一个 `sre-autofix`
（[#141](https://github.com/olaola-projects/ai-native-issues/issues/141)，Agentic SRE 的
coding-agent 半边在本地形态的落地）已就位，第二个 `sre-inspect`
（[#146](https://github.com/olaola-projects/ai-native-issues/issues/146)，巡检半边的本地形态：
Grafana 原生告警 intake → 简报 → 本会话或本地 Holmes 深挖 → report.json）随后就位，#7/#8/#9/#10 随后；Spec 体系（#31，
S1–S4 已交付为 `skills/spec-authoring`——模板骨架、缺口识别、问答补齐与完成度判定、下游对接
契约；前锋实测与模版沉淀随 #117 长入）；
评估与回归（#36）；排障 runbook（#17/#18）；打包工具（#32/#16）。

实现 [#41](https://github.com/olaola-projects/ai-native-issues/issues/41)（经
[#93](https://github.com/olaola-projects/ai-native-issues/issues/93) 修订）；父任务为
[#28](https://github.com/olaola-projects/ai-native-issues/issues/28)。
