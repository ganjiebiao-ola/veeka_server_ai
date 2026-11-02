# 下游流水线字段对接契约(downstream contract)

[#116](https://github.com/olaola-projects/ai-native-issues/issues/116) 交付物:Spec 输出与
下游代码生成流水线([#7 小游戏](https://github.com/olaola-projects/ai-native-issues/issues/7) /
[#8 活动](https://github.com/olaola-projects/ai-native-issues/issues/8))及
[#6 UI 设计辅助流水线](https://github.com/olaola-projects/ai-native-issues/issues/6)的输入契约。

> **状态:草案 —— 待 #7/#8 owner 确认**(确认记录见文末;确认前下游可按本契约试消费,
> 分歧以确认后的版本为准)。

## 1. 命名映射

#7/#8 票面对四部分的叫法与本 skill 不同,**语义一一对应**,消费时按此映射:

| spec-authoring(#31) | #7/#8 流水线口径 | 文件 |
|---|---|---|
| 产品需求 | 功能需求 | 01-product-requirements.md |
| UI 设计 | UI 设计 | 02-ui-design.md |
| 技术目标 | 技术要求(跨项目可复用) | 03-technical-goals.md |
| 框架约束 | 框架设定(跨项目可复用) | 04-framework-constraints.md |

## 2. 交付形态

- 文件集:01–04 四份 spec + 00 缺口报告(工作件)。**下游只读 01–04,00 不进流水线**
  (残留风险经启动门禁移交,见下)。
- 落点:目标业务仓 `docs/specs/<feature>/`(Phase 0 约定),文件名保留 `00-`…`04-` 前缀,
  互链与机读定位都依赖这个前缀。

## 3. 启动门禁(下游流水线的 Spec 入口条件)

- 四份 spec 元信息状态 = **够驱动生成**(qa-loop.md 的 D1–D4 全部通过 + 需求 owner 确认;
  未达门禁的 spec 不得进入下游生成)。
- **残留 CL 的传递**:D4 允许残留的 P2/P3 未决项,以 00 报告 §6「残留 CL 风险清单」形式随
  移交摘要交给下游 —— 下游生成对这些点**按清单的默认处理执行(留 TODO / 按 MAY 跳过),
  禁止脑补补全**。
- 04 §7 硬性红线表 = 下游生成的 Constitution Check 门禁输入,生成前逐条校验、合并前复检。

## 4. 逐部分字段契约(#7/#8 消费什么)

- **01 功能需求**:§2 P1–P3 用户故事(任务拆解的优先级顺序)、§3 FR-###(RFC 2119 情态 =
  生成范围与强制程度)、§4 `### Requirement:` + `#### Scenario:`(测试用例生成源)、
  §5 Given-When-Then(验收测试,回链 FR)、§6 非目标(生成的负约束,防扩 scope)。
- **02 UI 设计**:§1 信息架构 + §2 屏幕状态机(页面/场景骨架生成)、§3.1 事件反馈表
  (交互代码生成)、§4 风格 token 表(theme 系统输入)、§5 切图清单 + §5.1 对接字段
  (资产装配,见第 5 节)。
- **03 技术要求**:§1 性能预算、§4 测试策略(TDD 门槛)、§5 缓存规则、§6 接口契约与
  数据模型(服务端对接)、§7 状态管理与错误降级。**跨项目可复用块 = §1–§5**:复刻/活动
  项目间整块复用,复用时逐条确认适用性。
- **04 框架设定**:§1 目标引擎与版本(生成目标)、§3 infra 简化部件、§4 主后端调用约定、
  §5 公共能力复用(认证/支付/防资损/监控告警)、§7 硬性红线。**跨项目可复用块 = §2–§5**。

## 5. #6 UI 流水线对接点(双向)

- **上游(#6 → spec-authoring)**:#6 第 2 步(大模型分析录屏)产出的**游戏需求文档**是
  Phase 0 原始资料的标准来源之一;#6 的需求文档模板定稿后,其字段到四部分模板的映射在
  本节补一张对照表。
- **下游(spec → #6 资产消费)**:02 §5.1 的对接字段,机读契约如下:

| 对接字段 | 取值 | 说明 |
|---|---|---|
| figma-source | Figma 文件链接/ID,或「无」 | #6 第 3 步产出的 layout/切图源文件 |
| layout-export-target | cocos / unity / phaser / h5 | #6 第 4 步导出目标框架;**必须与 04 §1 目标引擎一致**,不一致按 gap-rules 的「不自洽」处理 |
| asset-naming | 命名约定字符串(如 `<screen>-<element>-<state>`) | 切图资产命名契约,02 §5 清单表逐条遵循,须可被流水线机读 |
| theme-tokens-source | 02 §4 token 表 / Figma styles 引用 | #6 第 5–6 步风格迁移与 theme 系统的输入 |

## 6. 契约演进与确认记录

- 契约变更走本仓 PR;对接字段增删须同步 `02-ui-design.md` §5.1、`coverage-map.md` 锚点与
  `regression/smoke.sh` 下限(联动规则见 coverage-map 头部)。
- 确认记录(验收:契约经 #7/#8 owner 确认,下游可直接消费 Spec 字段):

| 流水线 | owner(GitHub) | 确认时间 | 结论 |
|---|---|---|---|
| #7 小游戏 | weilson-ola | 待确认 | — |
| #8 活动 | julianleon-byte | 待确认 | — |
| #6 UI | ericzhang-pom(与本票同 assignee) | 随本契约合并对齐 | 双向对接点如第 5 节 |
