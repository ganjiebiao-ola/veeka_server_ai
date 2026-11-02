# quickstart — 从一个 Grafana token 到一份完成的报告

> English version: [quickstart.md](quickstart.md)（两份内容同步维护，改一份要改另一份）。

一切从工作区根目录运行，只需 python3 ≥ 3.8。Docker 可选（指标走 mcp-grafana、可选的本地 HolmesGPT 才需要）；
`gh` 可选（只有发布事实/L7 需要）。

## 0. 一次性准备（操作者）

```sh
cd suites/sre-inspect
cp tenant.yaml.example tenant.yaml        # 见下：两种落位，选其一
cp routes.yaml.example routes.yaml
cp env/holmes-env.example env/.env.holmes && chmod 600 env/.env.holmes   # 填 GRAFANA_URL + token
$EDITOR tenant.yaml routes.yaml           # 数据源填 Grafana 显示名；rule uid 换成你们的
```

**两种落位，选其一**（判断法一句话：你 checkout 的这个仓，允不允许把本部门的配置**提交**进去？允许 → ①；不允许——比如它是公共模板仓 → ②。两者内容完全相同，②→① 只是改文件名）：① **部门工作区实例**——提交 `tenant.yaml` / `routes.yaml`（非密钥配置入库、
走 PR 评审，正常态）；② **模板仓检出上的试跑**（部门实例还不存在时）——改用双胞胎文件名
`tenant.local.yaml` / `routes.local.yaml`，被 gitignore，且存在时**优先于**同名 tracked 文件。
注意拼写：`.local` 在中间（`tenant.local.yaml`），写成 `tenant.yaml.local` 会被静默忽略。
部门实例仓还不存在？建仓是 workspace 层的一步——模板仓 README「快速开始」第 1 步
（GitHub "Use this template"，或 clone 后改 remote；`scripts/ws init <dir>` 释放无历史骨架），
建好、按 README 填过 `workspace.yaml` 之后，回到本文件按 ① 走。

- `tenant.yaml`：`grafana.url`（= env 里的 `GRAFANA_URL`）、agent 可用的数据源（`datasource:` 字段填 Grafana **数据源的显示名**，不是指标名——指标是运行时发现的；
  SLS 通常一个 logstore 一个数据源）、probe 探活对、对齐你们通知策略的 `alert_source.filter`、
  发布走 GitHub Actions 的话填 `deploys[]`。
- **怎么为你们业务挑 datasources / 找 uid / 找发布 workflow**（不是凭感觉，是对账；每一步都有现成动词，也可以直接让 agent 做——
  skill `sre-inspect` §5 写了它该怎么帮你）：① `run discover datasources` 盘点全部数据源；② `run discover rules`
  列出全部告警规则、各自查的数据源、以及**哪些还没路由**——规则查的数据源必须进清单（验真要重查触发告警的那条序列），
  未路由的规则它直接打印 routes.yaml 片段（rid/layer/template 由人填）；③ `run discover deploys <owner/repo>`
  找出该仓的发布 workflow 并打印 deploys[] 片段——**能落到告警主机上的每个仓都要列**；④ 覆盖面用
  `list_prometheus_metric_names`（regex 如 `^AliyunEcs_` / `^nsq_`）确认：主机层（云监控）与应用层（自埋点）至少各一，
  `probe.metrics_datasource` 指向云监控那个；⑤ 之后每份报告的 `data_gaps` 就是补货清单。
- `routes.yaml`：rule uid → RID / 验真模板（`triage/*.md`，占位符见 `triage/README.md`）。
  uid 与现成片段来自 `run discover rules`（或 `run intake` 的 unrouted 段）。
- 指标面（mcp-grafana）怎么接给 Claude Code / Codex：见下面 §2「接上你的 agent」，是流程里独立的一步。

### 在另一台机器（比如笔记本）上试跑——部门还没提交自己的配置时

新 clone 只要**带三个文件**就能对真 Grafana 跑起来，三个都不入 git：`tenant.local.yaml` 与
`routes.local.yaml`（非密钥——数据源名与规则路由；从已配好的机器拷来，或照 `.example` 双胞胎现写）放进
`suites/sre-inspect/`，再加你自己的 `env/.env.holmes`（token 自己填，**绝不经聊天传递**）。之后走同一条
`validate → doctor → intake` 路径。笔记本注意事项：

- 只有 python3 也能跑通日志 + 告警 intake + dive/finish；**Docker 只为** mcp-grafana 指标工具与可选的
  本地 Holmes 服务（没有就 `run doctor --no-mcp`）。钉的 mcp-grafana digest 是多架构索引
  （amd64 + arm64），Apple Silicon 原生拉取。
- 本地 Holmes 镜像要在你机器上从 HolmesGPT fork 源码构建（fork 检出里
  `docker build -t holmes-ocinf:main .`；名字不同就设 `HOLMES_IMAGE`）——没有镜像仓可拉。
- `gh` 未装/未授权只会把 L7 发布表降级为「未接入」。
- 你的网络若需 VPN / IP 白名单才能到 Grafana，`run doctor` 会最先在 D1 失败——先解决连通性再看其余输出。

## 1. 就绪检查

```sh
suites/sre-inspect/test              # 第一道门·离线自检：不要 token、不要 Docker——新机器上最先跑这个
suites/sre-inspect/run validate      # 离线：tenant/routes/toolset 凭据守门
suites/sre-inspect/run doctor        # 在线：Grafana 健康、数据源 + token 权限、`up`、一条 SLS count、mcp-grafana stdio、gh
suites/sre-inspect/run spike         # 可选，跑一次：#146 的 G0 清单 → runs/sre-inspect/spike-<ts>.md
```

每步期望看到什么：

- `test` → `OK: sre-inspect test passed (… unit tests + 2 skill smokes + guards)`。红了 = 代码在这台
  机器上就有问题（比如平台差异），先修它，别碰后面。
- `run validate` → 两行文件定位 + `OK: validate`；每处配置错误都会指名道姓。
- `run doctor` → `MUST` 行全 `[ OK ]`。D1 红 = 你的网络到 Grafana 不通（VPN/白名单，与代码无关）；
  D4 需要 Docker，没装只降级指标通道，不挡日志与 intake。
- `run spike` → 一份落在 runs/ 的实测报告（可选）。

`MUST` 行全绿再往下走。

## 2. 接上你的 agent（Claude Code / Codex）

深挖是由**你的 agent** 在会话里完成的，所以要先把它接到数据面上。日志面零配置（`grafana-sls` skill
走 Bash）；指标面（Prometheus / 告警规则 / 面板）要给它一个 MCP server：

```sh
suites/sre-inspect/run mcp-config --write  # 第一次：把 "grafana" server 写/合并进工作区根目录的 .mcp.json（不带 --write 只打印；Codex 用打印出的 ~/.codex/config.toml 片段）
set -a; . suites/sre-inspect/env/.env.holmes; set +a    # 每次：.mcp.json 里的 ${VAR} 取自 agent 进程的环境
cd <工作区根目录> && claude                # 必须从工作区根目录、在这个 shell 里启动（项目级 .mcp.json 按启动目录找）
```

首次启动 Claude Code 会询问是否信任这个项目的 MCP server——选允许（之前拒绝过：`claude mcp reset-project-choices`）。
会话里敲 `/mcp`，看到 `grafana` 已连接才算接上。看到 "No MCP servers configured" = 没在根目录启动、
或 .mcp.json 不是合法 JSON（`claude doctor` 会列出校验失败的配置文件）；连接失败 = 没 source env，
或 Docker 没起（sidecar 是 docker 起的）。没有 Docker 也能继续：只是 agent 缺指标工具，日志与 intake 照常。

## 3. intake → 挑件

**你在 Claude Code 会话里说**（或直接 `/sre-inspect`）：

> 看看今天的告警

**agent 会做**：先 `run doctor` 预检，再 `run intake --since 24h`，然后把摘要转述给你。intake 读 Alertmanager
（此刻 firing）+ 告警状态史（窗内转入 Alerting 的），过 `alert_source.filter`、按 `routes.yaml` 路由、查复发台账，
分成四组：

```
窗 …：alertmanager firing=1, annotations Alerting=12, rules=27
过滤后 7 条（6 条被 filter 丢弃）→ 7 个指纹 → 候选 3 件，冷却抑制 0，known_bug 0，unrouted 4
候选（`run dive <n>`）：
  [5] R-01 API | 5XX | /v1/orders | 08-31 04:07:00 (alerting-transition) | 模板 api-5xx.md
  [7] R-08 ECS | Memory | app-host-002 | 08-21 14:06:50 (firing) | 模板 ecs-memory.md
unrouted（先在 routes.yaml 对号、补 triage 模板，再 dive）：
  [1] Process | Not Running | uid xxxxxxxxxxxxxx | svc.worker | rule_uid 不在 routes.yaml
```

- **候选**：路由到了模板、且不在冷却窗内——可以挖的件；
- **冷却抑制**：同指纹在 30 分钟内已并入某个未关闭的 incident，不新开；
- **known_bug**：`routes.yaml` 里声明的确定性判定（如 NoData 残影），不花模型；
- **unrouted**：规则不在路由表 / 没模板——**列出来但不挖**。

**你决定**：报一个候选编号给 agent（「排查第 5 件」）。unrouted 的件先让 agent 起草 `routes.yaml`
条目 + 验真模板、走 PR 合入后再挖——不要让它无模板硬挖。摘要说"窗内没有新候选"（退出码 3）是合法结果。

等价的手工方式（调试用）：终端跑 `suites/sre-inspect/run intake --since 24h`，或会话里 `!suites/sre-inspect/run intake --since 24h`
（`!` 前缀 = 直接执行 shell，不经模型）。队列文件在 `runs/sre-inspect/queue/latest.json`。

## 4. dive → 深挖 → finish

**你在会话里说**：

> 排查第 5 件

**agent 会做**（按 `skills/sre-inspect` 的顺序，你只需旁观与纠偏）：

1. `run dive 5` → 生成 `runs/sre-inspect/INC-…/`，其中 `INSPECT.md` 是简报：注入的时间事实、告警 labels、
   渲染好的验真模板、分层要求、L7 发布表、产出契约；
2. 读简报后**先验真**（PASS / FAIL / INDETERMINATE）——PASS 就写结论收工，FAIL 才深挖；
3. 深挖：日志走 `grafana-sls` skill（它应先 `fetch` 这个 skill 再写第一条 SLS 语句），指标/告警规则/面板走
   mcp-grafana 的工具，L1→L7 逐层，数据支撑与假设分开写；
4. 在事件目录写 `rca.md` + 填 `report.json`；
5. `run finish INC-…` → 校验契约、脱敏、记台账。退出码 4 = 报告缺字段（信息会列出，让它补）；
   5 = 文本里有密钥形态的串（去掉重跑）。

**你盯三件事**：它先跑没跑 `run dive`；写 SLS 前有没有先读 `grafana-sls`；最后有没有自己 `run finish`
且退出码 0。它要是绕开命令自由发挥，打断并让它回到简报。

**产物**：`runs/sre-inspect/INC-…/rca.md`（人读，已脱敏，可直接转发）与 `report.json`（机器契约 v1.1）。
FAIL 且 `cause_locus=code_defect`、置信 ≥ medium 时，`finish` 会打印下一步 `suites/sre-autofix/run claim …`
——交给修复腿；归属是 infra/dependency 的件，产物就停在 rca.md，转给对应层的人。PASS 会关闭该指纹
（进入 14 天复发布防窗）。

等价的手工方式：终端 `suites/sre-inspect/run dive 5`，自己按 INSPECT.md 查、自己写两份产物，再
`suites/sre-inspect/run finish INC-…`。

**重放一件历史告警**（复盘、或做模型 A/B）：不需要记任何参数——把 intake 的窗口指到历史，拿编号照常 dive：
`run intake --from 2026-08-27T00:00:00Z --to 2026-08-28T00:00:00Z` → `run dive <n>`。只有超出 Grafana
告警史保留期时才用手动形式 `run dive --rule-uid <uid> --at <epoch>`，两个值来自当时的队列存档
（`runs/sre-inspect/queue/*.json` 每项的 `alert.rule_uid` / `eval_epoch`）或 `alerting_manage_rules operation=list`。

**可选的本地 HolmesGPT**：`run dive 5 --holmes`（需要 `holmes/docker-compose.yaml` 起得来：把
`holmes/config.yaml.example` 拷成 `holmes/.holmes/config.yaml`，设 `HOLMES_IMAGE`）。回答落在 `holmes.md`；
`rca.md` / `report.json` 与 `finish` 仍由你的 agent 完成。长深挖 detached 起——前台超时会把深挖杀在半途。

## 怎样算「跑通」（新机器/新部门的验收线）

三条都满足才算，缺一不可：

1. **离线**：`suites/sre-inspect/test` 全绿；
2. **数据面**：`run doctor` 的 `MUST` 全绿；
3. **全流程一件**：由**你的 agent 按 skill 自己完成**——在 source 过 env 的 shell 里启动
   agent，会话里一句「排查一下队列里第 n 件」，它自己走 dive → 深挖（先 fetch `grafana-sls`
   再写 SLS 语句）→ rca.md + report.json → `run finish` 退出码 0。逐条命令手敲不算数：验的
   就是 skill 触发与纪律遵守。

## 5. 迭代知识件

每一条 unrouted、每一次快照字段的 `ParameterInvalid`、每一个反复出现的 PASS 模式，都是对
`routes.yaml`、索引快照或验真模板的一次修改——由部门走正常 PR 流程提交。这正是本地形态的意义。
