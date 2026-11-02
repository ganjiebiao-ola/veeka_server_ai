# 父票要点 → 模板章节覆盖映射(coverage map)

本文件是 [#31](https://github.com/olaola-projects/ai-native-issues/issues/31)「四部分构成要点」
到四份模板锚点的**机读映射**,也是 `regression/smoke.sh` 的单一事实源:smoke 逐行解析下方
`check:` 行,在对应模板中 grep 锚点,缺一条即红。

维护规则:
- 改模板章节标题 → 必须同步本文件的锚点,否则 smoke 变红(这是特性,不是 bug);
- 只增不删:父票要点条目一经映射不得移除,新增共性要点时追加 `check:` 行并同步提高
  smoke 中的最小行数下限。

## 人读对照表

| 父票要点(按四部分) | 模板 | 章节 |
|---|---|---|
| 产品需求:目标与价值主张 | 01 | §1(SC-### 成功指标) |
| 产品需求:用户/角色与核心用户故事 | 01 | §2(P1–P3 分层) |
| 产品需求:功能范围与优先级 | 01 | §3(FR-### + RFC 2119) |
| 产品需求:业务规则与状态流程(玩法循环/关卡结构/奖励与配置规则) | 01 | §4(Requirement/Scenario) |
| 产品需求:可验证的验收标准 | 01 | §5(Given-When-Then 回链 FR) |
| 产品需求:非目标与范围边界 | 01 | §6 |
| UI 设计:信息架构 | 02 | §1 |
| UI 设计:屏幕状态机 | 02 | §2 |
| UI 设计:导航与交互规格(事件、反馈、动效关键帧与时序) | 02 | §3 |
| UI 设计:视觉规范(布局、组件、主题/风格 token) | 02 | §4 |
| UI 设计:资源与切图清单 + #6 流水线对接 | 02 | §5 |
| UI 设计:多设备适配 | 02 | §6 |
| 技术目标:非功能需求(性能预算/稳定性/可用性/兼容性) | 03 | §1 |
| 技术目标:基本安全要求 | 03 | §2 |
| 技术目标:监控与可观测性(日志/指标/告警) | 03 | §3 |
| 技术目标:测试驱动开发与高测试覆盖 | 03 | §4 |
| 技术目标:缓存的合理使用规则 | 03 | §5 |
| 技术目标:接口契约与数据模型 | 03 | §6 |
| 技术目标:状态管理与错误/降级策略 | 03 | §7 |
| 技术目标:关键技术选型与权衡 | 03 | §8 |
| 框架约束:目标引擎/框架及版本(cocos/unity/phaser/h5) | 04 | §1 |
| 框架约束:语言与工程规范、代码区约定 | 04 | §2 |
| 框架约束:infra 层简化部件选用 | 04 | §3 |
| 框架约束:对主后端服务的调用约定 | 04 | §4 |
| 框架约束:公共能力复用(认证/支付/防资损/监控告警)与外部 API | 04 | §5 |
| 框架约束:运行/部署形态与数据边界 | 04 | §6 |
| 框架约束:硬性红线(禁改公共接口、禁增依赖等) | 04 | §7(Constitution Check 门禁) |

## 机读校验行

格式:`check: <模板文件名> :: <锚点字符串>`(smoke 在该模板中逐条 grep 锚点)。

check: 01-product-requirements.md :: 目标与价值主张
check: 01-product-requirements.md :: 用户角色
check: 01-product-requirements.md :: 核心用户故事
check: 01-product-requirements.md :: 功能范围
check: 01-product-requirements.md :: 优先级
check: 01-product-requirements.md :: 业务规则
check: 01-product-requirements.md :: 状态流程
check: 01-product-requirements.md :: 玩法循环
check: 01-product-requirements.md :: 关卡结构
check: 01-product-requirements.md :: 奖励与配置规则
check: 01-product-requirements.md :: 验收标准
check: 01-product-requirements.md :: 非目标
check: 01-product-requirements.md :: 范围边界
check: 02-ui-design.md :: 信息架构
check: 02-ui-design.md :: 屏幕状态机
check: 02-ui-design.md :: 导航与交互规格
check: 02-ui-design.md :: 事件
check: 02-ui-design.md :: 反馈
check: 02-ui-design.md :: 动效关键帧
check: 02-ui-design.md :: 时序
check: 02-ui-design.md :: 视觉规范
check: 02-ui-design.md :: 布局
check: 02-ui-design.md :: 组件清单
check: 02-ui-design.md :: 风格 token
check: 02-ui-design.md :: 资源与切图清单
check: 02-ui-design.md :: 切图资产
check: 02-ui-design.md :: 对接字段
check: 02-ui-design.md :: layout-export-target
check: 02-ui-design.md :: 多设备适配
check: 03-technical-goals.md :: 非功能需求
check: 03-technical-goals.md :: 性能预算
check: 03-technical-goals.md :: 稳定性
check: 03-technical-goals.md :: 可用性
check: 03-technical-goals.md :: 兼容性
check: 03-technical-goals.md :: 安全要求
check: 03-technical-goals.md :: 监控与可观测性
check: 03-technical-goals.md :: 日志
check: 03-technical-goals.md :: 指标
check: 03-technical-goals.md :: 告警
check: 03-technical-goals.md :: 测试驱动开发
check: 03-technical-goals.md :: 测试覆盖
check: 03-technical-goals.md :: 缓存规则
check: 03-technical-goals.md :: 接口契约
check: 03-technical-goals.md :: 数据模型
check: 03-technical-goals.md :: 状态管理
check: 03-technical-goals.md :: 降级
check: 03-technical-goals.md :: 技术选型与权衡
check: 04-framework-constraints.md :: 目标引擎
check: 04-framework-constraints.md :: cocos
check: 04-framework-constraints.md :: 版本锁定
check: 04-framework-constraints.md :: 语言与工程规范
check: 04-framework-constraints.md :: 代码区约定
check: 04-framework-constraints.md :: 简化部件
check: 04-framework-constraints.md :: 主后端调用约定
check: 04-framework-constraints.md :: 认证
check: 04-framework-constraints.md :: 支付
check: 04-framework-constraints.md :: 防资损
check: 04-framework-constraints.md :: 监控告警
check: 04-framework-constraints.md :: 外部 API
check: 04-framework-constraints.md :: 部署形态
check: 04-framework-constraints.md :: 数据边界
check: 04-framework-constraints.md :: 硬性红线
check: 04-framework-constraints.md :: 禁改公共接口
check: 04-framework-constraints.md :: 禁增依赖
