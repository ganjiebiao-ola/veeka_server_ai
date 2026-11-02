# INCIDENT.md rendering — section order and provenance

`run plan` writes `INCIDENT.md` to the worktree root (`lib/brief.py render`, port of
`fixbrief.go buildIncidentMD`). The **contract text is never duplicated here**: the block between
`<!-- BEGIN incident-fix:contract -->` / `<!-- END incident-fix:contract -->` in
`skills/incident-fix/SKILL.md` is spliced in verbatim (`load_contract` insists on exactly one pair of
markers). Change the contract there and only there.

| # | Section | Source |
|---|---|---|
| 1 | `# INCIDENT <id>` | incident id |
| 2 | `## 告警` — rule (rid / rule_name / rule_uid), subject, title, fingerprint, eval epoch | `alert.json` / `route.json` or `report.json incident.*` |
| 3 | `## 根因结论、证据与影响（…已过 Egress 脱敏闸口）` + the two fixed sentences ("这是你唯一的事实来源…", "修复建议…不构成实现约束") + `---` + the report **verbatim** + `---` | `issue.draft.md`, or the reconstruction (`docs/input-contract.md`) |
| 4 | `## 修复目标` — repo label + located files + "定位结果不是限制" | `eligibility.json files` |
| 5 | `## 人工评审意见（必须遵照…）` — only on 返修: the review quoted line by line + the three rules | `--review <file>` or the report's closed-PR `review_summary` |
| 6 | `## 环境事实（探测…）` — runtime version, target-file style | probes below |
| 7 | the contract block: `## 环境约束` / `## 任务` 1–10 (+6b) / `## 产出契约` | `skills/incident-fix/SKILL.md` |
| 8 | `## 上一轮为什么失败（这是第 N 次尝试）` — only on retry: fail class + reason + "不要原样再做一遍" | last `attempts.jsonl` line with a `fail_class` |

## Probes (deterministic; "未探测到" rather than a guess)

Runtime, trust order (`detect_runtime`): `.github/workflows/*.y*ml` `php-version:\s*['"]?(\d+\.\d+)`
→ `composer.json` `"php"\s*:\s*"([^"]+)"` → `go.mod` `(?m)^go\s+(\d+\.\d+(?:\.\d+)?)` → CI
`node-version:` / `python-version:` → `.nvmrc` → `package.json engines.node` → `.python-version` →
`pyproject.toml requires-python`. Files are read from the **base ref** (`git show <ref>:<path>`), not
from the working tree.

Style (`style_of`, at most 3 located files): the dominant indent character with ≥3 lines of evidence,
docblock continuation lines (`^\s+\*`) excluded, space width = gcd of leading-space counts and only
reported when 2..8; plus whether the file ends with a newline.

## Headless prompt

Headless runs pass a deliberately thin prompt (`brief.py HEADLESS_PROMPT`, port of `codesecPrompt`):
"按工作目录根下的 INCIDENT.md 执行…不要 commit、不要 push、不要切换/重置分支". The file is the
contract; the prompt only points at it.
