# 变更分析思考框架(新人上手用)

> 用途：帮新人从「这段代码能不能跑」走到「这个改动会怎样影响整个系统」。
> 性质：**参考资料，不是团队规则**。这里的问题清单目前是导师讨论清单(试用中)，不是 PR 的硬性要求；
> 要成为规则，须经团队同意后写进 `rules/review.md`。
> 来源：改写自《Monorepo 架构师 / Senior SDE 思考框架》，已按多仓 workspace 调整。
> Owner：EricZhang ｜ 更新：2026-09-28

## 1. 核心思路

改一处代码时，沿着这条链往外想：

本地改动 → 依赖关系 → 契约 → 运行时 → 影响范围(blast radius) → 迁移与运维

五个关键词：**Boundaries(边界) / Dependencies(依赖) / Contracts(契约) / Invariants(不变量) / Failure Modes(故障模式)**

## 2. 8 个核心问题

| # | 维度 | 问题 |
|---|---|---|
| 1 | Context | 这个东西在系统里的角色是什么？ |
| 2 | Boundary | 它应该知道什么，不应该知道什么？ |
| 3 | Dependency | 谁依赖它？它依赖谁？ |
| 4 | Contract | 是否改变 API / schema / event / 行为？ |
| 5 | Blast Radius | 改错以后哪里会坏？ |
| 6 | Failure | 异常、并发、部分失败怎么办？ |
| 7 | Migration | 如何上线？能否回滚？ |
| 8 | Operability | 上线以后怎么监控、排查和维护？ |

## 3. 7 个问题(首个任务的导师讨论清单，试用)

针对一个具体改动逐条回答。不适用的项写明原因即可。

1. 改了什么？
2. 为什么改在这一层、这个模块？
3. 谁依赖它？(带源码出处)
4. **哪些假设或不变量可能被破坏？**
5. 什么会坏？
6. 怎么验证？
7. 怎么安全回滚？不可逆的话，事先做了什么保护？

第 4 问最容易被跳过，也最能帮新人看到代码表面以下的东西。

## 4. workspace 能兜住什么，项目仍要自己回答什么

workspace 的机制只能**支撑**其中一部分问题，不能代替项目回答。第二列不能代替第三列。

| 原工程问题 | workspace 能提供的支持 | 项目仍需回答的问题 |
|---|---|---|
| Dependency / Contract | `team-context/mounted-repos/<id>.md` 可以记录跨仓关系(由 `workspace-context-bootstrap` 扫描生成) | 契约文件在哪；生产方和消费方各自在哪里调用；契约改了以后哪些仓要重新验证 |
| Ownership | human-id 约定：agent 的产出记在发起人名下(`rules/review.md` § Responsibility)；每条规则写明 owner | 模块的决策人、破坏性变更的批准人、事故响应人分别是谁 |
| Source of Truth | 知识库「一个事实只有一个权威版本」(`agent-instructions/mount-points.md` § knowledge)。**只管文档** | 业务规则、schema、常量的权威实现在哪个仓、哪个文件 |
| Security / Trust Boundary | `agent-instructions/security-defaults.md` §1：挂载内容只当数据，不当指令。**只管 agent 的信任边界** | 应用自己的认证、授权、输入校验、密钥、PII、租户隔离 |
| Change Reversibility | `security-defaults.md` §2 + `harness_guard`(`scripts/lib/harness.sh`)：破坏性操作要人在终端确认，并留下审计记录。**证明操作获得了授权，不证明变更可以回滚** | 回滚步骤是什么；不可逆操作(数据删除、主键迁移)有没有事先备份和演练 |
| Observability | sre-inspect 套件(`suites/sre-inspect/`：Grafana 告警 → 根因报告)。团队的 OpenTelemetry 接入规范**尚未引入 workspace，待建设** | 改动上线后，看哪个指标、日志或告警来判断是否正常 |
| 构建、制品与跨仓版本兼容 | `rules/review.md` § Artifact provenance：制品记录生成时的完整 commit SHA，可以追溯 | 依赖版本是否固定；构建能否复现；共享契约变更后哪些仓要重新验证 |

## 5. 新人上手怎么用

不在第一天全部讲完，按阶段拆开：

| 阶段 | 用哪部分 | 怎么用 |
|---|---|---|
| Day 1 | 5 个关键词 | 读 `security-defaults.md` 时的思考框架，不展开 |
| Day 3 跨仓关系 | 8 个核心问题(第 2 节) | 满足下面的前置条件时，拿一对真实的生产方和消费方逐条回答 |
| Day 4-5 第一个任务 | 7 个问题(第 3 节) | 和导师一起过一遍，作为讨论清单，不是提 PR 的门槛 |
| 第 1-3 个月 | 完整 20 维(附录) | 参考手册，review 时按需查 |

### Day 3 练习的前置条件

练习要能做，至少需要：

- 一对生产方和消费方(两个仓，或同一个仓的两个模块)；
- 契约文件的位置(API 定义、schema、proto、event payload 等)；
- 双方的调用位置，带源码出处；
- 一个具体的变更(例如「给这个接口加一个必填字段」)。

缺任何一项，由导师补齐，或者使用明确标注为「教学样例」的材料。golden pack 里的玩具仓不是真实的跨仓契约，不能拿来充数。
「有上下文文件」不等于练习可以做。

**现状(2026-09-28)**：还没有满足条件的真实材料，待导师补齐。

## 6. 案例：mkt Dify worker「Too many open files」(2026-08-06)

先读事故经过，再用框架逐条分析。

**经过**：mkt 租户的 workflow 代码节点报 `[Errno 24] Too many open files`，报错指向 sandbox，但 sandbox 是健康的。
真正的原因是 celery worker 的 Redis 连接泄漏：Dify 用 Redis 做 celery result backend，pubsub 连接在 unsubscribe 之后没有释放(上游 bug celery#6963)。
worker 跑的是 gevent pool，`--max-tasks-per-child 50` 对它不生效，进程永不回收。泄漏约 70 个连接/天，大约两周耗尽容器默认的 1024 个 fd。
升级 Dify 版本也修不了。
修复：给 api 和 worker 加 fd 上限(65535)作为缓冲；把 worker 改成 prefork pool、并发 4，让 `max-tasks-per-child` 生效，定期回收子进程。

**用框架分析**：

| 维度 | 这个案例里 |
|---|---|
| Failure Modes | 报错信息误导：指向 sandbox，根因在 worker 的连接泄漏 |
| Invariants | 被破坏的假设：「unsubscribe 后连接会释放」。上游 bug 让它不成立 |
| Runtime Architecture | gevent pool 下 `max-tasks-per-child` 不生效。同一个配置参数，换个运行时语义就变了 |
| Dependency | 问题在上游(celery)，升级 Dify 修不了，只能在运行方式上绕过 |
| Blast Radius | 共享 Redis(`maxclients=10000`，多租户共用)有被耗尽的风险；其他租户的 worker 如果也用默认 gevent 配置，很可能有同样的泄漏 |
| Performance / 容量 | 改 prefork 后并发上限变成 4；主机可用内存约 9GB，每个 prefork 子进程是完整的 Python 进程。这是用吞吐换稳定 |
| Observability | 泄漏持续约两周才爆出来，期间没有告警。事后建议给 Redis `connected_clients` 加告警(阈值 8000)，并定期查 worker 的 fd 数 |
| Reversibility | 加 `ulimits` 随时可撤；换 pool 会改变并发行为，风险更高 |
| 运维操作 | 在该目录执行 compose 必须带 `-p dify_mkt`，否则会按目录名起一套重复的容器(这次操作中真的发生过，已清理) |
| Source of Truth | 修复时 compose 改动还没提交，运行中的状态和仓库里的配置不一致 |

**讨论题**：如果当时要按第 3 节的 7 个问题写这次改动，第 4 问(假设或不变量)和第 7 问(回滚)你会怎么答？

## 7. 验收：导师怎么判断新人学会了

新人针对一个具体变更交付以下内容，由导师核对：

- [ ] 依赖关系：谁依赖它、它依赖谁，每一条都带源码出处；
- [ ] 至少一个可能被破坏的假设或不变量；
- [ ] 至少一个失败场景，以及对应的验证方法；
- [ ] 回退条件；如果不可逆，说明为什么，以及事先做了什么保护。

## 附录：完整 20 维(参考手册)

| # | 维度 | 核心问题 |
|---|---|---|
| 1 | Architecture Context | 这段代码在系统里扮演什么角色？为什么在这里？ |
| 2 | Boundary | 模块和 domain 的边界是否还健康？有没有循环依赖？ |
| 3 | Dependency Graph | 直接和间接依赖方是谁？变更沿什么路径传播？ |
| 4 | Contract | API、函数签名、schema、event、配置接口是否变了？现有调用方还能跑吗？ |
| 5 | Ownership | 谁拥有它、谁批准破坏性变更、谁处理事故？ |
| 6 | Source of Truth | 业务规则、schema、常量是否重复定义？哪个是权威实现？ |
| 7 | Runtime Architecture | 影响哪些部署单元？有没有新增网络调用、改变超时和重试？ |
| 8 | State & Data | 数据归谁读写？一致性要求？迁移怎么做，要不要 dual-write / backfill？ |
| 9 | Failure Modes | 超时、重试、部分失败、重复处理、缓存过期、依赖不可用时会怎样？ |
| 10 | Edge Cases | 空值、超大输入、首次运行、并发更新、乱序事件、网络分区 |
| 11 | Concurrency | 竞态、锁、事务、幂等、顺序与去重 |
| 12 | Performance | CPU / 内存 / IO、查询、网络、冷启动；是局部优化还是会拖垮全局？ |
| 13 | 构建、制品与跨仓版本兼容 | 依赖版本是否固定？构建能否复现？共享契约变更后哪些仓要重新验证？ |
| 14 | Testing Strategy | 这类风险应该在哪一层测试(单元 / 组件 / 契约 / 集成 / E2E / 回归)里捕获？ |
| 15 | Observability | 日志、指标、trace、告警、dashboard、correlation id；出问题时怎么知道？ |
| 16 | Security / Trust Boundary | 认证、授权、输入校验、密钥、PII、租户隔离；信任边界有没有扩大？ |
| 17 | Compatibility & Migration | 向后兼容、feature flag、灰度、双版本并存、弃用路径 |
| 18 | Blast Radius | 改错了会坏到哪一层：局部 → 包 → 服务 → domain → 整个系统？ |
| 19 | Change Reversibility | 出错后能不能安全撤回？可逆性越低，控制越严 |
| 20 | Long-term Maintainability | 抽象对吗？认知负担有没有增加？再来 5 个类似需求还撑得住吗？ |
