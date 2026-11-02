# ADR:本地 token 使用分析的工具选型(#32 T1)

**决定**:混合架构——外部标准 JSON 工具(ccusage)负责基础用量与成本;原生零依赖采集器
负责一切归属分析,并作 fallback 与对账基线;行为下钻按需用轻量本地 dashboard,不引观测平台。
**状态**:已实施(适配层 + 对账见 `scripts/token-usage-report`);评测日期 2026-08-20,工具
版本以当日为准,升级后按同维度复核。

## 评测矩阵(T1:同场真机评测,除标注 desk 外)

| 工具 | License | 五条线索覆盖 | 字段完备性(能否供给关联层) | 复杂度/时延 | opt-in 合规 | 裁决 |
|---|---|---|---|---|---|---|
| **ccusage** v20 | MIT | ①③ + 成本 USD | ✗ 无 cwd/分支/project 维度(v20 已移除 `--instances`,文档滞后);`--by-agent` 可分源 | 显式安装 `ccusage@20`,秒级 | ✓ 按需 | **采用**:基础用量/成本优先源(已落地) |
| **原生采集器** | (本仓) | ②④⑤ + 归属 + Git 关联 | ✓ 全字段:消息级 + cwd + gitBranch + sessionId | 零依赖,~2s | ✓ 按需 | **保留**:归属层唯一数据源 + fallback + 对账基线(非临时件) |
| **OpenUsage** v0.24.4 | MIT | ①③ + quota/statusline/hub | **未能验证**(环境相关):headless(`daily --json`,含 `--offline`)在受限网络下挂起 >5min,开放网络未复验——这是「没测成」,不是「测出不行」 | daemon 中心架构,重 | ✗ **架构性不适配**:常驻采集与「按需 opt-in」红线冲突(与上一格是两个独立理由) | **本轮不采用**为基础用量源(架构判断即已足够);若 statusline/quota 需求成立,先在开放网络复验 headless 再议 |
| **tokscale** | MIT | ①③ + 成本(处理 260ms);`report` 有任务归属 + `--workspace` 过滤 | 部分:月粒度/按 client;report 维度待深挖 | `npx` 即用,快 | ✓ 按需;有 `submit/login` 社交排行平台——**不登录即纯本地,禁止 submit** | **备选源 + S2 参考**:任务归属思路直接借鉴(注意其默认 LLM 总结,用 `--no-summarize` 或端上 apple-fm) |
| **claude-session-dashboard** | MIT | ② 行为:Gantt 代理派发时间线、各步 token、上下文占用 | 读 `~/.claude/projects` JSONL,只读、纯本地 | `npx` 按需起本地 web,轻 | ✓ 按需 | **推荐**为「看得懂」层按需工具(第二层) |
| **agents-observe** | MIT | ② 行为:实时工具流、代理层级(hook 事件) | hook 实时流,非历史扫描 | Docker 常驻 + plugin hook,重 | 半✗ 常驻服务 | **条件推荐**:确需实时行为监控再装,不进默认链路 |

## T2–T5 桌面结论

- **T2 Opik CC Plugin**(Apache-2.0,desk):trace 深度最高(工具调用成 span、subagent
  父子关系,可自托管纯本地),但代价是自托管 Opik 平台 + 常驻 hook。**DEFER**:仅当
  claude-session-dashboard / agents-observe 答不了行为问题时再评(触发条件写实,勿默认引入)。
- **T3 通用观测平台**(逐项,desk,统一维度 = 能答哪些问题 / 复杂度 / opt-in / 缺口):
  - *Phoenix*(ELv2):OTel/OpenInference 埋点 + 自托管服务;能答②行为但要求全量 trace 接入,
    个人本地维护门槛高 → **DEFER**(同 Opik 判据)。
  - *Langfuse*(MIT 核 + ee/ 目录商业):SDK 埋点 + 自托管(DB+服务);对个人本地过重,
    且 ee 边界需逐件核验 → **DEFER**。
  - *OpenLIT*(Apache-2.0):OTel 观测栈,含 GPU/成本;定位偏 #22 的模型观测入口,
    不解个人「理解用法」的题 → **DEFER**(归 #22 语境评)。
  - *AgentOps*(MIT SDK,平台偏 SaaS):SDK 埋点 + 云端倾向,与本机红线不合 → **不采用**。
  - 共同结论:四者全部要求「埋点 + 常驻服务」,违背票面「最小复杂度、直读现有本地记录」
    的第一层原则;只有出现跨月全量 trace 的真实需求时才重开评估。
- **T4 Promptfoo / MLflow**(desk):面向 Prompt/流程实验管理;个人本地「长期优化」现阶段
  没有实验矩阵需求。**DEFER**,出现系统性 A/B 需求再议。
- **T5 LiteLLM / Helicone**(desk):Gateway 在请求关键路径上,本地个人分析完全不需要;
  与可行性报告一致,该维度属 #22(FinOps)。**STOP**。

## 分层组合(最小复杂度优先)

1. **第一层·看得见(默认)**:`scripts/token-usage-report --source auto`
   (= ccusage 基础用量/成本 + 原生归属/Git 关联 + 对账)。
2. **第二层·看得懂(按需)**:`npx claude-session-dashboard` 行为下钻;实时监控需求 →
   agents-observe。
3. **第三层·长期(未启动)**:OTel/OpenInference 标准化采集、实验管理——按 #32 票面属
   长期路线,不在本期承诺。

## 对账基线的价值实证(为什么原生采集器不是临时件)

引入外部基线当天即抓出原生采集两个真 bug:①漏扫 `<session>/subagents/` 子代理转写;
②流式副本 keep-first 少算 output ~14%。修复后 30 天窗口对账:claude 四项 0.00%
(逐字节一致)、codex output 1.00%。没有对照,单一实现的系统性偏差无从发现——对账节
(报告 §⑥)因此是常设机制,不是一次性验证。

## 红线备忘

- **供应链**:外部工具只用操作者显式安装、主版本在已评测范围内的二进制;脚本**绝不
  隐式 `npx` 代下载执行**未锁版本的第三方包(它们读得到本地 session 数据)。
- tokscale:不 `login`、不 `submit`、不开 `autosubmit`;`report` 用 `--no-summarize`
  或确认端上总结模型。
- OpenUsage:如未来为 statusline/quota 引入,daemon 的常驻采集必须先过 opt-in 裁决。
- 任何工具的原始输出不进 git、不外发;报告脱敏契约见 `metrics-guide.md`。
