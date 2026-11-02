# 对 OpenSpec / spec-kit 的复用边界

[#118](https://github.com/olaola-projects/ai-native-issues/issues/118) 交付物之一:本 skill
基于两个开源 SDD 项目的素材搭建,此文档明确**复用什么、不复用什么、为什么**。两个上游均为
MIT License;我们借用的是**格式约定与结构思想**,不拷贝其代码或工具链。

上游(调研时点 2026-08-17,结论以下列 commit 为基准;上游后续演进不自动影响本文档):
- [github/spec-kit](https://github.com/github/spec-kit) @ `bf88c9f` — Spec-Driven Development 工具包
  (`/speckit.specify → plan → tasks → implement` 命令链 + 模板);对照物:
  [spec-template.md](https://github.com/github/spec-kit/blob/bf88c9f9a82fa370c7a7257aa2b3cf10b457b65c/templates/spec-template.md)
- [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) @ `2826b88` — 轻量 SDD 工作流
  (`specs/`(当前真相)与 `changes/`(变更提案)分离 + delta 归档);对照物:
  [concepts.md](https://github.com/Fission-AI/OpenSpec/blob/2826b8889e5223a9a8095d4428b60b56597e1020/docs/concepts.md)

## 复用清单

| 借自 | 素材 | 落点 |
|---|---|---|
| spec-kit spec-template | P1–P3 优先级用户故事分层 | 01 模板 §2 |
| spec-kit spec-template | FR-### / SC-### 编号体系(需求可回链、成功指标技术无关) | 01 模板 §1/§3 |
| spec-kit spec-template | Given-When-Then 验收场景 | 01 模板 §4/§5 |
| spec-kit spec-template | `[NEEDS CLARIFICATION: …]` 歧义标记(禁止靠猜测填充) | 全部四份模板 + SKILL.md 硬规则 |
| spec-kit plan-template | Constitution Check「先校验后动工」门禁模式 | 04 模板 §7 硬性红线表 + 合并前门禁 |
| OpenSpec | `### Requirement:` + `#### Scenario:` 结构(需求即可测场景) | 01 模板 §4 |
| OpenSpec | RFC 2119 措辞规范(SHALL/MUST/SHOULD/MAY) | 01 模板 §3、04 模板约束措辞 |
| spec-kit `/speckit.clarify` | 缺口分类扫描与限量问询的流程思想(按影响排序、限量提问、回答即时写回;只借思想,不引其命令链) | references/gap-rules.md(S2 #114)、references/qa-loop.md(S3 #115) |

## 不复用清单

| 上游部件 | 不复用的理由 |
|---|---|
| spec-kit 的 `specify` CLI 安装器与多 agent 分发 | 本 workspace 的 skill 经 `skills/` 挂载点零安装发现,不需要独立安装链路 |
| spec-kit 的 tasks → implement 执行链 | 本 skill 只做「原始资料 → 四部分 Spec」的抬升;任务拆解与实现属下游代码生成流水线(#7/#8),字段对接在 S4(#116) |
| spec-kit 的 constitution 全套项目原则体系 | 我们只借其门禁**模式**;团队工程规则已有权威落点(`rules/`),不再造一份 constitution |
| OpenSpec 的 `changes/` 提案与 delta 归档机器(ADDED/MODIFIED/REMOVED) | 本票场景是**首版 Spec 起草**,没有存量 spec 需要增量演进;若日后模板沉淀出「Spec 变更流程」,可再评估借入(留给 S5 #117 之后) |
| OpenSpec 的 `openspec` CLI 与目录约定 | 同上,Spec 的落点由本 skill 约定(目标业务仓 `docs/specs/`),不引入第二套目录体系 |

## 需自研的部分(上游空白)

- **UI 设计规格**(02 模板整份):屏幕状态机、动效关键帧与时序、切图资产清单、多设备适配
  —— 两个上游都没有 UI 规格层;这部分对接 #6 UI 设计辅助流水线,是本 skill 的差异化价值。
- **框架约束/硬性红线**(04 模板整份):引擎选型、infra 简化部件白名单、主后端调用约定、
  公共能力复用(认证/支付/防资损/监控告警)、禁改公共接口/禁增依赖等红线 —— spec-kit 的
  constitution 只有「项目原则」抽象,没有游戏/活动业务所需的硬约束清单结构。

## 许可证说明

spec-kit 与 OpenSpec 均为 MIT License。本 skill 借用的是章节结构、编号约定与措辞规范等
**方法层素材**,未复制两者的模板文本、代码或工具;如日后直接引入其模板文本片段,需在该
文件头部保留上游版权声明。
