# Report contract — ai-usage-weekly (#22)

What each field of a personal submission means, how the cost estimate is computed, and which
section of the team report is built from which field. The machine-readable shape is
`platform-internals/schemas/ai-usage-submission.schema.json`.

## Submission file `reports/<week>/<human_id>.json`

| Block | Field | Source | Meaning |
|---|---|---|---|
| `meta` | `schema_version` | constant `2` | v1 files (`estimated_usd`, no `quality`) are read by `team` for compatibility, never written |
| | `week` / `since` / `until` | `--week` (ISO week, Mon–Sun) or `--since/--until` | The reporting window; `until` is inclusive |
| | `timezone` | `--timezone` or this machine's | The zone the week boundaries are stated in (team fixes one; T4 checks agreement) |
| | `human_id` / `team` / `business` | `workspace.yaml` `owner` / `team` / `business` | Who, which team, which 业务/职能 (`null` until filled); no agent identity |
| | `submission_version` | 1, +1 per re-submit of the same week | A re-submit replaces the record (never appends) |
| | `workspace_sha` | `git rev-parse HEAD` of the workspace | Artifact provenance (`rules/review.md`) |
| | `base_source` | `token-usage-report` `meta.base_source` | `ccusage` / `native` / `native(fallback)` |
| `usage` | `requests` | Claude `totals.messages` + Codex `totals.sessions` | Assistant turns (Claude) + active sessions in the window (Codex); one Codex session may appear in both weeks it spans |
| | `input` / `output` / `cache_read` / `cache_creation` | Claude totals + Codex totals split so nothing overlaps: Codex `cached_input` is a **subset** of its `input` (collector `total_tokens` = input + output), so `input − cached_input` → `input`, `cached_input` → `cache_read` (#203) | Token counts; 总吞吐 = input + output + cache_read + cache_creation adds each token once (`by_agent.codex` keeps the raw overlapping collector totals for audit) |
| | `cache_hit_rate` | `cache_read / (input + cache_read + cache_creation)` over Claude only | `null` without Claude data |
| | `sessions` / `task_instances` | Claude `sessions.count`; rows of `token-usage-tasks --json` | Session and instance counts |
| | `by_day` | Claude `cells` rolled up by day | Codex has no daily granularity — its tokens/cost are **not** in `by_day` (stated in `cost.note`) |
| | `by_model` | Claude `cells` rolled up by model | Codex sessions carry no model; they appear as `codex` |
| | `by_bucket` | Claude `cells` + Codex `by_bucket` (+ `platform` for export rows) | Mounted-repo id, `workspace`, the anonymous `other`, or `platform` (never attributed to a repo); `inferred` marks worktree attribution |
| | `by_agent.qoder` | `token-usage-report` `qoder` (#531) | Qoder logs **credits, no tokens**: `messages`, `credits`, `sessions`, `by_day` and `by_bucket` (messages + credits). Credits are never converted to tokens and are **not** in `requests`, the token fields, `by_day`, `by_model`, `by_bucket` or `cost.estimated`; `confirmed: false` (log credits are not checked against the bill). `null` when there is no Qoder use. A day with only Qoder use counts as a day with records |
| | `sources[]` / `cells[]` | see § Sources | per-source coverage + bookkeeping; post-dedup cells (aggregates only) |
| `cost` | `estimated` | Σ over priced models of `tokens × price`; `source: local-usage-log`, `confirmed: false` | **估算,非账单** — always shown with 估算 + `pricing_version`; `amount` `null` when nothing could be priced; `unpriced_models` listed, never guessed |
| | `actual` | `--cost-file` `actual` (bill / ledger; T2 fills from bills) | What was really paid; `nature` api / seat / gpu / shared, `currency`, `period`, `confirmed`. `null` → 待核实, never 0. `--bill` also writes `items[]` — one `{source, amount, nature, period}` per bill row (amounts add up to `amount`), so a single bill can be matched and month-intersected later; the merged `source` string stays for display |
| | `allocated` | `--cost-file` `allocated` | This person's / week's share of an actual cost, with `basis` (service period, project use, confirmed ratio). `null` → 待核实. `items[]` as for `actual`, each `amount` being that bill's share of the week and `period` the bill's own service period |
| `quality` | `missing_sources` | program: `platform-export` always until T2; `actual-bill` without `--cost-file`; `git` without git data | Shown as 待接入 / 待核实, never as 0 |
| | `unpriced_models` | = `cost.estimated.unpriced_models` | 未定价 list for the checks page |
| | `shared_costs` / `allocation` | `--cost-file` | Shared resources not attributed to the account holder alone; project split whose ratios must sum to 100 (tool exits 2 otherwise) |
| | `confirmed_by` | `member` = `human_id` once `--narrative` given; `billing` / `attribution` from `--cost-file` | Three confirmations by three roles, kept apart |
| `git` | per bucket | `token-usage-report` `git` | commits / insertions / deletions in the window |
| `narrative` | see `assets/narrative.example.json` | AI-drafted, operator-confirmed | `null` until the person adds it (md shows 待补); tasks may carry `ai_role` / `deliverable` / `status`; `resource_needs[]` feeds T6 |

## Sources (T2 #196): platform export, local log, bill

| Source | Flag | Becomes | Rules |
|---|---|---|---|
| Local usage log (Claude / Codex / Qoder JSONL) | default | cells (day × bucket × model), `source: local-usage-log` | each message on the day of its own event time in `meta.timezone` (the collectors run with `TZ` set to it), so a Sunday-23:30 → Monday-00:30 session lands in two weeks; streamed duplicates keep-max; cache sub-fields are separate columns and never added twice |
| Platform export (CSV / XLSX) | `--platform-export` (repeatable) | cells in bucket `platform`, `source: platform-export` | columns via `assets/platform-export.mapping.json` (aliases + `ignore`); an unknown column → exit 2 naming it; rows of other users skipped; a cost column → `sources[].reported_cost` (性质待核实), never `cost.actual` |
| Bill / ledger (CSV / JSON) | `--bill` | `cost.actual` (Σ bills, one currency) + `cost.allocated` (Σ amount × overlap-days / period-days, `basis` explains) | nature ∈ api / seat / gpu / shared (mixed → shared); unknown currency / nature / mixed currencies → exit 2; `confirmed` only if every row is |

**择一计入 (dedup):** a (day, model) the platform reports replaces every local cell for it; the count
of replaced (day, model) pairs is `usage.sources[local-usage-log].superseded`. A (day, model) only one
side has is counted from that side. Sources that were not given are listed in `quality.missing_sources`
and rendered 待接入 / 待核实 — never 0. Different machines' local logs are deduped by the collectors'
message keys. `usage.cells` carries the post-dedup cells so the team side can dedup at the same grain.

Multiple `--platform-export` files use the same rule in `submit` and `team`: for each member,
later files replace earlier (day, model) cells; non-overlapping cells survive. Re-importing the same
CSV/XLSX never doubles usage. Source `records` is the retained cell count; `overlapping_exports` counts
replacements. Each original export's metadata and reported cost remain in `sources[].exports`; their
overlapping file-level amounts are not summed or presented as the combined export's cost.

Codex windows use differences between successive `token_count.total_token_usage` snapshots at the
event's own timestamp in the declared timezone, including counters before the window as the baseline.
Old/resumed files are not filtered by their creation date. Identical snapshots add no usage; resets
start a new counter epoch. Undated snapshots update the baseline but are not assigned to a date.
The output remains a window/session aggregate; it does not add Codex daily/model detail to the charts.

**Team side (`team --platform-export`):** the lead's whole-team export; user → `human_id` via
`reports/team.json` `platform_ids`. A member with a file and `cells` is merged at (day, model) grain
(platform wins; `by_bucket` stays the person's own attribution reference); a v1 file without cells has
its usage replaced wholesale (noted). A member without a file becomes a usage-only row (仅平台用量,
叙事待提交) and still counts as 未提交. `cost.estimated.source` says which cells the estimate came from —
it is an estimate either way.

## Three amounts (三种金额) — side by side, never summed

| Block | Is | Enters 核算/报销? | Enters budget totals (T5)? |
|---|---|---|---|
| `estimated` | local usage log × price table — **an estimate** | no | no |
| `actual` | the bill / ledger | yes | yes |
| `allocated` | share of an actual cost for this person / week | yes (as the share) | yes |

They are three columns of one table, not addends. The example from the 方案: subscription paid $200,
API-equivalent estimate $800 → both shown, never $1000.

## Cost method (估算)

`cost = input×p.input + output×p.output + cache_read×p.cache_read + cache_creation×p.cache_creation`,
prices per 1M tokens from `assets/pricing.json` (`--pricing` overrides). Model lookup: exact id →
id with its trailing date suffix (`-YYYYMMDD`) stripped → longest key that is a prefix of the id.
Codex uses `codex.default` (`input` / `cached_input` / `output`; reasoning tokens are output) as
`(input − cached_input)×p.input + cached_input×p.cached_input + output×p.output` — the cached part is priced
once, never also at the input rate; while it is `null` Codex is listed in `unpriced_models` and contributes
tokens but no dollars.
Qoder credits have no price in the table: the estimate never includes them, and `cost.estimated.note` says so.
The team report labels every estimate 估算 and the pricing table version; a non-zero estimate is never
printed as `$0.00` (small values get four decimals) so that "0" always means "no data, see 缺失来源".

## Personal page (T3 #197): `<human_id>.html` + `.md` from one dict

Both files are rendered from the submission dict `submit` just validated — the html never recomputes a
number the md does not have. Sections: header (team / 业务 / 周期 + timezone / 提交版本 / ws-sha) · KPI ×5
(请求数 / Token 总吞吐 + 缓存命中率 / **估算费用** (估算 · 价格表版本 · 非账单) / **实际费用** (or 账单待核实)
/ 核心项目) · 三种金额 table · 每日请求 + 每日估算费用 (single-series bars) + 模型分布 (donut) · 数据来源 ·
按项目 · 主要工作与交付 (narrative: summary, project cards with evidence or 证据待确认, 待跟进 / 风险, 值得复用
/ 失败 / 问题 / 资源需求, 建议跟进) · 质量与归属 · 金额与来源明细 (by_day) · **提交前需要补齐** · footer.

### 提交前需要补齐 (`checklist()`, program-made, each item → the field to fix)

| Item | Trigger | Field |
|---|---|---|
| 本周金额为本机估算,账单待核实 | `cost.actual` is `null` | `cost.actual` |
| 实际费用未经账单负责人确认 | `cost.actual.confirmed` false | `cost.actual.confirmed` |
| 有实际费用但无分摊 | `actual` given, `allocated` null | `cost.allocated` |
| 未定价模型 | `cost.estimated.unpriced_models` non-empty | `cost.estimated.unpriced_models` |
| 来源缺失 | each of `quality.missing_sources` | `quality.missing_sources` |
| 周内 N 天无记录 | days of the window absent from `usage.by_day` | `usage.by_day` |
| 分摊比例 ≠ 100 | Σ `quality.allocation.ratio` ≠ 100 | `quality.allocation` |
| 叙事待补 | `narrative` null | `narrative` |
| 证据待确认 | a task without `evidence` | `narrative.projects[i].tasks[j].evidence` |
| 时间/效率数字无测量依据 | that task's text has a number with %/倍/小时/分钟/天 | `…tasks[j].detail` |
| 项目价值含数字但任务缺证据 | `project.value` has such a number and a task lacks evidence | `narrative.projects[i].value` |
| 补可复用方法 / 失败 / 问题 | all three lists empty | `narrative.reusable_methods` |
| 成员确认状态为空 | narrative present but `confirmed_by.member` null | `quality.confirmed_by.member` |

## Resource request (T6 #200): `reports/requests/<yyyy-mm>-<human_id>-<slug>.json`

Schema `platform-internals/schemas/ai-resource-request.schema.json`. Written by `request --form`; the
`yyyy-mm` is the start month, the slug comes from `resource`. Form → fields 1:1 (kind / resource /
business / project / purpose / outcome / amount / currency / start / end / renewal / allocation / split /
note) plus program-filled `id`, `created_at`, `human_id` (workspace owner), `team`, `workspace_sha`, and the
closed loop: `status` (draft → confirmed → purchased → expired | rejected), `bill_refs[]` (bill source
strings, same as `cost.actual.source`), `review_before_renewal` (`null` or {verdict, reason, reviewed_by,
reviewed_at}). Validation exits 2 naming the field: required, end ≥ start, split = 100 when allocation is
split, currency ∈ mapping `currencies`. The `.md` draft ends with the fixed line 「按公司现行流程办理;购买或
续费前取得确认,保留账单与付款凭证」 and carries the three principles.

`request review <id>` → `reports/requests/<id>.review.md` (facts only): for each week overlapping
start..end, Σ over `cost.allocated` (else `cost.actual`) of the **`items[]` whose own `source` equals a
`bill_refs` string whole** (case-insensitive, trimmed — `invoice-1` never matches `invoice-10`; a merged
`a; b` source is split on `;` and each part compared whole; with no bill_refs the resource name is searched
as a substring, which is a name search, not "exact") — a Claude seat and a GPU invoice in one month's bill
never travel together (#203); a block without `items[]` (hand-written `--cost-file`, pre-#203 files) can
only be matched as a whole on its merged `source` and is flagged 未逐笔 in the row. Spend is kept **per
currency** (`100.00 USD + 700.00 CNY`), never added across currencies; the 预算比对 line compares only the
request's currency and lists the rest as 待换算. With no matching bill in the request's currency (including
no submissions or only foreign-currency bills), the comparison says 待核实, never `0.00`; an explicit
zero-amount bill still displays zero. Coverage in that comparison counts only weeks with a bill in the
request's currency. Then the requester's usage line and narrative tasks
mentioning the resource; the verdict stays with the human (`review_before_renewal`), the json is never edited.

Team page: 本周新申请 = requests whose `created_at` falls in the week; 待复评 = `renewal` ≠ once, status not
expired / rejected, `end` within 30 days after the week, `review_before_renewal` null. Broken request files
are listed as 未纳入, never dropped silently.

## Monthly budget (T5 #199): `reports/budget.json`

`{"<business>": {"monthly": <number>, "currency": "USD"}}`. The team's business comes from `team.json`
(else the single business the submissions share). Month = the one the report week's `until` falls in.
For every `reports/<week>/` whose window overlaps the month and ends by `until`, each valid submission
contributes: `cost.allocated.amount` → else `cost.actual.amount` if its period is inside the week → else
**待核实, not counted** (also when the currency differs from the budget's). Estimates never count.
A week that straddles the month boundary contributes only its in-month days (#203): with `allocated.items[]`
each item's share is scaled by `days(week ∩ bill period ∩ month) / days(week ∩ bill period)` — so a share
that already covers only 08-01..08-02 of a 07-27..08-02 week counts in full; without items (pre-#203 `--bill`
files, hand-written `--cost-file`) a single bill can use week ∩ `cost.actual.period` — never "even across
the week", which would prorate a 08-01..08-02 share a second time. A legacy merged source (`a; b`) only
retains the enclosing service period: if its in-week span crosses a month boundary, the monthly amount is
**待核实, not counted** until per-bill periods and allocated amounts are supplied in `items[]`. It is still
safe to count the full share when that span lies wholly inside one month. Missing service periods are also
待核实. This applies to the actual-only fallback as well. Pending members and reasons remain visible even
when no bill can be counted; no balance or forecast is invented. The week row says 跨月折算 a→b
(按账单服务期) so the scaling is visible.
累计 = Σ contributions; 余额 = monthly − 累计; 预测 = 累计 / elapsed-days × days-in-month (elapsed = days of
the month up to `until`); ratio rounded to 6 places, tier ≤1.0 正常 / ≤1.5 超出但 ≤1.5×(可从下月扣减) /
>1.5 预计超过 1.5×(需沟通并额外确认). No budget file, no row for the business, or no bill in the month →
「尚未提供」 with no numbers. The section always prints the guide's rule and 预警用于支持决策,不做考核.

## Team report sections → data

Input: every `reports/<week>/*.json` (except `team-report.*`). v2 files are validated strictly; a v1
file (`cost.estimated_usd`, no `quality`, no `timezone`) is accepted if its required keys exist and
is lifted to the v2 shape with `actual`/`allocated` = `null`, `timezone` = `null` (→ 周期一致 warns).
Every file's `meta.since` / `meta.until` must equal the requested ISO week's Monday / Sunday. A mismatched
or invalid date is quarantined under 未纳入 before usage or budget totals are computed; the reason shows
the actual and expected dates. Custom `submit --since/--until` windows remain readable as personal reports,
but only exact ISO-week windows can join a team report.
Anything else goes to 未纳入 with the reason and does not stop the run. People are sorted by
`human_id` — never by cost.

| Section | Built from |
|---|---|
| Header (team / week / generated / `ws-<sha6>` / 提交 n/m) | every `meta`; `reports/team.json` `members` when present, else 待接入 |
| Red banner | any check with status `fail` (rendering continues) |
| 管理摘要 | `--summary-file`; default is a machine sentence (people, requests, estimated total labelled 估算, top buckets, commits) |
| KPI ×6: 总请求 / 总 token (+缓存命中率) / **估算总费用** (估算 · pricing version · 非账单) / **实际费用确认情况** (n/m confirmed · Σ confirmed `actual` by currency) / 活跃项目 (+commits) / 团队覆盖 | Σ `usage`, Σ `cost.estimated.amount`, `cost.actual` per file, Σ `git`, roster |
| 每日请求 / 每日估算费用 (two single-series SVG bar charts, one axis each) | Σ `usage.by_day` |
| 模型分布 (SVG donut, fixed slot order by rank, >8 → 其他) | Σ `usage.by_model` by requests |
| 按成员 table (**name order**; 估算 / 实际 (+nature) / 分摊 as three columns; 确认 = member · billing · attribution) | one row per file |
| 按成员卡片 | `narrative.summary / projects / tasks` with `ai_role` / `deliverable` / `status` / `evidence` |
| 按项目 table + 交付物 | Σ `usage.by_bucket` + Σ `git` per bucket, people active in it; deliverables keyed by `project + evidence`, so one PR touched by two people is one row |
| 值得学习 / 效果不好的尝试 / 问题清单 / 资源需求 | concat of `narrative.reusable_methods / failed_experiments / issues / resource_needs`, attributed by name; then 本周新申请 / 待复评 from `reports/requests/` |
| 建议跟进 | concat of `narrative.next_actions`, high → mid → low, then name |
| 月度预算状态 | see § Monthly budget — bills only |
| 六项校验 table | see below |
| 未纳入 / 未提交 | files that failed validation (with reason); roster members without a file |
| Footer | cost method + pricing version(s), the 估算-not-a-bill sentence, data-source line |

### 六项校验 (program checks; `ok` / `warn` / `fail`)

| Check | Passes when | Status otherwise |
|---|---|---|
| 来源不重复 | one file per `human_id` (case-insensitive); platform-vs-local dedup arrives with T2 | fail |
| 周期一致 | `meta.week` and actual `since/until` match the requested Monday–Sunday ISO week, and all `timezone`s agree (and match `team.json` if set) | fail; `warn` when a v1 file has no timezone |
| 金额可解释 | every estimate has a pricing version; every `actual` / `allocated` has currency + nature | fail |
| 归属守恒 | each non-empty `quality.allocation` sums to 100 | fail |
| 缺失可见 | informational — prints 未提交 / 未纳入 / 缺账单 / 实际为零 as four separate counts | always ok (the point is visibility) |
| 成果有依据 | no narrative task lacks `evidence` | warn with the count |

`reports/team.json` is optional: `{"team": "<name>", "members": ["<human_id>", …], "timezone": "<IANA>", "business": "<…>"}`.

### Automation (assets/reports-repo/)

`scripts/team-report.sh <template-root> <reports-repo> <changed-path>…` parses `reports/<week>/` out of
each pushed path and runs `team` once per distinct week. Changes to `reports/team.json`,
`reports/budget.json`, or `reports/requests/*.json` (including deletions) refresh all existing weeks with
stored submission JSON, once each even when ordinary week paths occur in the same push. Empty directories
and platform-only pages without stored submissions cannot be rebuilt without their original export and
are skipped by the global refresh. `.github/workflows/team-report.yml` calls it
on every push to `reports/**` and commits `team-report.html/.md` back with the job's `GITHUB_TOKEN`
only — the template repo is read with that same token (public / same-org) or vendored under
`tools/template/`; no PAT, no team-wide key.

## Monthly cost report (#359 / #360): `reports/months/<YYYY-MM>/month.json`

`month --allocation <file.xlsx>` writes `month.json` + `month-report.md` +
`month-report.html` from one dict (`build_month()`); the md and html recompute nothing. A re-import
rewrites all three files whole, so the month is replaced, never added to. Paths under
`reports/months/` do not match the week pattern of `scripts/team-report.sh`, so the weekly automation
skips them.

| Field | Source | Meaning |
|---|---|---|
| `schema` | constant `ai-usage-month/1` | Record shape version |
| `month` | the file name (`month_from_filename()`) | Calendar month `YYYY-MM`; the name must state exactly one month (`september_2026`, `Sep 2026`, `2026-09`, `2026_9`, `202609`, `2026年9月`) |
| `currency` / `nature` | constants `USD` / `allocated` | Real cost, split by key in proportion to tokens — never the price-table estimate |
| `source` | file name, sha256, row counts of both sheets | Which file this month came from; a re-import prints the old sha256 |
| `generated_at` | clock | When the record was written |
| `workspace_sha` / `tool` | `git rev-parse HEAD` of the workspace | Provenance (`rules/review.md`): the full SHA (`null` outside git); `tool` is the short form shown on the page (`ws-<6 chars>`, or `ws-unknown`) |
| `total.cost_usd` | sum of `Real Spend` Cost (USD) | The month's real cost, `[Unallocated]` included |
| `total.file_total_usd` | sum of `Summary` Total Cost (USD) | What the file says the total is |
| `total.unallocated_usd` / `unallocated_rows` | `Real Spend` rows whose VK is in `allocation_unallocated_keys` | Cost no key carries; shown on its own line, in no team |
| `total.file_unallocated_usd` | sum of `Summary` Unallocated (USD), or `null` without that column | For the 未分摊一致 check |
| `checks[]` | see below | `{name, status ok/fail, report_usd, file_usd, detail}` |
| `teams[]` | `Real Spend` grouped by Team, `[Unallocated]` left out | `{team, cost_usd, tokens, keys}`; name order, case-insensitive — never by cost |
| `git` | `git log` of each repo read (#363) | `{date: "author", ai_rule, timezone, repos[]}`; each repo `{repo, ref, head, commits, ai_commits, reverts, authors}`, repos in name order. `null` → the commit columns show 待接入 (no repo mounted, or `--no-git`) |
| `people[]` | person keys + commit authors mapped through `reports/team.json` `identities` | `{human_id, teams[], keys, cost_usd, commits, ai_commits, reverts, repos{<repo>: {commits, ai_commits, reverts}}}`; name order. `cost_usd` is `null` for a person with no key; `commits` / `ai_commits` / `reverts` / `repos` are `null` (待接入, never 0) when no repo was read. `null` → 按人 待接入 (no `identities`) |
| `unmapped` | what `identities` does not cover | `{keys, keys_cost_usd, authors[{repo, name, email, commits}]}`: person keys are a count and a cost only; authors are listed. `null` when `people` is `null` |
| `intake` | `reports/<YYYY-Www>/` folders whose Sunday is in the month (#361) | `{weeks[{week, since, until}], submissions, rejected[{file, reason}]}` |
| `coverage` | submitters vs `people[]` | `{submitted[], cost_persons, submitted_with_cost, cost_covered_usd, cost_share}`; the cost fields are `null` without `identities`; `null` when no submission |
| `ai_use` | `aggregate()` over the month's submissions | `{estimate_note, requests, tokens, estimated_usd, pricing_versions, unpriced_models, by_repo[{repo, tokens, requests, people}] (no weekly commit count: `git_stats()` counts every author; commits come from `git`), by_person[{human_id, tokens, requests, weeks, repos}] (name order, no sort control), by_model[], by_agent[], methods[], issues[], resource_needs[]}`; `estimated_usd` is the price-table 估算. `null` → 待接入 |
| `delivery` | narrative tasks | `{deliverables[{project, title, evidence, status, people}], no_evidence}`; only tasks with evidence, one per evidence. `null` → 待接入 |
| `not_connected` | constant `NOT_CONNECTED` (#359 requirement 5) | `[{key, part, reason}]`: `quality`, `bug_bash`, `value_hypothesis`, `maturity` — parts of #22 with no data source yet; kept in `month.json` only, not shown on the page |
| `value` | `reports/requests/*.json` | `{new[], reviewed[], due[], rejected[]}`: created in the month / `review_before_renewal.reviewed_at` in the month / due within 30 days; each row has `outcome`, `verdict`, `verdict_reason`. `null` (no `reports/requests/`) → 待接入 |

No VK or key name is written: `keys` is a count only. Only `unmapped.authors` names a commit author
(name + email), so that the lead can add it to `identities`.

### Layout, views and sorting (#362)

The HTML and the markdown print the same blocks (`month_blocks()`), in this order: 按人, 按仓库, 成本,
交付与价值, 各月, 详情. The HTML adds four cards for the parts of #22 (成本 / AI 使用 / 交付 / 价值) on top and a
menu (全部 / 按人 / 按仓库 / 成本 / 交付与价值 / 各月 / 详情); each view is a `<section data-view>`, and without
script all sections show.

- **按人** joins `ai_use.by_person` and `people[]` on `human_id`: tokens and requests (`无周报` for a
  mapped person with no submission), commits, AI share and reverts (`未映射` for a submitter not in
  `identities`; 待接入 without `identities` or without git).
- **按仓库** joins `ai_use.by_repo` and `git.repos[]` on the repo name; `—` = that source has no row for
  the repo, 待接入 = the source is missing.
- **各月** is its own view: one table built from every `reports/months/*/month.json`
  (`month_history()`), oldest first.
- **详情** is one `<details>`: 校验 (shown in 成本 instead when a check fails), models / agents,
  narrative lists, real cost by person and 未映射. The git refs read (`git.repos[].ref` / `head`),
  `not_connected` and the files not read (`intake.rejected`, `value.rejected`) stay in `month.json`;
  the files not read are also printed as 未纳入 in the terminal. The fold label names only the parts
  that 详情 holds for that month.
- The page shows no 估算; `ai_use.estimated_usd` stays in `month.json`.
- Only the 按仓库 table carries `class="sortable"` and numeric `data-v` values; the person, team,
  month and detail tables never carry a sort control (#22 非目标).

### Git history and person mapping (#363)

- **Repos read:** every repo mounted under `<root>/repos/`, or each `--repo <path>`; `--no-git` reads none.
  A `--repo` that is not a git repo exits 2. Local git only: the tool never fetches, so pull first.
- **Branch:** `origin/HEAD` when the clone has it, else `HEAD`. `ref` and `head` (full SHA) record what was read.
- **Month:** a commit counts in the month of its author date, in the `reports/team.json` `timezone`
  (else this machine's). Merge commits are left out.
- **AI-assisted:** a `Co-Authored-By` trailer whose value names an AI tool (`AI_COAUTHOR_RX`: Claude,
  Anthropic, Codex, OpenAI, Copilot, Cursor, Gemini, Devin, Aider, Windsurf, Qwen). A human co-author does
  not count. AI work without the trailer is not seen, so the share is a lower bound (下限).
- **Revert:** the subject starts with `Revert ` or the body has `This reverts commit `.
- **`reports/team.json` `identities`:** `{"<email | GitHub login>": "<human_id>"}`, case-insensitive;
  a `members` entry also matches itself. A key is a person key when it is an email; other keys are
  service keys and stay under their file team only. An author matches by email, then by the login in a
  GitHub noreply email (`<id>+<login>@users.noreply.github.com`). Cost is never split by repo.
  Placeholder entries (`<...>`, as in the starter roster) map nobody; a roster with only placeholders
  counts as no `identities`.

### Checks (tolerance $0.01)

| Check | Passes when | Otherwise |
|---|---|---|
| 合计一致 | sum of `Real Spend` Cost (USD) = sum of `Summary` Total Cost (USD) | `fail`: WARN line + red alert on the page; the report is still written |
| 未分摊一致 | sum of the `[Unallocated]` rows = sum of `Summary` Unallocated (USD) (only when that column exists) | `fail`, as above |

### Allocation file format (`assets/platform-export.mapping.json`)

| Key | Holds |
|---|---|
| `allocation_sheets` | `{"spend": "Real Spend", "summary": "Summary"}` — sheets are found by name, not position |
| `allocation_columns` | aliases for `Real Spend`: `vk`, `team`, `provider`, `model`, `tokens`, `token_share`, `currency`, `original_cost`, `cost_usd` |
| `allocation_summary_columns` | aliases for `Summary`: `provider`, `model`, `currency`, `total_original`, `total_usd`, `allocated_usd`, `unallocated_usd`, `vk_count` |
| `allocation_ignore` | columns that are read past without use |
| `allocation_unallocated_keys` | VK values that mean "not allocated" (`[Unallocated]`) |

Column matching ignores case and extra spaces. Exit 2 (nothing written) on: a column in neither the
aliases nor `allocation_ignore` (named), a missing required column (`Real Spend`: vk, team, provider,
model, cost_usd; `Summary`: provider, model, total_usd), a missing sheet, an amount that is not a number
(sheet + row named), a currency outside `currencies`, an empty `Real Spend`, or a file name that states no
month or more than one month.
