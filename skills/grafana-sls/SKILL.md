---
name: grafana-sls
description: Query Aliyun SLS (Log Service) logs THROUGH the department Grafana with one service-account token — the search / SQL grammar that survives the Grafana SLS datasource plugin, datasource selection (one datasource per project+logstore), the epoch-only time discipline, result-size limits, and the error table (Grafana 401/403/404 vs SLS ParameterInvalid). Use whenever a task needs SLS log evidence and the workspace has suites/sre-inspect (run "suites/sre-inspect/run sls …" or tools/grafana-sls/sls_query.py), or when the user says "查 SLS 日志", "SLS 查询", "query the logs through Grafana", "sls_query", "写一条 SLS SQL", or a query came back with ParameterInvalid / incomplete logs / 0 rows. Also the skill HolmesGPT loads for its sre-inspect/grafana-sls toolset.
id: skill:grafana-sls
type: skill
owner: EricZhang
version: "9e83219ae2c7d76c80b16e5a7adbb1fb122661da"
status: draft
summary: How to write SLS search/SQL that works through Grafana's /api/ds/query, pick the right datasource, size results, and read errors — for Claude Code, Codex and HolmesGPT alike.
use_when: Any investigation needs log evidence from Aliyun SLS and the department's data plane is Grafana (suites/sre-inspect).
usage: Bundled under skills/; Claude Code/Codex run `suites/sre-inspect/run sls <subcommand> …` (env file auto-loaded) from the workspace root; HolmesGPT mounts this directory and calls the sre-inspect/grafana-sls toolset.
dependencies: []
regression: ["regression-case:grafana-sls-smoke"]
---

# grafana-sls — SLS log queries through the department Grafana

You reach Aliyun SLS only through Grafana (`POST /api/ds/query` against an
`aliyun-log-service-datasource`). One credential, one script, no cloud access key:

| You are | Call |
|---|---|
| Claude Code / Codex (Bash) | `suites/sre-inspect/run sls <datasources\|logstores\|query\|context> …` — loads `suites/sre-inspect/env/.env.holmes` for you |
| any shell with `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` exported | `python3 suites/sre-inspect/tools/grafana-sls/sls_query.py …` |
| HolmesGPT | tools `sls_list_datasources` / `sls_list_logstores` / `sls_query` / `sls_context` (same script) |

The script never truncates and never prints credentials. Every failure is one `error: …` line
with the upstream message verbatim — that line is what §4 keys on.

## 1. Pick the datasource first

`run sls datasources` lists every SLS datasource: **name / uid / project / default logstore**.
The plugin binds *project + logstore* at datasource level, so the common shape is **one
datasource per logstore** (`log_nginx_access`, `log_app`, …). Pass `--datasource <name or uid>`;
pass `--logstore <other>` only to query another logstore of the same project
(`run sls logstores --datasource <name>` lists them). The department's `tenant.yaml`
(`grafana.datasources.logs`) is the curated subset — prefer those names.

The first output line of every query is a header:
`# datasource=… uid=… project=… logstore=… from=<ms> to=<ms> rows=N truncated=true|false elapsed=…`
— quote project/logstore from it in your evidence (`sls:<project>/<logstore>`).

## 2. Time: only injected epochs

`--from` / `--to` accept epoch seconds, epoch milliseconds, RFC3339 or `now-30m`. In an
investigation use **the epochs injected in INSPECT.md / by `run window`**; never convert time
zones yourself and never write "last N minutes" into a query. A wrong window does not error — it
silently returns 0 rows. Zero rows → first run the anchor `* | select count(*) as c` on the same
window; if that is 0 too, the window or datasource is wrong, not the system.

## 3. Grammar that survives the Grafana path

**Search segment** (left of `|`; the only thing a pure search has):

- `key: "value"`, `key: value`, `and / or / not`, parentheses; numeric fields compare directly
  (`status >= 500`, `request_time > 3`); full-text `"phrase"` without a key.
- **A key containing `:` is NOT double-quoted on this path**: write
  `__tag__:__hostname__: "host-003"` — the quoted form `"__tag__:__hostname__": "host-003"`
  returns 0 rows through the plugin (measured; the opposite of the direct-API rule).
- No `in (…)`, `like`, `=` or single quotes in the search segment — those are SQL and produce
  `parse search query error`.
- Aliases are SQL-only; the search segment needs the real key. Only keys that exist in the
  logstore's index work: read the department's index-snapshot skill (`sls-index-*`) first;
  a key absent from the snapshot does not exist — do not guess "usual" nginx field names.

**SQL segment** (right of `|`):

- Only columns with statistics (doc_value) enabled; others come back **silently as `null`**
  (do not conclude "the field is empty" — read raw rows with a pure search instead).
- Numbers unquoted (`WHERE status = 500`), strings single-quoted; double quotes are column names.
  Colon columns: alias or `"__tag__:__hostname__"` (double-quoted inside SQL is fine).
- `FROM log` may be omitted at top level but is **required in the innermost subquery**.
- `LIMIT n` / `LIMIT offset, count`; no `OFFSET` keyword.
- Every SQL value comes back typed `string` (even `count(*)`); `time`/`__time__` columns are
  epoch — do not be surprised by quotes around numbers in TSV.

## 4. Size and paging

`--limit N` is the **total row count** (default 50, max 200; mapped to the plugin's
`totalLogs`, paged internally by 100). A SQL statement should carry its own `LIMIT`; `--limit`
only caps rows returned. Discipline: `count(*)` / `GROUP BY` first, then raw rows with an explicit
projection and `LIMIT ≤ 50`. Never `SELECT *` with a large limit. A pure search returns one column
per indexed field (the plugin's aggregated `message` column is dropped unless `--keep-message`).
`truncated=true` in the header means the limit was hit — narrow the window or aggregate.

## 5. Error line → what to do

| `error:` contains | Cause | Do |
|---|---|---|
| `grafana 401` / `403` | token invalid or lacks `datasources:query` | stop; `suites/sre-inspect/run doctor`; not a query problem |
| `grafana 404 … Data source not found` / `no SLS datasource named` | wrong uid/name | `run sls datasources` |
| `ParameterInvalid … key (X) is not config as key value config` | search key not in index (or alias / quoted colon key) | use the snapshot's real key; unquote colon keys; or full-text `"value"` |
| `ParameterInvalid … Column 'X' cannot be resolved` | SQL column not indexed / no statistics | switch column; read raw rows by pure search |
| `'=' cannot be applied to bigint, varchar` | quoted number | unquote |
| `identifiers must not contain ':'` | colon column bare in SQL | alias or double-quote it in SQL |
| `parse search query error` | SQL syntax in the search segment | move `in/like/'…'` right of `\|` |
| `please specify FROM LOGSTORE` | nested SQL without `FROM log` | add it to the innermost query |
| `incomplete logs, you can switch to powerSql` | scan too large for the plugin's page loop | `--power-sql`, or narrow the window / add search filters |
| `logStore is empty` | datasource has no default logstore | pass `--logstore` |
| `LogStoreNotExist` / `ProjectNotExist` | name typo | `run sls logstores` |
| `grafana 0: cannot reach` / timeouts | network / Grafana datasource timeout | retry once with a smaller window; then record a data gap |

A `ParameterInvalid` on a field you took from the index snapshot means **the snapshot is stale**:
record it in `data_gaps`, do not guess another field.

## 6. Recipes

- **Context around a host at an instant** (the plugin has no context-logs API):
  `run sls context --datasource <ds> --hostname <host> --ts <epoch> --before 30 --after 30`
  = search `__tag__:__hostname__: "<host>"` over `[ts-30, ts+30]`, newest first, ≤100 rows.
  Add `--extra 'status >= 500'` to AND more terms.
- **Distribution then samples**: `status >= 500 | select request_uri, count(*) as c group by request_uri order by c desc limit 20`
  → then a pure search `status >= 500 and request_uri: "/the/path"` with `--limit 10`.
- **Per-minute trend**: `… | select date_trunc('minute', __time__) as t, count(*) as c group by t order by t limit 120`.
- **Trace by id** (when traces land in an SLS logstore): pure search `traceID: "<id>"` on the trace
  datasource; there is no separate trace tool on this data plane.
- **Batch of logstores**: one call per datasource; do not loop blindly — decide from the count first.

## 7. Never

- Put a token on a command line or in a file you write; the script reads the environment only.
- Convert time zones, or write relative time into a query.
- Re-run the identical query hoping for a different answer; change the window or the statement.
- Treat `null` from SQL as a business fact, or 0 rows as "no anomaly", before the anchor check.
- Copy log lines that carry user identifiers into a report; aggregate, or cite the query instead.
