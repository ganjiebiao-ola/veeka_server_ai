# skills/ — reusable-skill mount point

`git clone` proven, self-describing skills here (`<name>/SKILL.md` + optional `references/`,
`assets/`). Both Claude Code and Codex discover them with no install step, via the tracked
`.claude/skills` and `.agents/skills` symlinks.

Skill format, activation rules, and admission criteria: `agent-instructions/mount-points.md`.

## Template-bundled skills (tracked in this repo)

The workspace-native skills listed below ship with the template — they are **tracked
here**, not mounted, because they are written against this workspace's own layout/mechanism and
evolve via normal PR flow:

- `workspace-context-bootstrap/` — writes the trusted per-mounted-repo context
  (`team-context/mounted-repos/<id>.md`), with cross-repo relations scan and golden-question validation.
- `workspace-onboarding/` — new-hire onboarding assistant; workspace-level orientation first,
  per-repo context second, citations always.
- `spec-authoring/` — drafts four-part project Specs (product requirements / UI design / technical
  goals / framework constraints) from raw material, with per-section checklists and a parent-ticket
  coverage map, gap identification and structured in-place rewrite producing a 00 gap report, a
  bounded owner Q&A loop with ready-to-generate completion gates, and a downstream handoff contract
  for the #6/#7/#8 pipelines (#31, S1–S4).
- `token-usage-analysis/` — local, sanitized token-usage analysis for one operator: hybrid sources
  (base usage/cost prefers an explicitly installed `ccusage`; the zero-dependency collector
  `scripts/token-usage-report` owns all attribution and is the fallback + reconciliation baseline)
  plus a five-thread narrative — burn rate, task hotspots by mounted repo/branch, model mix, usage
  patterns, and a task-instance view (`scripts/token-usage-tasks`: session/idle-gap splitting,
  stage sequences, git signals, optional outcome labels). Local-only and opt-in; reports land in
  `runs/` as markdown (`--html --open` for a local page) and never contain prompts, file paths,
  or user identifiers (#32).

  Quick use (from the workspace root):

  ```sh
  scripts/token-usage-report                    # aggregate report: five threads + cost + cross-check
  scripts/token-usage-report --html --open      # same, rendered as a local HTML page
  scripts/token-usage-tasks report              # task instances: where it burned, doing what, result
  scripts/token-usage-tasks annotate \
    --instance '<id-from-report>' --result success --ref '#123'   # optional outcome label
  ```

  Optional: `npm i -g ccusage@20` adds USD cost estimates + dual-source reconciliation — install
  it yourself; the scripts never auto-download it.
- `ai-usage-weekly/` — the weekly AI-usage reporting chain (#22) on top of `token-usage-analysis`:
  each member's local usage (Claude Code + Codex, per day × model × mounted repo, ISO week in the
  team's timezone) × `assets/pricing.json` = an **estimated** cost, plus an AI-drafted,
  human-confirmed narrative (用量 / 费用 / 使用内容 / 产生的价值), written as one submission file
  in the team reports repo (`scripts/ai-usage-weekly submit`); the lead aggregates a week's files
  into a self-contained `team-report.html/.md` (`team`), with six checks, no ranking by cost, and
  a bills-only monthly budget status. Three amounts stay apart and are never summed: estimated
  (price table), actual (a bill via `--bill` / `--cost-file`), allocated (prorated to the week);
  a missing bill shows 待核实, never 0. `request --form` drafts a resource request for the
  company's approval flow (#200). `month --allocation <file.xlsx>` (#359) makes a monthly report
  under `reports/months/<YYYY-MM>/`: real cost by team from the LiteLLM key allocation file, the
  month's weekly reports, and the git history of the mounted repos. Details: `SKILL.md` § Phase 2c.
  Reports repo default `knowledge/ai-usage-reports/` (a separate
  clone; `--reports-dir` overrides) — `submit` creates a **local** one with the starter files
  from `assets/reports-repo/` when it is missing (#206). Never pushes, never networks; `--commit`
  is local only; `workspace.yaml` `owner` is who submits. Same privacy contract as
  `token-usage-analysis`: no prompts, paths, session ids.

  Quick use (from the workspace root):

  ```sh
  git clone <team reports repo> knowledge/ai-usage-reports   # missing → submit creates a LOCAL one (WARN)
  scripts/ai-usage-weekly submit --open                      # last complete ISO week: usage + estimate → reports/<week>/<human_id>.{json,md,html}
  scripts/ai-usage-weekly submit --week <YYYY-Www> \
    --narrative runs/ai-usage-weekly/<YYYY-Www>/narrative.json --commit   # shape: assets/narrative.example.json
  git -C knowledge/ai-usage-reports push                     # you push; the tool never does
  scripts/ai-usage-weekly team --week <YYYY-Www> --open      # team lead: aggregate → team-report.html/.md
  scripts/ai-usage-weekly request --form <request.json>      # resource request draft (company approval flow)
  scripts/ai-usage-weekly month --allocation <september_2026.xlsx>   # team lead: monthly report → reports/months/<YYYY-MM>/
  ```
- `skills-source-loader/` — on-demand loader for the long tail of the skills-source monorepo named by
  `workspace.yaml` `skill_catalog.source` (see `agent-instructions/mount-points.md` § "Mounting at
  scale"): lists it live with `scripts/setup-skills --index`, confirms a match, trial-mounts it with
  `--id … --category …`, hands off to a fresh subagent. Inert in a workspace with no `skill_catalog`.
  Also workspace-native (it knows this workspace's `skill_catalog`/`scripts/setup-skills`/
  `workspace.local.yaml` mechanics), not a general-purpose capability.

- `incident-fix/` — the INCIDENT.md contract v4 of Agentic SRE as an agent skill: run inside a
  prepared worktree, produce `FIXNOTES.md` + `.sre-evidence/verification.json`, never commit/push.
  Its marker-delimited contract block is also embedded into INCIDENT.md by `suites/sre-autofix/run plan`.
- `sre-autofix/` — operator driver for `suites/sre-autofix` (claim → plan → fix → gate → ship;
  push/PR human-gated by `harness_guard`).
- `sre-inspect/` — driver for `suites/sre-inspect` (doctor → intake → dive → investigate → finish →
  hand the report.json to `/sre-autofix`); the investigation discipline of the reference engine as
  agent instructions.
- `grafana-sls/` — how to query Aliyun SLS logs through the department Grafana with one token: the
  grammar that survives the Grafana plugin, datasource selection, epoch-only time, result sizing,
  the error table. Used by Claude Code / Codex via Bash and by HolmesGPT as its toolset skill.
- `security-patch/` — operator driver for `suites/security-patch` (start → doctor → overview → pick → status →
  resume) on top of the codesec tool; the human accepts every Pick in the tool and the repo owner merges every PR.
- `workspace-upstream-sync/` — merge-based (never rebase) sync of `sync-upstream-main` against the
  upstream template, then `main`, with a post-sync audit sweep (stale skill-count claims, orphaned
  rename duplicates, `AGENTS.md`/`CLAUDE.md` drift) and a `harness_guard`-gated ship step
  (`scripts/sync-upstream-ship`) for the final push + PR.
- `workspace-update/` — bring this workspace clone up to date with `origin`'s default branch, where
  teammates merge: say what changed, `git pull --ff-only origin <default branch>` on the operator's yes, then the follow-ups
  (session restart for changed entry/hook files, Codex hook trust, newly catalogued repos/skills, new
  `*.example` config keys), ending on `ws health`. `scripts/check-freshness` decides "behind": run by
  hand as `ws freshness`, and as a SessionStart hook (`.claude/settings.json`, `.codex/hooks.json`) that
  fetches at most hourly and tells the agent to offer the update. Not the template sync and not `repos/`.
- `code-map-scope/` — review a mounted repo's layout and write `knowledge/maps/<id>/.cbmignore`, the
  exclusion list that keeps generated/vendored/sensitive trees out of its code map (staged into the
  repo only for the indexing run, never left behind), then stamp who reviewed it via
  `scripts/generate-map --stamp-cbmignore <id>`. Rare and deliberate — once per repo, revisited when
  the layout moves.
- `code-map-query/` — query a repo's **code map** (the `codebase-memory-mcp` knowledge graph under
  `knowledge/maps/<id>/`) instead of grepping: `search_graph`, `trace_path`,
  `get_code_snippet`, `check_index_coverage`, with a Scout/Verify/Auditor evidence-tier discipline.

### Using them

Both agents discover these skills automatically at the workspace root (via the tracked
`.claude/skills` / `.agents/skills` symlinks) — no install step. Trigger one by stating the task in
chat, or invoke it explicitly with `/<skill-name>`. Examples:

- "Bootstrap `repos/mall-backend` and write its team-context file" → `workspace-context-bootstrap`
- "I'm new here, walk me through this workspace" → `workspace-onboarding`
- "/spec-authoring — turn this requirement doc into a four-part Spec, engine leaning cocos"; or, for
  an existing Spec: "run a gap check on `docs/specs/<feature>/`" → `spec-authoring`
- "分析我最近 30 天的本地 token 使用" / "which repo burns the most tokens?" → `token-usage-analysis`
  (it states the privacy contract first, then asks whether you want the result as a local HTML
  page or a terminal digest)
- "生成我这周的 AI 使用小结并提交" / "write my weekly AI usage update" → `ai-usage-weekly`
  (restates the transparency contract — what is submitted is visible to the team — runs `submit`,
  drafts the narrative from the data, and only saves it after you confirm); "汇总本组 2026-W37
  周报" / "build the team AI usage report" → the same skill's `team` phase
- "在技能库里找一个做 X 的技能" / "find and trial-mount a matching skill from our skills repo" →
  `skills-source-loader`
- "修复这份 SRE 报告" / "fix from this report.json" → `sre-autofix` (drives `suites/sre-autofix`
  verb by verb; the fix itself is written under `incident-fix` inside the prepared worktree)
- "排查这个告警" / "看看今天的告警" / "triage this alert" → `sre-inspect` (drives
  `suites/sre-inspect`; the investigation happens in the same session, logs via `grafana-sls`,
  metrics via the mcp-grafana MCP server)
- "安全补丁进度" / "show the security overview" / "resume the security run" → `security-patch`
  (drives `suites/security-patch`; the bundled app does the scan, fixes and PRs)
- "跟上游同步" / "sync with the template" / "pull in upstream changes" → `workspace-upstream-sync`
  (merges `upstream/main` then `main` into `sync-upstream-main`, audits, ships via
  `scripts/sync-upstream-ship`)
- "更新 workspace" / "update my workspace" / "what changed in the workspace" → `workspace-update`
  (pulls teammates' merged PRs from `origin`, not the template; the session-start hook offers it when
  the clone is behind)

Each skill's phases and hard rules live in its own `SKILL.md`; outputs written into a mounted repo
always go through that repo's own branch/PR.

Everything **else** under `skills/` follows the mount rule (own `.git`, gitignored here) — **with one
structural nuance if this workspace has adopted the scaled-mounting pattern above**: most other
entries under `skills/` at any given time may be **symlinks into a `repos/`-mounted monorepo**
(e.g. `skills/<id> -> ../repos/<skills-source>/<category>/<id>`) rather than
independent `git clone`s each with their own `.git`. `ls -la skills/` shows this directly — a
symlink target rather than a directory. They're still managed by the mount rule in spirit (read-only,
never authored in place); they're just *selected*, not cloned, individually. See
`scripts/setup-skills --list` for what's curated and `workspace.local.yaml` for what's actually
linked (`mode: curated` vs `mode: trial`).

Bundled skills (the ones listed above) are the exception, whitelisted explicitly in `.gitignore`;
modify them like any other tracked file (PR + review), and re-run their `regression/smoke.sh` before
merging (`suites/sre-autofix/test`, `suites/sre-inspect/test` and `suites/security-patch/test` run their skills' smokes under
`ws test`). `ws health` also scans every bundled skill (`scripts/check-bundled-skills`, #119): #48
metadata on its id-bearing files, and cross-reference closure — `SKILL.md regression:` must resolve
to the `regression/REGRESSION.md` asset record beside the smoke.
