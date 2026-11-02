# reference-implementation — what `oc-ai-pf/ola-sre-agent` is to this suite

The centralised service (four containers on one box: Slack collector, Go orchestrator, HolmesGPT,
observability MCP sidecar) produced 258 incident reports over four weeks and 9 fix PRs. It remains
the **reference implementation**: the place to read how a contract was arrived at, and what the
numbers were. This suite ports contracts, not code, and cites the reference by commit
(`9e83219`).

## Audit numbers that shaped the local form (reference archive, 2026-08-27/28)

| Question | Number | Decision |
|---|---|---|
| raw Slack records per day | 375 (309 bot, 15 edits, 51 human) → ≈150 alert body/Ack pairs → 99 suppressed → 13 incidents → 5 dives | manual picking from the channel is unrealistic → a deterministic intake is required locally |
| is the Slack channel a projection of Grafana alerting? | filtered projection: one firing instance re-notified 111×; two info-level rules never reach the channel; grouping merges instances | Grafana-native intake; `alert_source.filter` mirrors the policy |
| Go intake code reusable? | 1029 lines, of which parsing/pairing (Slack-specific) ≈ 730; suppressor 135 | funnel re-implemented in ≤ 200 lines of python; suppressor semantics and tests ported 1:1 |
| deploy-triggered sweeps | 8 runs: 7 PASS, 1 parse error, 0 findings | not ported |
| deploy facts inside dives | `suspect_change` set in 6/258; 2 of those reached a real deploy-caused root cause (rolling reload killing in-flight FastCGI; service-discovery lag after a port change); 9/9 fix PRs had `suspect_change=none` | ported as an *input* (GitHub Actions via `gh`), never a trigger |
| KP "release-window 502" | mentioned in 87 reports, formally hit in 0 | stays a triage-template concern of the department |

## Where the reference's pieces went

| Reference | Local form |
|---|---|
| `slack-alert-bot/` | — (Grafana APIs) |
| `orchestrator/internal/intake` (parse, pair, tail) | — ; `suppress.go` → `lib/ledger.py` |
| `orchestrator/internal/triage/route.go` (hard-coded map) | `routes.yaml` + `lib/intake.route` |
| `cmd/sre-orchestrator buildDiveAsk` / `renderRCA` | `lib/inspect_md.py`; `rca.md` written by the agent |
| `internal/report` (report.json v1.1) | `lib/report.py` skeleton + `finish` |
| `internal/egress` (scrub) | `suites/sre-autofix/lib/scrub.py` (already ported by #141), used by pointer |
| `cmd/sre-probe` (three assertions on the spill chain) | `run doctor` D1–D5 on the Grafana data plane |
| `toolset_guard_test.go` | `run validate` + `test` |
| `instance/config.yaml` + `docker-compose.yaml` (holmes + obs-mcp) | `holmes/config.yaml.example` + `holmes/docker-compose.yaml` (holmes + grafana-mcp) |
| `skills/sls-query` (methodology) + `aliyun_observable_mcp.llm_instructions` | `skills/grafana-sls` |
| `skills/sls-index-*` (generated) | department instance, generated offline |
| `checks/checks.yaml`, `checks/triage/*.md`, `checks/patterns/KP-*.md`, `signal-catalog/` | department instance (`triage/`, its own catalog) |
| schedule / notify / budget / patterns / fix leg / reconcile | not ported (the fix leg is `suites/sre-autofix`) |

## When to go back to the reference

- To read a worked triage template (`checks/triage/api-5xx.md`) before writing your own.
- To replay golden incidents (`evals/`) when changing the investigation discipline.
- If a department wants an unattended service again: the reference on the Grafana data plane is the
  starting point, and `tenant.yaml` here is the configuration it would read.
