# PR title and body — the 修复断言四件套

`ship` renders the PR with `lib/prbody.py` (port of `egress/pr.go`), then scrubs it; a secret-kind hit
blocks shipping (exit 5) and the body is still written to `runs/sre-autofix/<id>/pr-body.md` for
inspection.

## The four fix assertions (`n2-handoff.md` §五)

| # | Assertion | Where it lands |
|---|---|---|
| ① | 复现条件 + 复现频率 (+ the evidence excerpt that shows it) | `## 二、完整证据链` → 影响面、复现条件 details; evidence list |
| ② | 根因推理链, each step traceable to an `ev://<incident>/tool/<tool_call_id>` reference | 推理链 + the 证据引用 table |
| ③ | 修复说明 — files, the `## 改了什么` section lifted from `FIXNOTES.md`, and a per-hunk table `| 文件 | 行 | 首行改动 |` (≤20 hunks) | `## 一、精简版：根因与修法` |
| ④ | 验证方式 — gate summary, the agent's declared checks, the fixed sentence that CI is authoritative for syntax and that no end-to-end regression ran | `### 验证方式` |

## Layout

1. `## 10 分钟评审路径` — one paragraph, the gate green-light table (4 rows + 补丁规模 + 本地验证口径
   [+ 尝试次数]), the cost line (local form: no ledger), `> 降级口径`, `> 模型自评需要人工介入`, and
   `Refs #N` when `ship --issue N` was given.
2. `## 一、精简版：根因与修法` — 问题 / 严重程度 / 根因 / 置信度 / 根因归属 (`cause_locus` label) /
   the 未定因 warning / 本次修法 (files + 改了什么 + hunk table).
3. `## 二、完整证据链（供深查，默认折叠）` — two `<details>` blocks (impact & chain; evidence table +
   per-evidence query/excerpt + excluded hypotheses + data gaps + the "全量原始证据…不外发" line), then
   the full `FIXNOTES.md` folded.
4. `### 验证方式`, `### 关联与判重` (duplicate_of, rule/subject/fingerprint/epoch, branch/base/commit),
   `### 机器标记` (`<!-- sre-agent:eval_epoch=… fingerprint=… incident=… rule_uid=… -->`, sorted keys),
   `### 签收清单` (four boxes), `<sub>充分度评分明细</sub>`.

## Local-form rules

- **Never `Closes` / `Fixes` / `Resolves #`**: any such line (including inside `FIXNOTES.md`) is
  rewritten to `Refs #…` at render time. The PR is not the issue's state carrier and must not close
  anything on merge.
- Commit and PR author = the operator's own git identity / `gh auth`; **no AI signature** in the
  commit message or the body (upstream hard rule; the workspace attributes work to the human-id).
- Cost: the upstream ledger is not ported; the header says the fix ran on the operator's machine.
- Title (`pr_title`): `fix(<parent-dir>): <report title>` (or the root-cause statement), leading
  `未定因` hedges stripped, ≤72 characters + `…`.
- Commit message (`commit_message`): root-cause statement (≤68 chars) / suggested fix (≤400) /
  `Files: …`.
