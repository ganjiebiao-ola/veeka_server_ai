# 指标口径与局限(token-usage-analysis)

`scripts/token-usage-report` 输出中每个数字的定义、归属规则与已知局限。解读(Phase 2)只能
基于这里定义的口径;报告支撑不了的结论要明说,不得引申。

## 数据源与优先级(混合架构)

| 源 | 负责 | 说明 |
|---|---|---|
| **ccusage v20**(外部,`--source auto` 时优先) | 基础用量:总量、日趋势、模型分布、**估算成本 USD**——**只取可关联集 claude+codex**,其余 CLI 进「未归属用量」附录 | 标准 JSON 工具;**只用操作者显式安装的 v20**(`npm i -g ccusage@20`;绝不 `npx` 代下载);不可用/超时/非零退出/JSON 或数值 schema 错误/无 claude 或 codex 分源 → auto 回退原生并注明具体原因,`--source ccusage` 明确失败 |
| **原生采集器**(内置,始终尝试) | 归属分析:bucket×分支、使用模式、Git 关联;以及 fallback 与**对账基线** | 零依赖;外部 JSON 无 cwd/分支/消息级粒度,归属各节永远原生;只有 ccusage 有窗口数据时仍可出基础报告,归属节明确不可用 |

- **对账(报告 §⑥)**:两源重叠口径(Claude 四项 + Codex output)对比,差值 >5% 打数据质量
  红旗——不手工调数,先查两侧口径与目录覆盖。Codex 只对 output:ccusage 的 input 不含
  cached,与原生毛口径不可比。
- 外部原始 JSON 不落报告,只有归一后的聚合进报告(隐私契约不因数据源改变)。

### 原生采集口径

| 源 | 路径 | 粒度 |
|---|---|---|
| Claude Code | `~/.claude/projects/<cwd编码>/**/*.jsonl`(**递归**,含 `<session>/subagents/` 子代理转写) | 每条 assistant 消息(含 usage、model、timestamp、cwd、gitBranch、sessionId) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 相邻 `token_count` 累计值之差按事件时间归属到统计窗;`input` 含 cached(`cached_input` 单列);无分支维度 |
| Qoder | `~/.qoder/projects/<cwd编码>/**/*.jsonl`(格式同 Claude Code) | 每条 assistant 消息的 `usage.credits`(**只有积分,token 恒为 0,model 恒为 `auto`**);同一 `message.id` 多次落盘只计一次;积分不换算为 token,未与账单核对 |

- **去重(keep-max)**:Claude 按 `(requestId, message.id)` 去重;流式写盘会让同一条目多次
  落盘且 **output 逐份增长**(input/cache 在请求开始即定死),取 output 最大的一份——取第
  一份会系统性低估 output(真机实测约 14%)。
- **窗口**:按消息/开场时间的**本地时区日期**过滤;`--until` 含当日。
- **mtime 剪枝**:窗口起点之前未再修改的文件直接跳过(提速);系统时间被回拨过的机器可能漏读,重跑用显式 `--since` 放宽。

## bucket 归属规则

| cwd 形态 | bucket | 标记 |
|---|---|---|
| `<workspace根>/repos/<id>/…` | `<id>`(挂载仓) | — |
| `<workspace根>` 及其他子路径 | `workspace` | — |
| 路径中含 `/repos/<已知 id>/` 的临时 checkout / worktree | `<id>` | `# inferred`(推断,不保证) |
| 其余一切项目 | `other`(匿名归并,只出总量) | `--all-projects` 才点名 |

已知 id 来自 `workspace.yaml repositories[]`。`# inferred` 行参与排名,但基于它的结论必须
带着这个标记说。

## 指标定义

- **cache 命中率** = `cache_read / (input + cache_read + cache_creation)`。低命中率通常意味着
  频繁重开上下文或长会话被打断,是可检查的效率信号。
- **thinking 占 output** = `thinking_tokens / output_tokens`,反映扩展思考的用量占比。
- **每 commit token**(§⑤)= bucket 的 `(input + output) / 窗口内 commit 数`。**粗指标**:
  session 与 commit 不是因果配对(workspace 根的 session 可能产出挂载仓的 commit,反之亦然);
  只用于自己看趋势,**不得用于个人绩效评估**。
- **sidechain** = 子代理消息(`isSidechain`);子代理转写位于 `<session>/subagents/` 子目录,
  已递归扫描计入。
- **session 中位时长** = 同一 sessionId 首末消息间隔的中位数;单消息 session 不计入。

## 任务实例视图(`scripts/token-usage-tasks`,S2.1/#127)

- **自动实例边界** = session 组 + 空闲间隔:同一 session 连续消息归一组,相邻消息超过
  **30 分钟**再切分;同分支的不同 session 或不同空闲段不再合并。`task_instance_id` 由
  bucket/branch、实例起点和 session 的不可逆摘要组成,稳定但不暴露原始 session ID。
- 先按完整 session 记录确定实例边界与 ID,再取报告日期窗内的 token,因此改变历史查询窗口
  不会把 annotation 挂到另一个实例。`other` 仍是一行匿名聚合,不暴露实例。
- **阶段**按 assistant 消息分类,优先级:test > edit > explore > run > agent > other;
  连续相同阶段压缩成序列,`stage_tokens` 是该阶段各消息的 input+output 之和。一条消息含多类
  工具时只进入一个最高优先级阶段,行为计数仍保留全部工具。
- 自动归属零手工可用。`annotate --instance <id>` 只提升置信度;重复 `--instance` 可一次
  标注多个实例,相同且严格为 `#<数字>` 的 issue ref 在报告中合并成一个人工确认任务。
- sqlite (`runs/token-usage/annotations.sqlite`)只存脱敏实例目录(opaque ID/bucket/branch/
  time window)和结构化标签(ref/result/type/first_pass),没有自由文本 note,不存 prompt、工具
  输出、路径、原始 session ID 或用户标识。旧版 `task_key` 行保存在
  `legacy_annotations_v1`,只提示重新绑定,**绝不自动错挂**。
- **行为画像** = tool_use 块按类计数:读(Read/Grep/Glob/Web*/ToolSearch)/ 改(Edit/
  Write)/ 跑(Bash)/ 代理(Agent/Task);`✚test` = 有 Bash 命令命中 test/smoke 等关键词。
- **git 信号** = 实例活动窗(前 30min ~ 后 2h)内该 bucket 仓的 commit 数与 Revert 数;
  现存分支按分支精确取,已删分支回落全分支并标「(全分支)」。**时间窗推断,非因果**。
- **置信度**:标注(有 outcome 标签)> 推断(worktree 归属或有 git 信号)> 低(仅自动)。
- 红线:每行是可核验关联记录,**不是评价**;禁止用于个人绩效。Codex 无分支/消息级数据,
  不进本视图。

## 五条线索 → 报告节映射

| 线索(#32) | 报告节 | v1 覆盖 |
|---|---|---|
| 消耗速度 | §①(总量、日趋势、cache 命中率、thinking 占比) | ✅ |
| 任务热点 | §②(bucket × 分支排行)+任务实例视图(session/空闲切分) | ✅ 自动实例;issue ref 可人工合并 |
| 模型选用 | §③(模型分布) | ✅ |
| 使用模式 | §④(时段直方图、session、sidechain)+实例阶段/token | ✅ |
| 效果感知 | §⑤(每 commit token,粗)+ 实例视图(git 信号/Revert/outcome 标注) | 基础版;同文件反复改的深度返工分析 = 后续 |

## 局限与红线

- Codex 无消息级数据,按累计计数器的事件增量统计。读取窗口前的计数作为基线,旧文件恢复使用也会计入;
  相同计数器快照不重复计数,总计数回落按重置后的新一段处理。无时间戳的计数只更新基线,不猜测其日期。
  时区取声明的 `TZ`;同一会话可在多周各计 1 个活跃 session,周 session 数不能相加当作去重会话数。
  完全没有计数器的会话仍按开始日期显示 session,无 Token 数字。`<synthetic>` 模型行是 CLI 的占位消息,可忽略。
- **Codex-only**:§① 用 ccusage;回退 native 后只有整窗 session 汇总,没有日趋势/cache hit/
  thinking;§②/④/⑤保留标题并标「本节不可用」;§③ 只有 ccusage 有效时可用。不得从
  Codex session 汇总推断 branch/tool/sidechain/stage/Git 归属。
- 美元成本**只在 ccusage 可用时**给出估算(基础用量来源即 ccusage);本工具不维护价格表。
- 报告与 JSON 落 `runs/token-usage/`(gitignored):不进 git、不外发、分享前人工审查;
  非 workspace 项目匿名归并为 `other`。
- 单机单操作者;团队聚合/账单对账/identity join 属 issue #22,不在此工具范围。
