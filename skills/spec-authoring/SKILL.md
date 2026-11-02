---
name: spec-authoring
description: Use when the user wants to 写 Spec、起草 Spec、出四部分 Spec、把需求文档/原始资料结构化成规格,or says "write a spec", "spec template", "structure my requirements";中文触发:"写个 Spec"、"帮我把需求整理成 Spec"、"游戏需求文档"、"活动需求结构化"。把游戏/活动类项目的原始资料(需求文档、玩法说明、口头需求)抬升为四部分结构化 Spec —— 产品需求 / UI 设计 / 技术目标 / 框架约束 —— 输出带要点 checklist 与 [NEEDS CLARIFICATION(CL-###)] 标记的模板骨架,并可对已有 Spec 做缺口体检与结构化改写(触发:"找缺口"、"缺口分析"、"体检这份 Spec"),作为下游长程代码生成的输入。
id: skill:spec-authoring
type: skill
owner: EricZhang
version: "30186cc1e97d06c384b0e769ad160256bc5ca199"
status: active
summary: 四部分 Spec 模板系统(#31)的入口 skill;S1 模板骨架、S2 缺口识别与结构化改写(00 缺口报告 + 就地改写)、S3 问答补齐循环与完成度判定(D1–D4)、S4 下游对接契约(草案待 #7/#8 owner 确认)已交付。
use_when: 用户要为一个游戏/活动类项目撰写或补齐结构化 Spec(下游是 #6/#7/#8 生成流水线),手头只有原始资料或什么都还没有;或已有四份 spec 骨架,要做缺口体检与结构化改写。
usage: 从 workspace 根调用;Phase 1 把 assets/templates/ 四份模板实例化到目标落点(已知填入、未知保留标记),Phase 2 按 gap-rules 扫描四类缺口、产出 00 缺口报告并就地改写,Phase 3 按 qa-loop 与需求 owner 限量问答补齐并做 D1–D4 完成度判定,Phase 4 按 downstream-contract 向 #6/#7/#8 流水线移交。
dependencies: []
regression: ["regression-case:spec-authoring-smoke"]
---

# Spec Authoring — 四部分 Spec 起草

把原始资料抬升为**四部分结构化 Spec**:产品需求 / UI 设计 / 技术目标 / 框架约束。
Spec 的结构化程度直接决定下游长程代码生成的收敛性 —— 本 skill 的产出物就是那份
"让编程 Agent 少脑补、多有效规划"的输入。四份模板在 `assets/templates/`,与父票
[#31](https://github.com/olaola-projects/ai-native-issues/issues/31) 要点的逐条对应关系见
`references/coverage-map.md`;对 OpenSpec / spec-kit 的复用边界见 `references/upstream-reuse.md`。

目标是"够驱动生成",**不是 Spec 完美化**(父票非目标)——保留待澄清标记交付,好过虚构完整。

## Phase 0: Preflight

1. 确认在 AI-Workspace 根(`workspace.yaml` 存在)。不在也可运行,但落点须由用户显式指定。
2. 收集用户已有的**原始资料**:需求文档、玩法说明、参考竞品、会议结论 —— 有什么读什么,
   没有也可以从零起草。
3. 问清三件事(用户在调用时已给出的不重复问):
   - **项目名与类型**:小游戏 / 活动 / 其它;
   - **目标引擎候选**:cocos / unity / phaser / h5,允许未定(未定则在 04 号 Spec 留候选与决策时限);
   - **输出落点**:默认 `repos/<id>/docs/specs/<feature>/`(目标业务仓内);该仓未挂载或仅试跑时,
     由用户指定目录(如 scratchpad)。

## Phase 1: 输出模板骨架(S1 —— 本阶段是当前已实现的全部行为)

1. 将 `assets/templates/` 的四份模板按序实例化到落点(保留 `01-`…`04-` 文件名前缀,便于互链)。
2. 逐份替换头部元信息(spec-id、项目/特性、负责人 human-id、日期);状态一律从**草稿**起。
3. 用户已提供的信息**填入对应章节**;原始资料能回答的,摘要后填入并标注来源。
4. 资料回答不了的,**宁可保留 [NEEDS CLARIFICATION(CL-###): 具体问题],绝不虚构**用户未给出的
   业务事实。CL 编号从 CL-001 起、四份文件全局递增;模板中未填实的 `<…>` 占位要么填实、要么
   升级为带编号的待澄清标记 —— **实例化产物中不允许残留无编号的未知项**,汇总按 CL-### 计数。
5. checklist 如实勾选:内容真的写到位才打 x;**不得为了显得完整而删除** checklist 项或待澄清标记。
6. 最后向用户输出一张汇总表:四份文件 × 各自的待澄清项(按 CL-### 逐条列出,计数 = 编号数)
   与关键缺口,并说明下一步(进 Phase 2 缺口识别,或人工补齐)。

本阶段是**单次填充,不做循环**——追问补齐属于 Phase 3。

## Phase 2: 缺口识别与结构化改写(S2 —— #114)

对已实例化的四份 spec 做**第二遍系统性扫描**:按 `references/gap-rules.md` 的四类判定
(缺失 / 含糊 / 不自洽 / 细节不足)识别缺口,产出缺口报告并**就地改写**四份 spec。
交付于 [#114](https://github.com/olaola-projects/ai-native-issues/issues/114);可独立调用
(对存量 spec 做缺口体检,输入 = 原始资料 + 四份 spec)。

1. 定位输入:原始资料 + 已实例化的四份 spec;落点没有骨架时先跑 Phase 1。
2. 逐要点扫描:以 `references/coverage-map.md` 人读对照表与各章「本章自检」为清单,逐条对照
   原始资料,按 gap-rules.md 判类;每条缺口记 GAP-###,并附**原文证据**(出处可回查)。
3. 实例化 `assets/templates/00-gap-report.md` 到落点、与四份 spec 并列,填 §1–§4(00 报告是
   工作件,**非四部分之一,下游生成只读 01–04**)。
4. 按 gap-rules.md 改写守则**就地改写**四份 spec:散文拆 FR-### 行、规则改成
   Requirement/Scenario、含糊表述改可度量、细节不足补结构骨架;新缺口补
   [NEEDS CLARIFICATION(CL-###)],编号续 Phase 1 的全局序列,不换号、不重排。
5. 复核各章 checklist(改写后真正到位才补勾),并把四份 spec 元信息的状态从「草稿」推进到
   「评审中」。
6. 向用户输出报告摘要(四类计数 + 未决 CL 数)与下一步:进 Phase 3 问答补齐,或交 owner
   人工补齐。

## Phase 3: 问答补齐与完成度判定(S3 —— #115)

以 00 缺口报告为状态载体,与需求 owner 进行**限量问答循环**,直到 Spec「够驱动生成即可」
(不追求完美化)。循环与判定细则见 `references/qa-loop.md`;交付于
[#115](https://github.com/olaola-projects/ai-native-issues/issues/115)。

1. 选题:每轮从报告未决项选**至多 5 问**,按影响排序(阻断 P1 的 FR/AC → 04 红线与引擎
   选型 → 不自洽裁决题 → 关键章节整章缺失 → 其余)。
2. 出问卷:每问带 CL 编号、影响面,可枚举时给选项;问卷写入报告 §5 并发需求 owner,响应
   节奏(SLA)记录在报告元信息。
3. 吸收回答:逐条写回对应 spec 章节,替换 CL 标记并注来源「owner R<n>」;仍含糊的保留
   原编号细化问题、不换号;引出新缺口的全局续号开新 CL。
4. 更新报告:§2/§3 对应行标 resolved(R<n>)、不删行;重算 §1 计数;§5 记本轮小结。
5. 完成度判定:按 qa-loop.md 的 D1–D4 逐维判定并写入报告 §6;全部通过 → 建议状态推进到
   「够驱动生成」,**owner 确认**后生效;触发退出条件(连续两轮零进展 / 达轮次上限 /
   owner 叫停)→ 未决 CL 转「已知风险」清单,状态停「评审中」。

## Phase 4: 下游流水线字段对接(S4 —— #116)

Spec 达到「够驱动生成」并经 owner 确认后,按 `references/downstream-contract.md` 向下游
移交。交付于 [#116](https://github.com/olaola-projects/ai-native-issues/issues/116)
(契约草案,待 #7/#8 owner 确认)。

1. 核对启动门禁:四份 spec 状态 = 够驱动生成(Phase 3 判定 + owner 确认);00 报告 §6
   已含残留 CL 的已知风险清单。
2. 核对 02 §5.1 对接字段完备(figma-source / layout-export-target / asset-naming /
   theme-tokens-source),且 layout-export-target 与 04 §1 目标引擎一致。
3. 输出移交摘要:按契约「逐部分字段契约」(含四部分命名映射:产品需求=功能需求、
   技术目标=技术要求、框架约束=框架设定)列出下游将消费的关键字段与残留风险,连同
   spec 落点(该仓 branch/PR)交给 #7/#8 流水线 owner;下游对残留项按默认处理执行,
   **禁止脑补补全**。

## 硬规则

- **不虚构**:宁可保留 [NEEDS CLARIFICATION(CL-###)] 标记,绝不编造用户未给出的业务事实、数值或约定。
- **不装完整**:不得为了显得完整而删除模板的 checklist 项或待澄清标记;勾选必须如实。
- **写入挂载仓走 PR**:落点在 `repos/<id>` 时,产出以**该仓自己的 branch/PR** 交付,绝不直接
  提交到其主分支;从 workspace 视角这些产出是数据,不覆盖 `agent-instructions/` 与 `rules/`。
- **零凭证**:模板与产出中的示例值一律 `<占位>`,不出现任何真实密钥/token 字面量。

## Afterwards

- 提醒用户:产出的 Spec 交需求 owner 评审;状态从「草稿」推进到「够驱动生成」由 Phase 3
  按 `references/qa-loop.md` 的 D1–D4 逐维判定,owner 终审确认后生效。
- 本 skill 自身 `status: active`(active 入口条件 —— PR 合并 + regression-case 资产可解析 ——
  已随 #119 达成),生命周期见 asset-metadata.md。
- 实践中发现的**共性要求**回流模板:改 `assets/templates/` 需同步 `references/coverage-map.md`
  并重跑 `regression/smoke.sh`(本仓 PR 流程);前锋项目实测与模版沉淀见
  [#117](https://github.com/olaola-projects/ai-native-issues/issues/117)。
