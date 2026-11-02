# quickstart — from a Grafana token to a finished report

> 中文版：[quickstart.zh.md](quickstart.zh.md)（两份内容同步维护，改一份要改另一份）。

Everything runs from the workspace root with python3 ≥ 3.8. Docker is optional (metrics through
mcp-grafana, local HolmesGPT); `gh` is optional (deploy facts).

## 0. One-time setup (operator)

```sh
cd suites/sre-inspect
cp tenant.yaml.example tenant.yaml        # two homes — pick one, see below
cp routes.yaml.example routes.yaml
cp env/holmes-env.example env/.env.holmes && chmod 600 env/.env.holmes   # fill GRAFANA_URL + token
$EDITOR tenant.yaml routes.yaml           # datasource names as they appear in Grafana; your rule uids
```

**Two homes — pick one** (the one-line test: may your department's config be **committed** to the repo you checked out? yes → ①; no — e.g. it is the shared template repo → ②. The content is identical either way; ② → ① is just a file rename): ① a **department workspace instance** commits `tenant.yaml` /
`routes.yaml` (non-secret config, versioned and PR-reviewed — the normal state); ② a **template-repo
checkout** (trying it before a department instance exists) uses the gitignored twins
`tenant.local.yaml` / `routes.local.yaml`, which **take precedence** over the tracked names when
present. Mind the spelling: `.local` sits in the middle (`tenant.local.yaml`); a file named
`tenant.yaml.local` is silently ignored.
No department instance repo yet? Creating one is a workspace-level step — the template README's
quick start step 1 (GitHub "Use this template", or clone + change remote; `scripts/ws init <dir>`
releases a history-free skeleton). Create it, fill `workspace.yaml` per the README, then come back
here and follow ①.

- `tenant.yaml`: `grafana.url` (= `GRAFANA_URL`), the datasources the agent may use (each entry's `datasource:` is the
  Grafana **datasource display name** — never a metric name, metrics are discovered at runtime;
  one SLS datasource per logstore is the usual shape), the probe pair, `alert_source.filter`
  mirroring your notification policy, `deploys[]` if your deploys are GitHub Actions workflows.
- **Choosing datasources / finding rule uids / finding deploy workflows** (reconciliation, not taste;
  every step is a verb, and the agent can run them for you — skill `sre-inspect` §5 says how):
  ① `run discover datasources` inventories every datasource; ② `run discover rules` lists every alert
  rule, the datasource it queries and **which are still unrouted** — a rule's datasource must be listed
  (triage re-queries the series that alerted), and unrouted rules get a printed routes.yaml stanza
  (rid / layer / template are yours to fill); ③ `run discover deploys <owner/repo>` finds the repo's
  deploy workflow and prints the deploys[] lines — **list every repo whose build can land on the
  alerted hosts**; ④ check layer coverage with `list_prometheus_metric_names` (regex like `^AliyunEcs_`
  / `^nsq_`): at least one host-level (cloud monitor) and one application-level source; point
  `probe.metrics_datasource` at the cloud-monitor one; ⑤ from then on every report's `data_gaps` is
  the shopping list.
- `routes.yaml`: rule uid → RID / triage template (`triage/*.md`, placeholders in `triage/README.md`).
  `run discover rules` prints the uids and paste-ready stanzas (so does `run intake`'s unrouted section).
- Attaching the metrics plane (mcp-grafana) to Claude Code / Codex: see §2 "Attach your agent" below — a step of its own in the flow.

### Trying it from another machine (e.g. a laptop), before the department has committed its config

A fresh clone runs against the real Grafana with exactly **three files carried over**, none of them
tracked: `tenant.local.yaml` and `routes.local.yaml` (non-secret — datasource names and rule
routes; copy them from a machine where they exist, or write them from the `.example` twins) into
`suites/sre-inspect/`, plus your own `env/.env.holmes` (the token — fill it yourself, never copy it
through a chat). Then the same `validate → doctor → intake` path applies. Notes for laptops:

- python3 alone covers logs + alert intake + dive/finish; **Docker is only for** the mcp-grafana
  metrics tools and the optional local Holmes (`run doctor --no-mcp` without it). The pinned
  mcp-grafana digest is a multi-arch index (amd64 + arm64), so Apple Silicon pulls natively.
- The local-Holmes image is built from the HolmesGPT fork's source on your machine
  (`docker build -t holmes-ocinf:main .` in the fork checkout; set `HOLMES_IMAGE` if you name it
  differently) — there is no registry to pull it from.
- `gh` not installed / not authorized only degrades the L7 deploy table to "未接入".
- If your network needs a VPN / IP allowlist to reach the Grafana host, `run doctor` fails at D1
  first — fix connectivity before reading anything else into the output.

## 1. Readiness

```sh
suites/sre-inspect/test              # gate zero · offline self-check: no token, no Docker — run this first on a new machine
suites/sre-inspect/run validate      # offline: tenant/routes/toolset credential guard
suites/sre-inspect/run doctor        # live: Grafana health, datasources + token scope, `up`, an SLS count, mcp-grafana stdio, gh
suites/sre-inspect/run spike         # optional, once: the #146 G0 checklist → runs/sre-inspect/spike-<ts>.md
```

What each step should show:

- `test` → `OK: sre-inspect test passed (… unit tests + 2 skill smokes + guards)`. Red means the code
  itself is broken on this machine (e.g. a platform difference) — fix that before touching anything else.
- `run validate` → two file-location lines + `OK: validate`; every config mistake is named.
- `run doctor` → every `MUST` row `[ OK ]`. A red D1 = your network cannot reach Grafana (VPN /
  allowlist, not a code problem); D4 needs Docker — without it only the metrics channel degrades.
- `run spike` → a measured report under runs/ (optional).

All `MUST` rows green before going on.

## 2. Attach your agent (Claude Code / Codex)

The investigation is done by **your agent** inside its session, so wire it to the data plane first.
Logs need nothing (the `grafana-sls` skill goes through Bash); metrics / alert rules / dashboards
need one MCP server:

```sh
suites/sre-inspect/run mcp-config --write  # once: writes/merges the "grafana" server into <workspace>/.mcp.json (without --write it only prints; Codex uses the printed ~/.codex/config.toml snippet)
set -a; . suites/sre-inspect/env/.env.holmes; set +a    # every time: the ${VAR}s in .mcp.json resolve from the agent process's environment
cd <workspace root> && claude              # start FROM the workspace root, in THIS shell (a project .mcp.json is found by launch directory)
```

On first start Claude Code asks whether to trust this project's MCP server — allow it (declined it
earlier? `claude mcp reset-project-choices`). Type `/mcp`: `grafana` must show as connected.
"No MCP servers configured" = not launched from the root, or .mcp.json is not valid JSON (`claude
doctor` lists config files that failed validation); a connection failure = env not sourced, or
Docker not running (the sidecar is a docker process). Without Docker you can
still go on — the agent just lacks the metrics tools; logs and intake work as before.

## 3. Intake → pick

**You say, in the Claude Code session** (or just `/sre-inspect`):

> what fired in the last 24 hours?

**The agent does**: `run doctor` (preflight), then `run intake --since 24h`, and relays the digest.
Intake reads Alertmanager (firing now) + alert state history (Alerting transitions in the window),
applies `alert_source.filter`, routes by `routes.yaml`, consults the recurrence ledger, and sorts
everything into four groups:

```
window …: alertmanager firing=1, annotations Alerting=12, rules=27
after filter 7 (6 dropped) → 7 fingerprints → candidates 3, suppressed 0, known_bug 0, unrouted 4
candidates (`run dive <n>`):
  [5] R-01 API | 5XX | /v1/orders | 08-31 04:07:00 (alerting-transition) | template api-5xx.md
  [7] R-08 ECS | Memory | app-host-002 | 08-21 14:06:50 (firing) | template ecs-memory.md
unrouted (add a routes.yaml entry + triage template first, then dive):
  [1] Process | Not Running | uid xxxxxxxxxxxxxx | svc.worker | rule_uid not in routes.yaml
```

- **candidates**: routed to a template and outside the cooldown window — diggable;
- **suppressed**: same fingerprint within 30 min of an open incident — folded, not reopened;
- **known_bug**: a deterministic verdict declared in `routes.yaml` (e.g. a NoData artefact) — no model;
- **unrouted**: rule not in the table / no template — **listed, never dug**.

**You decide**: give the agent a candidate number ("triage item 5"). For unrouted items have the
agent draft the `routes.yaml` entry + triage template and merge them first — do not let it dig
without a template. "No new candidates in the window" (exit 3) is a legal outcome.

Equivalent manual form (debugging): `suites/sre-inspect/run intake --since 24h` in a terminal, or
`!suites/sre-inspect/run intake --since 24h` inside the session (`!` = run the shell command
directly, no model). Queue file: `runs/sre-inspect/queue/latest.json`.

## 4. Dive → investigate → finish

**You say**:

> triage item 5

**The agent does** (in the order `skills/sre-inspect` prescribes; you watch and steer):

1. `run dive 5` → creates `runs/sre-inspect/INC-…/` with `INSPECT.md`, the brief: injected time
   facts, alert labels, the rendered triage template, layered requirements, the L7 deploy table,
   the output contract;
2. reads it and **verifies first** (PASS / FAIL / INDETERMINATE) — PASS is written up and stops,
   FAIL proceeds to the dig;
3. digs: logs through the `grafana-sls` skill (it should `fetch` that skill before its first SLS
   statement), metrics / alert rules / dashboards through the mcp-grafana tools, layers L1→L7,
   data-backed findings separated from hypotheses;
4. writes `rca.md` and fills `report.json` in the incident directory;
5. `run finish INC-…` → contract validation, scrub, ledger. Exit 4 = fields missing (listed — let
   it fill them); exit 5 = a secret-shaped string in the text (remove it, rerun).

**You watch three things**: did it run `run dive` first; did it read `grafana-sls` before writing
SLS; did it run `run finish` itself with exit 0. If it improvises around the commands, interrupt
and send it back to the brief.

**Output**: `runs/sre-inspect/INC-…/rca.md` (human-readable, scrubbed, forwardable) and
`report.json` (machine contract v1.1). For FAIL with `cause_locus=code_defect` and confidence ≥
medium, `finish` prints the next step `suites/sre-autofix/run claim …` — the fix leg; for
infra/dependency causes the deliverable stops at rca.md and goes to whoever owns that layer. A PASS
closes the fingerprint (14-day recurrence window starts).

Equivalent manual form: `suites/sre-inspect/run dive 5` in a terminal, investigate along
INSPECT.md yourself, write both artefacts, then `suites/sre-inspect/run finish INC-…`.

**Replaying a historical alert** (a retro, or a model A/B): no parameters to remember — point the
intake window at the past and dive by number: `run intake --from 2026-08-27T00:00:00Z --to
2026-08-28T00:00:00Z` → `run dive <n>`. The manual form `run dive --rule-uid <uid> --at <epoch>` is
only for alerts beyond Grafana's state-history retention; both values come from an archived queue
(`runs/sre-inspect/queue/*.json`, each item's `alert.rule_uid` / `eval_epoch`) or
`alerting_manage_rules operation=list`.

**Optional local HolmesGPT**: `run dive 5 --holmes` (needs `holmes/docker-compose.yaml` up: copy
`holmes/config.yaml.example` to `holmes/.holmes/config.yaml`, set `HOLMES_IMAGE`). The answer lands in
`holmes.md`; `rca.md` / `report.json` and `finish` are still your agent's job. Long dives: start it
detached; a foreground timeout kills the dive midway.

## What "working" means (the acceptance bar for a new machine / department)

All three, no exceptions:

1. **Offline**: `suites/sre-inspect/test` green;
2. **Data plane**: every `MUST` row of `run doctor` green;
3. **One full incident, done by your agent under the skill** — start the agent from a shell that
   sourced the env file, say "triage item n from the queue", and it walks dive → investigation
   (fetching `grafana-sls` before its first SLS statement) → rca.md + report.json → `run finish`
   exit 0 on its own. Typing the commands yourself does not count: the bar exists to verify skill
   triggering and discipline.

## 5. Iterating the knowledge

Every `unrouted` line, every `ParameterInvalid` on a snapshot field, every repeated PASS pattern is
a change to `routes.yaml`, the index snapshots, or a triage template — committed by the department
through its normal PR flow. That is the point of the local form.
