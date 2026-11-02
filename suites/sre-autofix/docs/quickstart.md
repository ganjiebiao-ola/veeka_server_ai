# Quickstart — 从一份 SRE 根因报告到一个可评审的修复 PR（本机，约 30 分钟）

这是操作者视角的最短路径，命令可直接复制。每一步"为什么"见 `runbook.md`（英文参考）与 `../SUITE.md`
（契约）。本文按 2026-08-26 首次在真实操作者机器上跑通的流程整理，踩过的坑都已经修进 suite，
文末《常见坑》只留下环境层面你仍需自己注意的几条。

> 全程用**你自己的身份**：git 身份、`gh` 登录、本机 agent CLI。suite 不带任何凭据，也永远不会自动合并 PR。

## 0. 一次性准备（每台机器一次）

```sh
cd <workspace>                                  # 本模板的工作区根目录
git clone <git-url-of-target-repo> repos/<repo-id>   # 挂载目标业务仓
```

`workspace.yaml` 的 `repositories:` 下登记它：

```yaml
  - id: <repo-id>
    path: repos/<repo-id>
```

suite 配置**不要改仓库里的 `config.yaml`**（那是模板，框架会持续更新，改了每次 `git pull` 都冲突）；
复制一份成你自己的、gitignored 的 `config.local.yaml`：

```sh
cp suites/sre-autofix/config.yaml suites/sre-autofix/config.local.yaml
```

编辑 `config.local.yaml`，把 `repos:` 下的 `TODO(owner)` 条目换成：

```yaml
repos:
  - id: <repo-id>
    scope: [app/, cli/]                # 补丁允许落在的路径前缀；越界即停驻
    base: main
    remote: origin
    github: <owner>/<repo>
    checks: []                         # 先留空，下一步让 doctor 告诉你填什么
```

```sh
suites/sre-autofix/run doctor
```

看三处：

- 第一行 `config file in effect` 应指向 `config.local.yaml — operator copy`。
- `MUST` 行全部 `[OK  ]`（python3 / git / harness / 契约块 / 仓库已挂载）。
- `GATE` 行 `[WARN] … checks not configured` 下面的 `↳` 建议：suite 读了目标仓自己的 CI 和工具链标记，
  给出可直接粘贴的 `checks:`，并标明它**能否抓到"签名/类型错"**（编译型语言的编译器能；`php -l`、
  `compileall` 这类只查语法的不能，会标 `SYNTAX ONLY` 并指出该配什么分析器）。

把建议粘进 `config.local.yaml` 的 `checks:`，再跑一次 doctor 直到 GATE 行 `[OK  ]`。几个典型值：

```yaml
    checks: ["go build ./...", "go vet ./..."]                              # Go
    checks: ["mvn -q -DskipTests compile"]                                  # Java
    checks: ["npx tsc --noEmit"]                                            # TypeScript
    checks: ["sh {root}/suites/sre-autofix/docs/examples/phpstan-new-errors.sh {worktree} {files}"]   # 老 PHP 仓（无 autoload）
```

`checks` 里的命令在 **worktree** 里执行；`{root}` = 工作区根、`{worktree}` = 工作树、`{files}` = 改动文件。
PHP 那条需要 Docker，框架是 C 扩展时还要给分析器一份 IDE stubs（`export PHPSTAN_STUBS=<stubs dir>`，
在后面跑 `gate`/`fix` 的同一个 shell 里）——详见脚本头注释。

```sh
suites/sre-autofix/test        # 自测应全绿；不会向你要 human-id
```

## 1. 拿到报告

上游哨兵在报告频道每件事故发一张卡，**线程里**有机器人上传的 `report-INC-….json`（有更新会再传一份，取最新）。
下载到本机，比如 `~/Downloads/report-INC-<id>.json`。同机能拿到归档目录（含证据摘录）就用目录，更全；
只有 json 也完全够用（根因节会由 json 重建并标注）。

只有 `cause_locus=code_defect`、置信度达标、点名的源文件在你配置的仓里的报告才会通过第 2 步；
其它（如 `dependency_failure`）会**按契约停驻**，那不是故障。

## 2. 认领（claim）

```sh
suites/sre-autofix/run claim ~/Downloads/report-INC-<id>.json
```

看五条判据表：全 ✅ 并给出「目标：<repo-id> → <files>」才继续；退出码 3 = 停驻，表里 ❌ 那行就是原因。
此后所有命令只用 `INC-<id>`。

## 3. 计划（plan）

```sh
suites/sre-autofix/run plan INC-<id>
```

fetch `origin/<base>`，在 `runs/sre-autofix/INC-<id>/worktree/` 建分支 `autofix/INC-<id>` 的 worktree，
写好 `INCIDENT.md`（报告 + 修复目标 + 环境事实——含 `gate` 将执行的 `checks` 命令，agent 可以先自己跑）。

## 4. 修复（fix）——二选一

**交互（默认）**：在工作区根目录开你的 agent（Claude Code / Codex / OpenCode），说：

> 按 `runs/sre-autofix/INC-<id>/worktree/INCIDENT.md` 修复，不要 commit、不要 push

它会读源码确认根因、做最小改动、写 `FIXNOTES.md` 与 `.sre-evidence/verification.json`。
你随时可以插话；报告里标注为"产品决策"的取舍（如 fail-open / fail-closed）它多半会问你。
effort 用默认档即可。

**无人值守**：

```sh
suites/sre-autofix/run fix INC-<id> --headless      # PATH 上的 claude / codex / opencode；跑完自动过 gate
```

两种形态下 agent 都**不能 commit / push**：gate 靠 `git diff` 读补丁，commit 和 PR 由第 6 步用你的身份、
经 harness 批准后做。

## 5. 验证门（gate）

```sh
suites/sre-autofix/run gate INC-<id>
```

五行，全 ✅ 才能 ship：

| 行 | 看什么 |
|---|---|
| 1–3 | 补丁非空且可干净应用 / 落在 `scope` 内且交接件未纳入 / 无密钥 |
| 4 | agent 自述的 `verification.json` 全部通过 |
| 5 | **你配的 `checks` 命令全部退出 0**（全文在 `runs/sre-autofix/INC-<id>/repo-checks.log`） |

第 5 行 ❌ 时先分辨是环境还是补丁：log 里是"找不到命令 / unknown class / 镜像拉取失败"→ 环境，修好重跑
`gate`；log 点名补丁里的行 → `run fix INC-<id> --retry`（重置 worktree，把失败原因写进 INCIDENT.md，再修一轮）。

## 6. 出 PR（ship）

```sh
suites/sre-autofix/run ship INC-<id> --dry-run   # 先看：标题、正文、将执行的命令；不 commit
suites/sre-autofix/run ship INC-<id>             # 真开
```

真开做的事：重跑 gate → 用你的 git 身份 `commit --only <gate 认过的文件>` → 渲染 `pr-title.txt` /
`pr-body.md`（含五行门表）→ **终端上两次输入 human-id 批准**（`git push`、`gh pr create`）→ 写 `pr.json`
→ 删 worktree。PR 由人评审合并，永不自动合。

必须在**真实终端**跑：harness 只从 `/dev/tty` 读批准，agent 会话里的 Bash 没有终端会 fail-safe 阻断
（退出码 5；commit 已做，回真实终端重跑会从 push 续上）。

远端已有同名分支 `autofix/INC-<id>` 时 ship 会拒绝（永不 force-push）。这通常意味着上游或别人已为这件开过
PR——先去看那个 PR；确实要另开对照件，就手工换名推：

```sh
WT=runs/sre-autofix/INC-<id>/worktree; RUN=runs/sre-autofix/INC-<id>
git -C $WT push origin HEAD:refs/heads/autofix/INC-<id>-<yourname>
gh pr create --repo <owner>/<repo> --base main --head autofix/INC-<id>-<yourname> \
  --title "$(cat $RUN/pr-title.txt)" --body-file $RUN/pr-body.md --draft
```

## 7. 收尾（release）

```sh
suites/sre-autofix/run release INC-<id>     # 删 worktree 与本地分支；真 ship 成功会自动做
```

## 产物在哪

`runs/sre-autofix/INC-<id>/`（gitignored）：`incident.json` `eligibility.json`（claim）· `INCIDENT.md`
`workspace.json`（plan）· `verification-gate.json` `fix.patch` `FIXNOTES.md` `verification.json`
`repo-checks.log`（gate）· `pr-title.txt` `pr-body.md` `pr.json`（ship）· `attempts.jsonl`（每次 gate/fix
的结果与失败分类）。harness 的每次批准/阻断在 `runs/harness-log.jsonl`。

## 常见坑（环境层面，suite 修不掉的）

- **环境变量要在跑 `gate` / `fix` 的同一个 shell 里 export**（如 `PHPSTAN_STUBS`）；headless 的 agent
  继承的也是那个 shell。
- **`checks` 首次运行可能要拉 Docker 镜像**，第一次慢是正常的；`checks_wall_sec`（默认 600 s）够用。
- **`git pull` 后不要再碰 `config.yaml`**；你的配置只在 `config.local.yaml`。
- **交互修复前把与本事故无关的旧分支引用清掉**（`git -C repos/<repo-id> branch -a | grep autofix`）——agent
  会 `git log --all`，看到前一轮的补丁就不是独立样本了；`git update-ref -d refs/remotes/origin/<branch>`
  只删本地引用，远端不受影响。
- **同一份报告第二次 `plan` 前先 `release`**。
