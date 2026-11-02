# Headless 通用任务模式(generic runs)

后台可以被任意外部工具当作**通用的容器化 Claude Code agent** 来驱动——不
仅限于安全审计 Web UI。

一次 *generic run* 的输入是一段**原始 prompt** 加一个**宿主机目录**:后台把
该目录 bind-mount 进一个全新的 scanner 容器,让 Claude Code 在里面无人值守地
完成任务,并通过 SSE 实时回传进度。其余一切都复用安全审计产品同一套机制:
Docker 编排、`MAX_CONCURRENT_SCANS` 并发闸门、Claude 鉴权(OAuth / API key /
中转),每个 run 的 token 与Token 统计,以及 Web UI 实时观测。

一个集成示例是 **SkillOpt** 的 `ola_agent_exec` target backend——见[第 5 节](#5-skillopt-如何接入)。任何
HTTP 客户端都可以用同样的方式调用。

---

## 1. 启用 generic runs(服务端)

generic 模式**默认关闭**:服务端未显式 opt-in 之前,所有 prompt 模式请求一律
返回 `403`。通过环境变量开启:

| 环境变量 | 是否必须 | 含义 |
|---|---|---|
| `OLA_AGENT_WORKSPACES_ROOT` | 必须 | 逗号分隔的**宿主机绝对路径前缀**白名单。请求的 `workspaceHostDir` 必须落在其中之一,否则 `403`。这既是开关也是安全边界——尽量收窄(指向专用的 workspaces 目录树),绝不要设成 `$HOME` 或 `/`。 |
| `OLA_AGENT_WORKSPACE_CHOWN` | 强烈建议 | 退出时把工作目录 chown 回的 `uid:gid`。scanner 容器以 root 运行;不设置的话,agent 在挂载目录里新建的文件调用方用户将无法删除。设成调用方的 `id -u`:`id -g`。 |

两个 compose 文件都已从 `.env` 转发这两个变量:

```bash
# .env
OLA_AGENT_WORKSPACES_ROOT=/home/ecs-user/skillopt-workspaces
OLA_AGENT_WORKSPACE_CHOWN=1000:1000

# 然后照常启动
./scripts/dev.sh compose:server:start     # Linux 服务器(端口绑 127.0.0.1)
# 或: ./scripts/dev.sh compose:start      # macOS 开发机
```

自检——启动日志会打印:

```
[boot] generic headless runs enabled — workspace roots: /home/ecs-user/skillopt-workspaces
```

### 安全注意事项

- **API 没有鉴权层。**端口只绑 `127.0.0.1`(server compose 已如此),仅通过
  SSH 隧道或同机调用方访问。能连上端口的人就能对任意白名单目录跑 agent。
- 工作目录是**读写挂载**。白名单是调用方与宿主机文件系统之间唯一的屏障——
  范围务必收紧。
- headless run 的 `Bash` 命令经过 scanner 的 `canUseTool` 回调。它拒绝已识别的
  `git push`、`rm -rf`、`--force` 等危险命令；这不是完整的网络或 shell 隔离。

---

## 2. 调用时序

每个调用方进程建一个 session,之后每个任务:发起 run → 跟 SSE → 取产物。

### 2.1 创建 session(一次即可)

```
POST /api/sessions            → 201 { "sessionId": "..." }
```

session 只用于在 UI 历史里给 run 分组;所有 run 复用同一个即可。

### 2.2 发起 run

```
POST /api/runs                → 201 { "runId": "...", "status": "queued" }
```

请求体(generic 模式——由 `prompt` 字段的存在触发):

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | string | 必填 |
| `prompt` | string | 必填,非空,≤ 256 KB。带上它即进入 generic 模式。以文件形式(`prompt.txt`)传入容器,不走环境变量。 |
| `workspaceHostDir` | string | 必填。**宿主机**绝对路径;`..` 会被解析归一;必须落在 `OLA_AGENT_WORKSPACES_ROOT` 白名单内。容器内以读写方式挂载到 `/workspace/repo`。 |
| `model` | string | `fable` \| `opus` \| `sonnet` \| `haiku`,**或**任意原始 model id(支持中转侧命名),**或** `""` 表示交给服务端的 `ANTHROPIC_MODEL`。服务端没有设置 `ANTHROPIC_MODEL` 时,`""` 返回 400。 |
| `effort` | string | `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `mode` | string | `scan` \| `fix` ——校验要求必填;generic run 的任务完全由 prompt 定义,直接传 `fix` 即可。 |
| `timeoutSeconds` | number | 可选;收敛到 `[30, 14400]`。超时后容器被优雅停止(SIGTERM → 宽限 → SIGKILL),run 以 `failed` 结束,error 为 `timeout after Ns`。 |

与 skill-run 形态互斥:generic 请求**不得**携带 `repoUrl` / `skill`。

错误响应:

| 状态码 | 原因 |
|---|---|
| `400` | 校验失败(prompt 为空 / 超长、相对路径、枚举值非法……) |
| `403` | `OLA_AGENT_WORKSPACES_ROOT` 未设置,或 `workspaceHostDir` 不在白名单内 |
| `429` | 并发闸门已满(`MAX_CONCURRENT_SCANS`);带 `Retry-After` 头——退避后重试 |

### 2.3 跟踪进度(SSE)

```
GET /api/runs/:id/events      → text/event-stream
```

每帧是一行 `data: <RunEvent JSON>`。晚到的订阅者会收到全部缓冲事件的重放,
服务端在 `run_finished` 之后立即关闭流——所以即使 run 已经结束,一个普通的
阻塞式读取也会自行终止。

值得关注的事件:`run_status`、`tool_invoked` / `tool_completed`、
`assistant_text`、`thinking_emitted`、`usage_delta`,以及终态的
`run_finished`(`{ "status": "completed" | "failed", "error"? }`)。

### 2.4 获取结果

```
GET /api/runs/:id                       → RunSummary(status、error、usage 含 Token 数)
GET /api/runs/:id/artifacts/response    → response.md   — 最终回答(assistant 末条消息)
GET /api/runs/:id/artifacts/events      → events.jsonl  — 完整 bridge 帧日志
GET /api/runs/:id/artifacts/prompt      → prompt.txt    — 提交的 prompt 原文
```

产物在写出之前返回 `404`。agent 写出的文件直接落在你的
`workspaceHostDir` 里(实时读写挂载,没有拷贝环节),退出时 chown 回
`OLA_AGENT_WORKSPACE_CHOWN`。

---

## 3. 行为保证(headless 契约)

- **全程无人参与。**run 从不等人回答,调用方绝不会阻塞。会向人提问的工具
  (`AskUserQuestion`)一律拒绝。旧字段 `interactive` 已移除,传了也会被忽略。
- **Bash 过危险闸门。**每条 Bash 命令都经过 `canUseTool`;破坏性命令
  (`git push`、`rm -rf`、`--force` ……)自动拒绝。
- **挂载目录而非 clone。**`/workspace/repo` 就是你的宿主机目录本体,不要求
  是 git 仓库。agent 的文件修改就是你的输出。
- **超时是优雅的。**先 SIGTERM(保证退出时的 chown 钩子能执行)再
  SIGKILL;run 以 `failed: timeout after Ns` 结束,不残留容器。
- **Token 统计。**`usage_delta` 事件流式给出过程中的 token;最终汇总
  (含 Token 数)在 `GET /api/runs/:id`。
- **可观测。**generic run 会以 `local:<dir>`、skill 为 `generic` 的形式出现
  在 Web UI 历史里——与产品 run 同一套实时视图。

---

## 4. 端到端示例(curl)

```bash
API=http://127.0.0.1:37018
WORK=/home/ecs-user/skillopt-workspaces/demo   # 必须在 OLA_AGENT_WORKSPACES_ROOT 之下
mkdir -p "$WORK" && printf 'Summarize this directory into summary.md\n' > "$WORK/task.md"

SID=$(curl -s -X POST $API/api/sessions | jq -r .sessionId)

RUN=$(jq -n --arg sid "$SID" --arg dir "$WORK" \
  '{sessionId:$sid, workspaceHostDir:$dir,
    prompt:"Read task.md and do what it says. Write results into the workspace.",
    model:"sonnet", effort:"medium", mode:"fix",
    timeoutSeconds:600}' |
  curl -s -X POST $API/api/runs -H 'content-type: application/json' -d @- | jq -r .runId)

# 阻塞到 run 结束(服务端在 run_finished 后关闭流)
curl -sN $API/api/runs/$RUN/events | sed -nu 's/^data: //p' | jq -c '.type'

curl -s $API/api/runs/$RUN/artifacts/response   # 最终回答
curl -s $API/api/runs/$RUN | jq .usage          # tokens
ls "$WORK"                                      # agent 写出的文件(如 summary.md)
```

---

## 5. SkillOpt 如何接入

外部 SkillOpt 集成(不在本套件仓库内)使用 `ola_agent_exec` **target
backend**(`skillopt/model/ola_agent_backend.py`),在这套 API 之上实现了
SkillOpt 的 exec-target 契约:每个优化 trial 就是一次 generic run——POST
trial 的 prompt + `work_dir`,跟 SSE 到 `run_finished`,取
`response.md` / `events.jsonl`,返回 `(response, raw)`。失败 / 超时的 run
返回 `("", raw)`,从而触发 SkillOpt 自身的空响应重试;`429` 按
`Retry-After` 头做指数退避重试。

### 服务端前置条件

1. 后台已按第 1 节启用 generic 模式,且白名单必须覆盖 SkillOpt 的 trial
   输出目录树,即 SkillOpt 配置里的 `env.out_root`:

   ```bash
   OLA_AGENT_WORKSPACES_ROOT=/home/ecs-user/skillopt-workspaces
   OLA_AGENT_WORKSPACE_CHOWN=$(id -u):$(id -g)   # 跑 SkillOpt 的那个用户
   ```

2. Claude provider 照常配置(OAuth / `ANTHROPIC_API_KEY` / 中转——见
   [README 的快速开始](../README.md#quick-start-macos))。

### SkillOpt 侧配置

| 配置项 | 位置 | 含义 |
|---|---|---|
| `model.target_backend: ola_agent_exec` | config yaml | 把 target-agent trial 路由到本 backend |
| `model.target` | config yaml | 每个 run 传递的 model(`sonnet`、中转原始 id,或留空交给服务端) |
| `env.out_root` | config yaml | trial 工作目录根——**必须落在 `OLA_AGENT_WORKSPACES_ROOT` 之下** |
| `env.exec_timeout` | config yaml | 每 trial 秒数 → 透传为 `timeoutSeconds` |
| `OLA_AGENT_API_BASE` | 环境变量 | 后台地址,默认 `http://127.0.0.1:37018` |
| `OLA_AGENT_EXEC_EFFORT` | 环境变量 | 每个 run 的 `effort`,默认 `medium` |

参考配置是 `veeka_proto` env(SkillOpt 镜像中的
`configs/veeka_proto/default.yaml`),它通过本后台优化 veeka-spec 的
`proto-api-creation` skill:

```bash
cd /path/to/SkillOpt
export OLA_AGENT_API_BASE=http://127.0.0.1:37018
python scripts/train.py --config configs/veeka_proto/default.yaml
```

每个 trial 的机制:SkillOpt 的 `prepare_workspace()` 在 `out_root` 下为每个
trial 预置 `work_dir`(内含 `task.md` 与
`.agents/skills/skillopt-target/SKILL.md`);适配器把 prompt 包上工作目录
说明后提交。后台为每个 trial 提供
容器隔离、钉死的 claude-code 版本、集中并发限流、`raw` trace 里的单 trial
Token 数,以及 Web UI 里所有 trial 的实时视图(历史中显示为
`local:<trial 目录>`)。

并发规模建议:SkillOpt 的 `env.workers` 不要明显超过后台的
`MAX_CONCURRENT_SCANS`——多出来的 trial 只会在 429 退避里空等。

> SkillOpt 镜像本身的维护说明(remote 纪律、上游同步、我们改动了哪些文件)
> 见 SkillOpt 仓库根目录的 `CLAUDE.md`。
