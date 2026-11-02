# dive-contract — INSPECT.md in, rca.md + report.json out

## INSPECT.md (written by `run dive`; read by whichever agent investigates)

1. Header: incident id, alert (RID, rule name, uid, layer, subject, source), fingerprint, tenant.
2. **Injected time facts**: evaluation epoch (+ local + UTC), evaluation window, the query window
   as seconds and milliseconds, RFC3339 strings for `query_prometheus`. Computed by `lib/window.py`.
3. Labels / annotations / generator link of the alert.
4. The routed triage template (`triage/<file>`) with placeholders filled (`triage/README.md`).
5. Requirements (ported from the reference's `buildDiveAsk`): verify first; layers L1→L7; which
   tool for which layer; data-backed vs hypotheses; anchor check on zero rows; L7 only from the
   table; dependency/infra ≠ code defect; undetermined is valid; read-only.
6. **L7 change surface**: deploy table (`repo@sha`, completed time, title) or "未接入".
7. Output contract (below) with the `finish` command.

## rca.md (agent-written)

Conclusion · verdict basis · evidence list (tool, query, window each) · data-backed findings vs
hypotheses, each with confidence · impact magnitude · suggested action. Queries and field names
in backticks; no raw rows with user identifiers.

## report.json v1.1 (skeleton by `run dive`, filled by the agent, sealed by `run finish`)

Same shape the reference produces and `suites/sre-autofix/docs/input-contract.md` consumes.
Filled by code: `report_version`, `scenario`, `trigger`, `generator`, `incident{id, fingerprint,
rule_uid, rid, rule_name, layer, subject, title, eval_epoch, occurrences, archive_dir}`, `attachments`,
`tenant`. Filled by the agent:

| Field | Meaning | Checked by `finish` |
|---|---|---|
| `verdict.value` | `PASS` (alert false / known pattern) · `FAIL` (anomaly real) · `INDETERMINATE` | required; PASS needs `verdict.summary` |
| `verdict.template`, `verdict.known_pattern[]`, `verdict.mentioned_patterns[]` | which template; KP ids hit / mentioned | — |
| `root_cause.statement` | one paragraph; "未定因 + what is missing" when undetermined | required for FAIL, ≥ 20 chars |
| `root_cause.chain[]` | mechanism steps | — |
| `root_cause.confidence` + `confidence_basis` | `low\|medium\|high` and why | required for FAIL |
| `root_cause.cause_locus` + `cause_locus_basis` | `code_defect\|infra\|dependency\|config\|unknown` — would the code still fail with dependencies behaving per contract? | required for FAIL; basis required for `code_defect` |
| `root_cause.severity` + basis, `impact{scope, magnitude, time_window}`, `repro{conditions, frequency}` | for the reader and the PR body | severity enum |
| `root_cause.suggested_fix` | mechanism + acceptance target, never an implementation | — |
| `evidence[]{claim, tool, query, time_window, ref}` | one row per fact | each needs `claim` + `tool` |
| `excluded_hypotheses[]`, `data_gaps[]`, `data_sources[]` | what was ruled out; what is missing; `sls:<project>/<logstore>`, `prometheus:<ds>`, `grafana-alerting` | lists |
| `suspect_change` | `repo@sha` from the L7 table, else `none` | shape |
| `duplicate_of` | previous incident id when the ledger marked a recurrence, else `none` | — |

`finish` then: validates; scrubs (`suites/sre-autofix/lib/scrub.py` — PII redacted in place, any
secret → `scrub.egress_blocked=true` and exit 5); sets `status.state` (`FALSE_POSITIVE` for PASS,
`ROOT_CAUSED` for FAIL with a cause, `INVESTIGATING` otherwise); closes the ledger entry on PASS;
prints the `/sre-autofix` claim command when `cause_locus=code_defect` and confidence ≥ medium.
