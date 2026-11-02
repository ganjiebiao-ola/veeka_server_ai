# `FIXNOTES.md` — section by section

`FIXNOTES.md` is the human-readable half of the output contract; it is pasted **verbatim** into the PR
body (folded), and its first section is lifted into the PR's one-screen summary. Template:
`assets/templates/FIXNOTES.md`. Section headers must be exactly these (`## 改了什么` first — the PR
renderer, `suites/sre-autofix/lib/prbody.py fix_summary`, extracts the text under `## 改了什么` /
`## What changed` / `## Changes` and falls back to your first three lines).

| Section | What the reviewer expects |
|---|---|
| `## 改了什么` | Files and hunks, one line each; what behaviour changes. This *is* the PR summary. |
| `## 为什么这么改` | Why here and not elsewhere; why not lifted to a higher-level hook / base class / middleware (任务 7); if the report suggested a fix, whether you adopted it or chose differently and why (任务 3). |
| `## 既有防线普查结果（任务 4）` | Which existing retry / keep-alive / circuit-breaker / error-handling mechanisms you looked for, what you found (`file:line`), whether you plugged into one or why you rejected it. |
| `## 降级后的行为` | Exactly which error classes now degrade, what is still raised, and where the observable trace (log line, metric) is written (任务 6 / 6b). |
| `## 同构位点（任务 8）` | Sibling call sites / copy-pasted methods with the same exposure: `file:line`, exposed yes/no, why untouched this time. Write `未发现` if none. |
| `## 评审者请重点看什么` | The one or two judgement calls a reviewer must confirm (direction, contract level, degradation policy). |
| `## 无法验证的部分` | Mirrors `verification.json not_verified[]` in prose; be concrete about *why* each could not be verified. |

Claims of "与既有实现同口径" must cite `file:line` you actually compared (任务 9).
