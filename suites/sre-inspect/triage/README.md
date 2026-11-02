# triage/ — verification templates (the department's own)

One Markdown file per alert family, referenced from `routes.yaml` (`template:`). `run dive` renders
the routed template into `INSPECT.md` with the placeholders below filled **by code** — the model
never computes a time window itself.

| Placeholder | Value |
|---|---|
| `{{alert_title}}` | alert title (Grafana summary annotation or `<rule> <subject>`) |
| `{{alert_subject}}` | subject label value (instance / API path / topic …) |
| `{{alert_ts}}` | `YYYY-MM-DD HH:MM:SS（epoch N）` in the tenant time zone |
| `{{rule_uid}}` `{{rid}}` `{{rule_name}}` `{{layer}}` | from `routes.yaml` |
| `{{eval_epoch}}` `{{eval_local}}` `{{tz}}` | evaluation instant |
| `{{from_epoch}}` `{{to_epoch}}` | the injected query window (seconds) |
| `{{window_sec}}` | the rule's evaluation window when known, else empty |

Write the template as instructions to the investigating agent: what to verify, in which
datasource, what counts as PASS (alert is false / known pattern) vs FAIL (anomaly is real), and the
discipline lines (verify the window with an anchor query before concluding on zero rows; never
quote colon-keys through the Grafana SLS path; report `request_id`-style fields by reading raw
rows, not via SQL projection of un-indexed columns). `_template.md` is a neutral skeleton to start
from; the reference implementation's `checks/triage/*.md` are the worked examples of the shape
(they carry that project's nouns and stay in that project's own instance).
