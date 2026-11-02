---
name: ai-usage-weekly
description: Use when the operator wants to write and submit their weekly AI usage update (用量 / 费用 / 使用内容 / 产生的价值) to the team's reports repo, or when a team lead wants to aggregate the week's submissions into the team AI usage report (HTML + markdown), or wants the monthly AI cost report from the LiteLLM key allocation file (月度成本 / FinOps 月报).
id: skill:ai-usage-weekly
type: skill
owner: EricZhang
version: "0000000000000000000000000000000000000000"
status: draft
summary: Weekly AI-usage reporting chain (#22) - each person's local token usage + price-table cost estimate + AI-drafted, human-confirmed narrative becomes one submission file in the team reports repo; the lead aggregates a week's files into one self-contained team report, and imports the monthly LiteLLM key allocation into a cost-by-team monthly report (#360) with the git history of the mounted pilot repos (#363) and the month's weekly use, delivery and value (#361).
use_when: A team member says "生成我这周的 AI 使用小结并提交" / "write my weekly AI usage update"; a team lead says "汇总本组 2026-W37 周报" / "build the team AI usage report for week N"; "导入 9 月的分摊文件" / "build the monthly AI cost report for 2026-09".
usage: Run from the workspace root. The deterministic tool is scripts/ai-usage-weekly (submit | team | request | month); this skill drafts the narrative with the operator and interprets the aggregate, and never invents numbers.
dependencies: ["skill:token-usage-analysis"]
regression: ["regression-case:ai-usage-weekly-smoke"]
---

# AI Usage Weekly (team reporting chain, #22)

The company's AI resource guide (team-level monthly budget, public usage) asks every person to
submit a short weekly AI usage update with four items — **用量 / 费用 / 使用内容 / 产生的价值** —
where usage and cost come from the system and the person only writes what AI was used for and
what it produced; the team then gets an automatic weekly summary (谁在用什么 → 投入多少 → 做了什么
→ 效果 → 值得学习). This skill is that chain, built on the local collectors of
`skill:token-usage-analysis`:

```
个人机器: token-usage-report / token-usage-tasks (JSON) ─┐
          assets/pricing.json × tokens = 估算费用        ├─ submit ─▶ <reports-dir>/reports/<week>/<human_id>.json + .md
          narrative.json (AI 起草 → 人确认)              ─┘                      │ (git: the person commits/pushes)
team lead: team ─▶ reads reports/<week>/*.json ─▶ team-report.html + team-report.md
```

Facts come **only** from the tool's output; the skill drafts prose and interprets, it never
invents numbers. Cost is always an **估算** (price table × tokens), never a bill.

## Phase 0: Preflight and the transparency contract

1. Run from the workspace root (`workspace.yaml` + `agent-instructions/` exist). `human_id` is
   `workspace.yaml` `owner`, `team` is `workspace.yaml` `team` — people are accountable, there is
   no agent identity. If either is a placeholder, stop and ask the operator to fill it.
2. The team reports repo is mounted at `knowledge/ai-usage-reports/` by default (a separate git
   clone under the `knowledge/` mount point; override with `--reports-dir`). If it is missing,
   `submit` (and `request --form`) creates it as a **local** reports repo — its own `git init`,
   the starter files from `assets/reports-repo/` (roster / budget as `.example`) — and prints a
   WARN: it is not the team's repo until it gets a remote (`git remote add origin <private repo>`)
   or is replaced by a `git clone`. Relay that WARN to the operator verbatim; do not `mkdir` or
   `git init` it yourself. `team` and `request review` never create it (nothing to read) and exit 2.
3. **Transparency contract (hard, restate it before the first run of a session):**
   - What gets submitted is **visible to the whole team**: aggregated usage, an estimated cost,
     and the narrative the operator confirmed. Submitting is the operator's explicit opt-in.
   - Qoder (`~/.qoder/projects/`) is read automatically when its log exists. Qoder logs **credits, not
     tokens**: credits are shown in their own column (personal and team pages), never converted to tokens,
     never added to requests or to the estimate, and marked 未与账单核对.
   - The submission file never contains prompts, file paths, or session ids; non-workspace
     projects stay in the anonymous `other` bucket exactly as in `token-usage-analysis`.
   - **Three amounts, side by side, never summed (三种金额分列,不相加).** `cost.estimated` is the
     local usage log × `assets/pricing.json` — **an estimate (估算), not a bill**: every place it
     is shown carries 估算 and the pricing-table version, and it never enters 核算/报销 or a budget
     total. `cost.actual` (what the bill / ledger says) and `cost.allocated` (this person's share)
     come **only** from a billing-owner `--cost-file` (`assets/cost.example.json`; T2 #196 fills it
     from bills) — without it they are `null` and the report shows 待核实, never 0. Models missing
     from the table are listed as 未定价, never priced by guess.
   - `quality` (质量与归属) is program-filled: `missing_sources` (what should exist but was not
     given — shown as 待接入/待核实), `unpriced_models`, `shared_costs`, `allocation` (ratios must
     sum to 100 — 归属守恒, the tool refuses otherwise) and `confirmed_by` (member / billing /
     attribution — three different people, recorded separately).
   - Per the guide: individual usage 不是绩效输入, not a leaderboard. The team report 不按费用排序 —
     people appear in name order.
   - The tool **never pushes** and never calls the network; `--commit` only makes a local commit
     in the reports repo, and the operator pushes / opens the PR themselves.

## Phase 1: Personal submission (組員)

1. Resolve the week: `--week YYYY-Www` (ISO week, Monday–Sunday) or explicit `--since/--until`;
   default is the last complete ISO week. Team aggregation only accepts the exact Monday–Sunday
   window; a custom personal range is quarantined if it does not match. Confirm it with the operator. Week boundaries are stated
   in `meta.timezone` (this machine's, or `--timezone` — the team fixes one; T4 checks they agree).
   `meta.business` (业务/职能) comes from `workspace.yaml` `business:`; `null` until filled.
2. Produce the machine part first (no narrative yet):

       scripts/ai-usage-weekly submit --week <YYYY-Www> [--platform-export <csv|xlsx>]... [--bill <csv|json>]

   This runs `scripts/token-usage-report --json` and `scripts/token-usage-tasks report --json`
   for the window (with `TZ` set to the declared timezone, so a session that crosses Sunday
   midnight is split by each message's own event time), applies the price table, validates
   against `platform-internals/schemas/ai-usage-submission.schema.json`, and writes
   `reports/<week>/<human_id>.json` + `.md` + `<human_id>.html` (narrative marked 待补). The
   html is the fixed personal template of the 方案 (KPI, 三种金额, 每日 / 模型 SVG, 数据来源, 按项目,
   主要工作与交付, 质量与归属, 金额与来源明细) rendered from the **same submission dict** as the
   md — nothing is recomputed per format; self-contained, printable, `--open` shows it. Read
   the `.md` back and show the operator the usage line and the estimated cost.
   - **提交前需要补齐** is program-made (`checklist()`), printed after `submit` and put at the
     end of both the md and the html; every item names the field to fix: 本机估算 / 账单待核实
     (`cost.actual`), 实际费用未确认, 未定价模型, 来源缺失, 周内 N 天无记录 (`usage.by_day`),
     分摊 ≠ 100, 叙事待补, 证据待确认 (`narrative.projects[i].tasks[j].evidence`), 时间/效率数字
     无测量依据 (a number with %/倍/小时/天 in a task that has no evidence — rewrite it as a
     qualitative statement), 缺可复用方法/失败/问题. Walk the list with the operator; the tool
     never fills any of it in.
   - `--platform-export` (repeatable): the unified API platform's CSV / XLSX. Columns are
     matched through `assets/platform-export.mapping.json`; a column the mapping does not know
     **exits 2 naming it** — never guess. Rows for other users are skipped (`--platform-user`
     when your platform id differs from `human_id`). A (day, model) the platform reports
     **replaces** the local log's cells for it (择一计入, counted as `superseded` in
     `usage.sources[]`); everything else is kept. With multiple exports, later files replace overlapping
     (day, model) cells in both `submit` and `team`; repeating a file never doubles usage.
     Platform rows land in bucket `platform` — the
     platform does not know the repo, so project attribution stays a local-log thing. A cost
     column in the export is kept apart as `reported_cost`(性质待核实) — it is **not**
     `cost.actual`.
   - `--bill`: the bill / subscription ledger (`assets/bill.example.csv`; columns source, nature,
     currency, amount, since, until, confirmed) → `cost.actual` (the whole bill) and
     `cost.allocated` (prorated to the report week by service-period overlap, `basis` says how).
     Unknown currency or nature exits 2. Do not combine with a `--cost-file` that also carries
     actual/allocated.
   - `usage.sources[]` records every source with coverage, records, and bookkeeping; the md shows
     it as 数据来源. Either source alone is enough to submit; what is absent is listed in
     `quality.missing_sources` and shown as 待接入 / 待核实, never as 0.
3. Draft the narrative **from the data**: read the window's `runs/token-usage/tasks-*.json`
   (instances per bucket/branch, stage sequences, git signals) and `git log --since --until`
   in each active mounted repo. Write `narrative.json` following `assets/narrative.example.json`
   and the six points of the guide — 本周主要用 AI 完成了什么 / 具体产出 / 效率或质量改善 /
   值得复用的方法 / 效果不好的尝试 / 工具、模型、额度或接入问题 — plus per-project cards with
   commit hashes as evidence and a short `next_actions` list. Every claim ties to an instance,
   a commit, or a number; where the data cannot support a claim, leave it out.
4. Show the draft to the operator in chat, apply their edits, and only then save it (keep it
   under `runs/ai-usage-weekly/<week>/narrative.json`; it is local until submitted). Re-run:

       scripts/ai-usage-weekly submit --week <YYYY-Www> --narrative runs/ai-usage-weekly/<week>/narrative.json [--cost-file <path>] [--commit]

   Re-submitting the same week **replaces** the record and bumps `meta.submission_version`
   (never appends). `--cost-file` is optional and is the billing owner's, not the member's:
   do not invent an actual amount to fill it.
5. Print the operator's next steps: `git -C <reports-dir> push` and the PR flow their team
   uses. Do not run them.

## Phase 2: Team aggregation (team lead)

0. **Transport is the reports repo's git, not hand-sent files.** Each member's file is their own
   `reports/<week>/<human_id>.json`, so everyone pushes straight to `main`. Put the starter files
   from `assets/reports-repo/` into that (private) repo once: `reports/team.json` (the roster),
   `scripts/team-report.sh`, and `.github/workflows/team-report.yml` — the workflow re-renders
   the week on every push to `reports/**` and commits `team-report.html/.md` back, using only the
   job's `GITHUB_TOKEN` (never a team-wide key). Changes to the roster, budget, or request JSON refresh
   all weeks with stored submissions; existing reports repos must copy the updated `team-report.sh`.
   With it the lead opens a link; without it the
   lead runs step 1 by hand. Either way the tool itself never pushes.
1. Pull the reports repo, then:

       scripts/ai-usage-weekly team --week <YYYY-Www> [--platform-export <csv|xlsx>]... [--summary-file <path>] [--open]

   **Target shape: usage comes from the platform, people only submit the narrative.** With the
   lead's whole-team export, `--platform-export` maps each row's user to a `human_id` through
   `reports/team.json` `platform_ids` (`{"<platform user>": "<human_id>"}`; unmapped ids are used
   as-is). A member with a submission is deduped at (day, model) grain — the platform record
   wins (a v1 file without `cells` has its usage replaced wholesale, noted in sources). A member
   the platform saw but who has not submitted still gets a usage row, marked 仅平台用量 with
   叙事待提交, and stays on the 未提交 list. With only the export and no submissions the usage
   half still renders.

   The tool validates every `reports/<week>/*.json` (schema v2 strictly; v1 files are read for
   compatibility and lifted to the v2 shape — never written), lists a broken file under 未纳入
   with its reason and keeps going, lists members from `reports/team.json` who did not submit
   (no roster → 团队覆盖 shows 待接入, never an invented 0 %), aggregates, runs the **六项校验**
   and renders `team-report.html` (inline SVG, no external assets, light/dark) + `team-report.md`
   beside the submissions. People are in **name order** — never by cost. An empty week exits 2.
2. **六项校验** (footer table; a `fail` is also flagged red at the top of the page, but never
   blocks rendering): 来源不重复 · 周期一致 (same week and timezone across files and
   `team.json`) · 金额可解释 (three amounts stay apart, currency + nature kept) · 归属守恒
   (allocation ratios sum to 100) · 缺失可见 (未提交 / 未纳入 / 缺账单 / 实际为零 listed
   separately, never folded into a 0) · 成果有依据 (tasks without evidence are counted).
3. The KPI row keeps **估算总费用** (估算 · pricing version · 非账单) and **实际费用确认情况**
   (n/m confirmed · sum of confirmed bills by currency) as two tiles — they are never added.
3b. **月度预算状态** (`reports/budget.json` = `{"<business>": {"monthly": 5000, "currency":
   "USD"}}`, kept by the lead; `--budget-file` overrides): for the month the report week ends
   in, every past week's submissions contribute their `cost.allocated` (or `cost.actual` when
   its period sits inside the week) — **bills only; the estimate never counts**. A member-week
   without a bill is listed 待核实 and not counted. Shows 月预算 / 实际累计 / 预算余额 / 月底线性预测
   and the tier from the guide: ≤1× 正常 · ≤1.5× 超出但可从下月扣减 · >1.5× 预计超过,应及时沟通
   并额外确认 (exactly 1.5× is the middle tier). No `budget.json`, or no bill at all in the month
   → 尚未提供, no numbers. The page carries the rule and 预警用于支持决策,不做考核 verbatim.
4. Draft the 管理摘要 from `team-report.md`: estimated total (say 估算 and the pricing version),
   confirmed actual cost, the most active repos, what the team shipped (deliverables are
   de-duplicated by evidence, so two people on one PR count once), one or two 值得学习 items —
   each with its number. Show it to the lead, then re-render with `--summary-file <path>`.
5. The lead commits/pushes the rendered report through their normal flow; the tool never does.

## Phase 2b: Resource request (成员 or lead, #200)

The 方案's 资源申请 form as a structured draft — **a draft for the company's existing approval
flow, never an approval**. Principles the draft carries and you restate: 已有公司方案优先使用;
外购或续费先确认再购买;授权范围内的合理探索可以失败,但要分享失败结论。

1. Fill `assets/request.example.json` with the operator (fields = the form: kind 新购/增加额度/续费,
   resource, business, project, purpose 用途与现有资源不足, outcome 预期产出与验证方式, amount +
   currency, start / end, renewal, allocation single/split/shared + `split` ratios, note). Push
   for a *verifiable* outcome — "提升效率" is not one. Then:

       scripts/ai-usage-weekly request --form <path> [--commit]

   The tool validates (required fields, end ≥ start, split ratios = 100, currency from the
   mapping's list — an unknown one exits 2 naming it) and writes
   `reports/requests/<yyyy-mm>-<human_id>-<slug>.json` + `.md` (schema
   `platform-internals/schemas/ai-resource-request.schema.json`). 申请人 is `workspace.yaml`
   `owner` — a person. `--commit` is local only; the tool never submits, buys, or pushes.
2. Closed loop is in the json, edited by hand as things happen: `status` draft → confirmed →
   purchased → expired (or rejected); `bill_refs[]` = the bill / ledger source strings once bought
   (the same strings `submit --bill` records in `cost.actual.source`), so 记录资源与账单 links up;
   `review_before_renewal` = {verdict continue / adjust / stop, reason, reviewed_by, reviewed_at}
   before any renewal. The team page lists 本周新申请 (created in the week) and 待复评 (a
   renewing request ending within 30 days with no review yet) so nothing renews silently.
3. Before a renewal (the team page's 待复评 list):

       scripts/ai-usage-weekly request review <id>

   writes `reports/requests/<id>.review.md` from the service period's weeks: bills that match
   `bill_refs` (allocated preferred, never actual on top of it) per week and in total vs the
   amount requested, the requester's requests / tokens / estimate per week, and narrative tasks
   that mention the resource (or 无 — then ask the requester for outcomes). The verdict is the
   human's: they write `review_before_renewal` {continue / adjust / stop, reason, reviewed_by,
   reviewed_at} into the json; the tool never decides and never edits the request.

## Phase 2c: Monthly cost report (lead, #359 / #360)

The first version of the #22 FinOps view: **real** AI cost for one calendar month, from the monthly
LiteLLM key allocation file (each cloud bill split by virtual key in proportion to tokens).
It also reads the git history of the mounted pilot repos (#363), and rolls up the month's weekly
submissions and resource requests into AI use, delivery and value (#361).

1. Get the month's allocation file (`.xlsx`) from its owner. It holds real data: keep it out of the
   template repo and out of `knowledge/`. Then:

       scripts/ai-usage-weekly month --allocation <file.xlsx> [--open]

   The file has no month column, so the **file name is the only source of the month**. It must
   state exactly one month: `september_2026`, `Sep 2026`, `2026-09`, `2026_9`, `202609` or `2026年9月`.
   A name with no month, or with two different months, exits 2: rename the file, never guess.

   The tool writes `reports/months/<YYYY-MM>/month.json` + `month-report.md` + `month-report.html` in
   the reports repo. A re-import of the same month **replaces** all three files (it prints the old
   file's sha256) — it never adds to the old numbers.
2. What the report holds: real cost **by team** (the file's `Team` column, teams in name order — never
   ranked), tokens and key count per team, and the `[Unallocated]` rows on their own line. The team
   table holds no key and no email; only the 未映射 list (step 6) names an unmapped commit author.
   Two checks against the `Summary` sheet: **合计一致** (sum of
   `Real Spend` = `Summary` Total Cost (USD)) and **未分摊一致** (`[Unallocated]` rows = `Summary`
   Unallocated (USD)), tolerance $0.01. A failed check is a WARN and a red alert on the page; the
   report is still written. Relay a failure to the file owner — do not edit the numbers.
3. The amounts are real (分摊) cost. The price-table estimate (估算) never appears on this page and is
   never added to it.
4. **File format rules.** The tool reads the sheets `Real Spend` and `Summary` by name, and finds each
   column by name (case and extra spaces do not matter; column order does not matter). Every column
   must be known to `assets/platform-export.mapping.json`: an unknown column **exits 2 naming it** —
   the tool never guesses. Required: `Real Spend` → VK (email), Team, Provider, Model, Cost (USD);
   `Summary` → Provider, Model, Total Cost (USD). When the file owner renames a column, add the new
   name to `allocation_columns` / `allocation_summary_columns`; a column that is not needed goes to
   `allocation_ignore`; a renamed sheet goes to `allocation_sheets`. No code change. Ask the file owner
   to keep the sheet and column names the same each month and to say so before a change.
5. **Git history (#363).** The same run reads every repo mounted under `repos/` (or each `--repo
   <path>`; `--no-git` skips it). Local git only: pull the repos first — the tool never fetches. It
   reads the default branch (`origin/HEAD`, else `HEAD`) and counts per repo: commits (merge commits
   left out), AI-assisted commits and reverts. A commit belongs to the month of its **author date** in
   the `reports/team.json` timezone. **AI-assisted** = a `Co-Authored-By` trailer that names an AI tool;
   a human co-author does not count, and AI work without the trailer is not seen, so the share is a
   **lower bound** (下限) and the page says so. No repo mounted → the commit columns in 按人 / 按仓库 show 待接入.
6. **按人 (cost and commits per person).** `reports/team.json` `identities`
   (`{"<email | GitHub login>": "<human_id>"}`, case-insensitive; a `members` entry also matches)
   maps each person key (a key named by an email) and each commit author (email, or the login in a
   GitHub noreply email) to a `human_id`. A key that is not an email is a service key: it stays under
   its file team only. Persons are in name order, never ranked. A person's cost is not split by repo:
   cost and commits sit side by side. Unmapped commit authors are **listed** under 未映射 — add them to
   `identities` and import again. Unmapped person keys are **counted** (number + cost), not named: most
   belong to persons outside the repos read, and their cost stays in the team table. No `identities`
   (or only the `<...>` placeholders of the starter roster) → 按人 shows 待接入.
7. **AI 使用 / 交付 / 价值 (#361).** The same run reads the reports repo as it is (no format change):
   - **Weeks:** a week counts in the month of its **Sunday** (its end date), so a week that crosses a
     month boundary counts in one month only. Broken or wrong-week files are printed as 未纳入 in the
     terminal and kept in `month.json`; the page does not list them.
   - **AI 使用:** requests, tokens, tokens by repo / project, tokens by person (name order, no
     ranking, no sort control), by model and by agent, plus reusable
     methods, issues and quota needs from the narratives. `month.json` keeps the price-table **估算**
     (never added to the allocation amounts); the page does not show it.
   - **交付:** deliverables with evidence (the same evidence counts once) and the count of tasks
     without evidence. The weekly commit count is not shown: `git_stats()` counts every author in
     the repo. Commits come from git only (按人 / 按仓库).
   - **价值:** resource requests created in the month (with the expected outcome), renewal reviews
     made in the month (with the verdict), and requests due for review within 30 days.
   - **Coverage** in each section: persons who submitted, persons in the cost file (mapped through
     `identities`), and the share of the month's real cost that the submitters cover.
   - No submission in the month → AI 使用 and 交付 show 待接入; no `reports/requests/` → 价值 shows 待接入.
   - **尚未接入 (#22):** `month.json` keeps `not_connected`, the parts of #22 with no data source yet
     (quality metrics, Bug Bash, the #26 value hypothesis, AI maturity reason codes). The page does not
     list them: a missing source shows 待接入 in its own cell, never 0.
8. **Layout, views and sorting (#362).** The HTML page opens on **全部**: four cards for the parts of
   #22 side by side (成本 / AI 使用 / 交付 / 价值, each 待接入 without a source), then one section per
   question: **按人** (one table: weekly tokens and requests next to git commits, AI share and reverts),
   **按仓库** (one table: the same columns by repo, plus who used it; `other` = sessions outside this
   workspace), **成本** (total, checks count, real cost by team), **交付与价值** (deliverables and
   requests as short lists), **各月** (every imported month in one table, oldest first, so the trend
   shows from the second month) and **详情** (folded: 校验, models / agents, narrative lists,
   real cost by person, 未映射). The menu filters
   to one section. The page shows **no 估算**: the estimate stays in `month.json` only. A check that
   fails is shown in 成本 and at the top. Only the repo table sorts (click a column header). The
   person, team, month and detail tables have **no sort control** and stay in name order — the page itself
   does not rank persons or teams (#22 非目标). Without script every section shows. Still one
   self-contained file; the markdown has the same sections in the same order.
9. The lead commits / pushes the month through the normal flow; the tool never does.

## Phase 3: Interpret

- Tie every sentence to a number from the report; cite the section (KPI, 每日趋势, 模型分布,
  按人, 按项目).
- Anomalies (one repo dominating, a cache-hit collapse, a cost spike on one day) get a
  **checkable hypothesis** ("值得核查……"), never a verdict about a person.
- Always say 估算 next to a dollar figure and name the pricing table version.

## Boundaries

- No ranking, no per-person budget: 不按费用排序, no "top spender". 预算余额展示在本 skill (the
  team page's 月度预算状态, from `reports/budget.json` + the month's bills), but the bills
  themselves and the reconciliation remain Infra's (the guide's billing chapter). The budget
  tiers are a warning to support decisions, never a review input: 预警用于支持决策,不做考核.
- One week per run; cross-week trends are out of scope for now. `month` is one calendar month per run.
- Platform export and local log are both **usage**; only a bill writes `cost.actual`. A platform
  cost column is 待核实, never treated as paid.
- Never pushes, never uploads, never calls a network service; `--commit` is local only. A
  request is a draft: no approval, no purchase, no approver named.
- Everything privacy-related is inherited from `skill:token-usage-analysis` — the submission
  never contains prompts, file paths, or session ids, and the narrative is what the operator
  confirmed, nothing scraped from transcripts.
- Field meanings, the three cost blocks, the `quality` block, the six checks, and which report
  section comes from which field: `references/report-contract.md`. Reports-repo starter files
  (roster, re-render script, `team-report.yml`): `assets/reports-repo/`.
- The plan this skill implements — 《AI 投入与成果 · 周报与资源申请方案》预览 v1.0 (2026-09-16,
  olaola-projects/ai-native-issues#192) — is kept verbatim as `references/spec-preview.html`
  (self-contained, open in a browser). It is the spec, not the output: the rendered personal / team
  pages come from `scripts/ai-usage-weekly`, and where they differ the contract wins.
