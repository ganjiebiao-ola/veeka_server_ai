# intake — Grafana-native alert funnel

`run intake` replaces the reference's Slack collector + orchestrator intake with three read-only
Grafana calls and a deterministic funnel. Nothing here calls a model.

## Sources

| Call | Gives | Used for |
|---|---|---|
| `GET /api/alertmanager/grafana/api/v2/alerts` | instances firing **now**: labels (incl. `__alert_rule_uid__`), `fingerprint`, `startsAt`, `generatorURL`, rendered annotations (`summary`) | the exact alert the on-call channel shows, with Grafana's own fingerprint |
| `GET /api/annotations?type=alert&from&to` | every state transition in the window (`newState` Alerting / Pending / Normal …), rule **title**, labels in `text` | history: what fired earlier in the window and has already resolved |
| `GET /api/v1/provisioning/alert-rules` | rule uid ↔ title ↔ folder | title → uid for annotation-derived alerts; a title used by two rules is reported as `unrouted` with both uids |
| (`GET /api/v1/rules/history?ruleUID`) | per-rule state history frame | available in `lib/grafana.py` for deeper checks |

Why not Slack: the on-call channel is the notification policy's projection of the same alerts —
one long-firing instance is re-notified on `repeat_interval` (111 messages in one day for one
instance in the reference's data), rules routed elsewhere never appear, grouping merges instances.
Grafana is the superset and needs no pairing regexes.

## Funnel

1. **normalise** → `alert{fingerprint, rule_uid, rule_name, title, subject, eval_epoch, labels, source}`;
   `subject` = first present of `alert_source.subject_labels`; annotation alerts with the same
   (rule, subject) as a firing alert adopt its Grafana fingerprint; duplicates on
   (rule, subject, second) collapse.
2. **filter** (`alert_source.filter`): `include_labels` must match, `exclude_labels` drop. Mirror
   the notification policy (`run intake --print-policy` prints it) — e.g. drop `severity=info`.
3. **route** (`routes.yaml`): `triage` (has a template) · `known_bug` (deterministic match → no
   model) · `unrouted` (not in the table, or no template, or ambiguous title) — listed, never dropped.
4. **ledger** (`runs/sre-inspect/ledger.json`, port of the reference suppressor): same fingerprint
   while an incident is open and within `cooldown` → suppressed (folded); after close and within
   `recurrence` → marked recurrence of the previous incident; else new. `intake` only *peeks*;
   `dive` registers; `finish` closes on PASS.
5. **queue + digest**: `runs/sre-inspect/queue/latest.json` and a human digest — candidates first.

## Deploy facts

`tenant.yaml deploys[{repo, workflow}]` → `run dive` asks GitHub Actions (through the operator's own
`gh`) for successful runs of that workflow completed within `[from − deploy_lookback, to]` and
injects them as the L7 table in INSPECT.md. `suspect_change` in the report may only reference a row
of that table. Not configured → the brief says "L7 未接入". This is an input to a dive, never a
trigger: the reference's post-deploy sweeps ran 8 times with zero findings, while its deep-dives
reached real deploy-caused causes twice only because the deploy facts were present.

## Acceptance used while building (reference data, 2026-08-27)

Slack bodies ↔ Grafana state history for one day: API 5XX 8 = 8, NSQ 2 = 2; ECS Memory 111 Slack
repeats = 1 firing instance since five days earlier; two info-level rules present in Grafana never
reached the channel. The funnel's routed set on that day is a superset of the reference's 13 new
incidents; the extra items are the unrouted/info rules the reference never saw.
