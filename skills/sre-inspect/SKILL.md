---
name: sre-inspect
description: Drive suites/sre-inspect — the LOCAL form of Agentic SRE's inspection half — to turn a production alert from the department Grafana into a verified, root-caused report.json (v1.1) on this machine, verb by verb (doctor → intake → dive → investigate → finish), with the human choosing what to dig into. Use when the user says "排查这个告警", "深挖一下这条告警", "看看今天的告警", "巡检", "run the SRE inspect", "triage this alert", "what fired in the last hours", "intake", points at a Grafana alert / rule uid / firing time, or wants a report that suites/sre-autofix can consume. The investigation itself is done by the same session (Claude Code / Codex) with mcp-grafana for metrics and skills/grafana-sls for logs, or optionally handed to a local HolmesGPT.
id: skill:sre-inspect
type: skill
owner: EricZhang
version: "9e83219ae2c7d76c80b16e5a7adbb1fb122661da"
status: draft
summary: Operator/agent driver for suites/sre-inspect — the verbs, the investigation discipline ported from the reference engine, the report contract, and what it must never do.
use_when: A production alert (or a time window of alerts) on the department Grafana needs verification and a root cause, and the result should be a local report.json that /sre-autofix can pick up.
usage: Bundled under skills/; run from the workspace root; each verb is `suites/sre-inspect/run <verb> …` (contract in suites/sre-inspect/SUITE.md, operator path in suites/sre-inspect/docs/quickstart.md).
dependencies: ["skill:grafana-sls"]
regression: ["regression-case:sre-inspect-smoke"]
---

# SRE Inspect (local investigation driver)

You drive the **local form of the Agentic SRE inspection leg**: Grafana alerts → a deterministic
funnel → one brief per incident → **you** verify and dig, on the department's single Grafana data
plane → `report.json` v1.1 in `runs/sre-inspect/<INC>/`. The reference implementation (a
centralised, unattended service) is not what you run — its *contracts* are. You never re-implement
a verb: every step is one `suites/sre-inspect/run <verb>` call; the suite computes every time
window and you never do time-zone arithmetic.

## 0. Preflight

1. Be at the workspace root. Read `suites/sre-inspect/SUITE.md` once; `docs/quickstart.md` is the
   operator path.
2. `suites/sre-inspect/run doctor`. Any `[MISS]` row → stop and show it. Missing `tenant.yaml` /
   `routes.yaml` / `env/.env.holmes` are the operator's to create from the `.example` files — never
   write a token yourself, never ask for one in chat.
3. Metrics need the mcp-grafana MCP server in this session (`run mcp-config` prints the
   `.mcp.json` / Codex snippet). Without it you still have logs (skill `grafana-sls`) and alert
   rules through the Grafana HTTP API; say so in `data_gaps`.

## 1. Verbs, in order

| Step | Command | Human decides | Then |
|---|---|---|---|
| intake | `suites/sre-inspect/run intake [--since 24h \| --from … --to …]` | which candidate to dig (show the digest verbatim **including its 读法 block** — clusters and re-fires are computed by the suite, do not re-derive them; `unrouted` items need a `routes.yaml` entry + triage template first — propose one, do not invent a verdict) | exit 3 = nothing new (legal) |
| dive | `suites/sre-inspect/run dive <n>` — for a historical alert, rerun `intake --from … --to …` first and still dive by number; the manual `--rule-uid … --at …` form is only for alerts beyond history retention (values from an archived queue item's `alert.rule_uid`/`eval_epoch`, or `alerting_manage_rules operation=list`) | nothing | read `runs/sre-inspect/<INC>/INSPECT.md` — it is the brief |
| investigate | **you**, in this session, following INSPECT.md | steer as you go | see §2 |
| finish | `suites/sre-inspect/run finish <INC>` | reads the verdict | exit 4 = contract violated (fix the report), exit 5 = a secret was in the text (remove it) |
| handoff | `suites/sre-autofix/run claim runs/sre-inspect/<INC>/report.json` | only if `cause_locus=code_defect` and confidence ≥ medium | the fix leg is a separate skill (`/sre-autofix`) |

**Recommending a candidate — facts, not inference.** `run dive` queries a window of the alert's
evaluation instant **−15m/+15m** by default (`--before/--after` widen it). Therefore: for a cluster
(several candidates within the same minute — one underlying event) recommend a **member of the
cluster**, normally the first; a later same-fingerprint re-fire does **not** cover the cluster's
instant and is handled after the first as a recurrence (`duplicate_of`). Never claim that one
item's window "covers" another's unless the digest's 读法 block says so.

`dive` registers the incident in the ledger: the same fingerprint within the cooldown window is
folded (exit 3) unless `--force`; a recurrence after a closed incident is marked and points at it.

## 2. Investigation discipline (from INSPECT.md; do not shortcut)

1. **Verify before digging**: walk the triage template; conclude PASS / FAIL / INDETERMINATE with
   evidence. PASS (alert false, or a known pattern with normal magnitude) still gets a written
   verdict and `finish`.
2. **Time facts are injected** — use the `from/to` epochs and RFC3339 strings in the brief; extend
   by adding seconds to epochs, never by "last N minutes".
3. **Zero rows → anchor check first** (`* | select count(*)` on the same window / `up` on the same
   datasource). Zero is a window error until proven otherwise.
4. **Layers in order** L1 domain/CDN → L2 ingress → L3 queue → L4 data → L5 host → L6 process →
   L7 change; each step: what to verify, which datasource, then the result. Metrics: `query_prometheus`
   (`datasourceUid` from `list_datasources`; `endTime` is required even for instant); rule definition
   and state: `alerting_manage_rules` with `operation=get`, `rule_uid` from the brief; mature PromQL:
   `get_dashboard_panel_queries`. Logs: skill `grafana-sls`.
5. **Data-backed conclusions and inferred hypotheses in separate sections**, each with confidence.
   A mechanism without a metric/log behind it is a hypothesis, not a conclusion.
6. **L7 from the brief only** (the deploy table); `suspect_change` must be a `repo@sha` from that
   table or `none`. Dependency / infrastructure failures (DNS blips, a rolling reload killing
   in-flight connections, a downstream outage) are `cause_locus: infra|dependency`, not
   `code_defect` — the fix leg's reviewers reject "catch the exception and return 200".
7. **Undetermined is a valid outcome**: write "未定因", list what data would decide it in
   `data_gaps`, do not invent a mechanism.
8. **One incident per dive.** Other clusters, re-fires and patterns you notice on the way go into a
   `## 后续项` list at the end of rca.md (one line each, with the one fact that justifies it) — do
   **not** run queries for them; each becomes its own `dive`. If the evidence has not converged after
   roughly 40 tool calls, stop, write 未定因 + `data_gaps`, and `finish` — exhaustive exploration is
   not the goal, a decidable report is.

## 3. Writing the result

- `rca.md`: conclusion / verdict basis / evidence (tool, query, window per item) / data-backed vs
  hypotheses / confidence / impact magnitude / suggested action. Cite queries; do not paste rows that
  carry user identifiers — aggregate or reference the query.
- `report.json`: the skeleton is already there with the incident block filled. Fill `verdict`,
  `root_cause` (`statement`, `chain`, `confidence` + basis, `cause_locus` + basis, `severity`,
  `impact`, `suggested_fix` as mechanism + acceptance target, not code), `evidence[]`
  (`claim/tool/query/time_window`), `excluded_hypotheses[]`, `data_gaps[]`, `data_sources[]`
  (`sls:<project>/<logstore>`, `prometheus:<datasource>`, `grafana-alerting`), `suspect_change`.
  Field meaning: `suites/sre-inspect/docs/dive-contract.md` and `suites/sre-autofix/docs/input-contract.md`.
- Then `run finish`. It validates, scrubs (PII redacted, secrets block), and records the ledger.

## 4. Optional: local HolmesGPT

`run dive <n> --holmes` hands the same brief to a HolmesGPT container from
`suites/sre-inspect/holmes/docker-compose.yaml` (its data plane is the same sidecar + script) and
stores the answer as `holmes.md`. You still own `rca.md` / `report.json` and `finish`. Long dives:
start it detached; a foreground timeout kills the dive midway.

## 5. Configuring or extending the tenant (self-serve — the operator should never need raw API calls)

Triggers: `run validate` / `run doctor` reports a missing or mismatched value; the digest lists
`unrouted` rules; the L7 table says "未接入" or misses a release you know happened; the operator says
"帮我配 tenant.yaml", "把 X 仓加进 deploys", "给这条规则补路由", "选一下数据源".

| Need | Run | Then |
|---|---|---|
| which datasources exist / exact names | `suites/sre-inspect/run discover datasources` | propose `grafana.datasources.logs/metrics` entries (`datasource:` = the exact name; SLS entries also `project` + `logstore` from the table) |
| rule uids, which are routed, which datasource a rule queries | `suites/sre-inspect/run discover rules` | for unrouted rules paste the printed `routes.yaml` stanzas and fill `rid` / `layer` / `template` **with the operator** (those are judgements); draft the template from `triage/_template.md` |
| the deploy workflow of a repo (L7 change surface) | `suites/sre-inspect/run discover deploys <owner/repo>` | append the printed `deploys:` lines; every repo whose build can land on the alerted hosts must be listed |
| anything the validator names | read the message — it names the field and lists the configured values verbatim | fix the field, rerun `run validate` |

Rules of the game: propose the edit as a diff and apply it only after the operator agrees; edit
`tenant.yaml` / `routes.yaml` / `triage/*.md` (or their `.local` twins on a template checkout) —
**never** `env/.env.holmes`; never invent a uid, a datasource name or a workflow name — every value
comes from a `discover` table; finish with `run validate` (and `run doctor` when Grafana-facing
values changed).

## 6. Never

- Change anything in production, silence an alert, or write to Grafana; every tool here is read-only.
- Put a token in chat, a file, a command line, or a report.
- Do time-zone arithmetic, or trust a zero-row result before the anchor check.
- Invent a mechanism, a field name, or a route; `unrouted` → propose a `routes.yaml` entry and a
  triage template for the operator, then dive with `--force` only if they say so.
- Skip `finish`, or hand a report to `/sre-autofix` when `cause_locus` is not `code_defect`.
