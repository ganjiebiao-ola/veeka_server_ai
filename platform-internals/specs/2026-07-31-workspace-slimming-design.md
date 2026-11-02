# Workspace 模板瘦身设计(两层分离)

- 日期:2026-07-31
- 状态:**已实施**(#93,2026-08-04)。本文件是实施依据的留档;与实施的偏差记在文末。
- 关联:修订 #41(目录结构规范),父票 #28;不改变 #48/#49/#50/#44 的能力,只改呈现与落点

> **历史设计文档。** 下文中的路径描述的是 #93 瘦身**之前**的目录布局(如 `instructions/`、
> `framework/`、`rules/README.md`、`runs/README.md`),在当前仓库中多数已不存在。按史料阅读,
> 不要当作现状路径引用。

## 背景与问题

模板仓当前顶层 17 个可见条目、全仓 53 个 md。其中大量内容是框架**自证/自测**产物
(golden 样例包、健康检查夹具、九类资产示例、机器读 schema),与"使用模板的团队"
第一眼要做的事无关,造成上手认知负担。

## 目标与验收标准

两类人的体验同时改善:

1. **消费者(从模板创建 workspace 的团队)**:顶层可见条目 17 → 12(4 文件 + 8 目录);
   消费者视野内 md 53 → 约 20;新团队**必读仅 2 个**(README +
   `instructions/mount-points.md`)即可开工。
2. **维护者**:自证内容集中在单一 `framework/` 目录,边界清晰;所有既有验证链路
   (`ws validate` / `ws health --self-test` / `ws golden campaign-validator` /
   `check-asset-metadata`)迁移后全绿。

## 关键决策(已与 owner 确认)

- 目标人群:消费者与维护者**两者都要**。
- 力度:**允许真删/合并**(不只是视觉分层),同步改脚本与票据。
- 判据:目录减少 + 阅读路径变短**同时做**。
- 载体:**先收尾 #44 合并**,再在 ai-native-issues 新开瘦身票,从 main 拉新分支实施。
- 方案:**A(两层分离)**——自证内容收进 `framework/`,不移出主仓(方案 B 跨仓成本高、
  #44 刚落地就搬家时机不佳,弃)。

## 目标顶层结构(17 → 12)

```
README.md            重做:极短上手路径
CLAUDE.md            保留(imports 不变)
AGENTS.md            保留(Codex 入口,同步 signpost)
workspace.yaml       保留
instructions/        保留,内部精简
rules/               保留,内部精简
context/             保留(消费者日常信任源)
repos/               挂载点
skills/              挂载点
knowledge/           挂载点
scripts/             保留(ws 执行接口)
framework/           新增:唯一的框架自证层
```

消失的顶层条目:`golden/`、`tests/`、`schemas/`、`examples/`、`suites/`、`runs/`。
`runs/` 改由脚本运行时自动创建(本就 gitignore);`suites/` 待首个真实 suite 挂载
(#43 出货)再回顶层。`.golden-origin/` 本就是隐藏目录,不动。

## framework/ 内部布局

```
framework/
  README.md              3 行:框架自证层,平台维护,使用者无需阅读
  golden/                原 golden/(#44 样例包全量)
  tests/                 原 tests/health-fixtures/(#50 自测夹具)
  schemas/               原 schemas/
  examples/              原 examples/(#48 九类示例,九类全保留)
  suites/                原 suites/(SUITE 契约 + campaign-stub)
  golden-sample-pack.md  原 instructions/golden-sample-pack.md(纯自证规范)
  runs-format.md         原 runs/README.md(运行记录格式说明)
```

脚本改动(机械性路径替换):`ws`、`check-workspace`、`check-health`、
`check-asset-metadata`、`check-golden-pack`、`check-context-freshness` 中指向
`schemas/`、`tests/`、`examples/`、`golden/` 的路径统一加 `framework/` 前缀。

## 碎 md 合并清单

| 动作 | 文件 | 去处 |
|---|---|---|
| 合并 | `repos/README.md` + `skills/README.md` + `knowledge/README.md` | 合成 `instructions/mount-points.md`;三个挂载点各留 3 行指路 README(保目录存在) |
| 并入 | `rules/README.md` | 并入 `rules/team-rules.md` |
| 删除 | `instructions/README.md` | 内容并入根 README 目录表 |
| 不动 | `team-context/README.md`、`team-context/freshness-log.md` | 消费者日常触点 |
| 随目录移动 | `golden/`、`examples/`、`tests/`、`suites/` 各自 README | 进 `framework/` 原样保留 |

## 入口重做

- **README**:第一屏 = 三句话说清这是什么 + 4 步 Quick start + 一句
  「只需读 README 和 `instructions/mount-points.md`,其余按需」;目录表缩成
  使用面 10 行 + framework/ 一行。
- **CLAUDE.md / AGENTS.md**:imports(security-defaults、team-rules)不变;
  signpost 路径更新(golden-sample-pack.md、schemas 等新落点)。AGENTS.md 为
  内联式,需同步等价修改。

## 验证闭环(实施完成的硬条件)

1. `scripts/ws validate` 绿
2. `scripts/ws health --self-test` 绿(夹具新路径)
3. `scripts/ws golden campaign-validator` 绿(#44 九阶段 replay)
4. `scripts/check-asset-metadata` 绿(examples 新路径)
5. 全仓 grep 无指向旧路径的死链(md 互链 + 脚本)

## 追溯与实施安排

1. 先收尾 #44:当前 feat/44 分支未提交改动提交、PR 合并。
2. 在 ai-native-issues 新开瘦身票,挂 #28 下,正文注明「修订 #41 目录规范」。
3. 从 main 拉新分支(如 `feat/<新票号>-workspace-slimming`),单独 PR。
4. 本 spec 文档随瘦身分支一起提交(不混入 #44 的 PR)。

## 不做的事(YAGNI)

- 不把自证内容移出主仓(方案 B)。
- 不删减 examples 九类中的任何一类(#48 检查器逐类校验)。
- 不改 `ws` 子命令语义、不动 harness 审批机制、不动安全默认。

## 实施记录(2026-08-04,#93)

实测结果:顶层可见条目 17 → **12**,消费者视野 md 53 → **20**,全仓 md 53 → 51。
六项验证全绿:`ws validate` / `ws health`(6 项)/ `ws health --self-test`(6/6)/ `ws test` /
`ws regression` / `ws golden campaign-validator`(删掉 `.golden-origin/` 与 `repos/campaign-validator/`
后从零跑完九阶段)。

与本设计的三处偏差,都是实施时才暴露的:

1. **本 spec 自己的落点**。设计写"随瘦身分支一起提交",但没说放哪;放顶层 `docs/` 会让顶层变成
   13 项,与本设计的首要验收标准冲突。改放 `framework/specs/`——它本就是维护者材料,消费者无需阅读。
2. **`suites/` 是两处而非一处**。设计只说 `suites/` 收进 `framework/`。但 `agent_suites` 注册的
   真实 suite 仍应挂顶层 `suites/`,若 `ws test` 只遍历 `framework/suites/*/test`,首个真实 suite
   挂载后会**静默不被测试**。实施改为 `_suite_tests()` 同时遍历两处,`framework/suites/README.md`
   开头声明这个两层关系。
3. **`x_required_paths` 用 `framework/` 替换 `suites/`**,而不是改成 `framework/suites/`。理由:
   要求存在的应是自证层本身——没有夹具,健康检查就只是声明而非已证行为。这也让交接后删除样例包
   (checklist 的既定动作)不会让 `ws validate` 变红。

## 追记(2026-08-05):`framework/` 更名为 `platform-internals/`

"framework" 与全仓术语 **framework-tracked**(指由工作区版本管理的可信文件,如 `team-context/`
——并不在本目录下)撞名,且新人易把它误当成"必读的框架本体"。更名后目录名自答"平台维护的
内部层,使用者无需阅读";术语 framework-tracked 不再与任何目录同名,原义不变。改动为机械路径
替换(脚本 + 文档 + schema `$id` + `x_required_paths`);本文正文保留实施当时的 `framework/`
路径不改写,以存其真。正文中同批更名前的其他旧名(如 `instructions/`、`context/`、
`rules/README.md`、`runs/README.md`)同理保留原文,不逐一改写。
