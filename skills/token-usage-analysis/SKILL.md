---
name: token-usage-analysis
description: Use when the operator asks to analyze their own local Claude Code or Codex token usage, burn rate, task hotspots, model mix, usage patterns, or task outcomes.
id: skill:token-usage-analysis
type: skill
owner: EricZhang
version: "2268be104de9033410225f369626bdbc0bd90197"
status: active
summary: Local, sanitized token-usage analysis with hybrid aggregates and task-instance correlation (#32).
use_when: The operator wants to understand their own local AI-coding token consumption - burn rate, which mounted repos and branches consume most, model mix, usage patterns - from the session data already on this machine.
usage: Run from the workspace root. The deterministic collector is scripts/token-usage-report; this skill adds interpretation on top and never invents numbers.
dependencies: []
regression: ["regression-case:token-usage-analysis-smoke"]
---

# Token Usage Analysis (local)

Turn the agent-session data already on this machine into an efficiency insight for **the
operator themselves**: a sanitized report from a deterministic collector, plus a short
narrative over the five threads of issue #32. Facts come **only** from the collector's
output; the skill interprets, it never invents numbers.

## Phase 0: Preflight

1. Run from the workspace root (`workspace.yaml` + `agent-instructions/` exist).
2. **Privacy contract (hard, restate it to the operator before running):**
   - Everything stays on this machine; running this analysis is the operator's explicit opt-in.
   - The report never contains prompts, file paths, or user identifiers.
   - Projects unrelated to this workspace are aggregated anonymously as "other"; only the
     explicit `--all-projects` flag names them (still local-only).
   - Output lands in `runs/token-usage/` (gitignored). **Never commit the report**, never
     send it anywhere; sharing requires a prior human review of the content.
   - This is a self-serve efficiency lens, **not a performance-evaluation input**.
3. Check the native data sources: `~/.claude/projects/` (Claude Code),
   `~/.codex/sessions/` (Codex) and `~/.qoder/projects/` (Qoder: credits only, no tokens). One missing → proceed and note it. If both native
   collectors have no window records, a valid explicitly installed ccusage source may still
   produce base-only sections; otherwise stop and report no data.

## Phase 1: Collect (deterministic, hybrid sources)

Run `scripts/token-usage-report` (zero-dependency: python3 stdlib + git) with the window the
operator wants — default is the last 30 days; dates use local time and `--until` includes
that whole day. Add `--json` for machine-readable aggregates:

    scripts/token-usage-report --since <YYYY-MM-DD> --until <YYYY-MM-DD> --json

**Hybrid source split** (`--source auto`, the default): base usage — totals, daily trend,
model mix, estimated USD cost — prefers **ccusage v20** when the operator has installed it
explicitly (`npm i -g ccusage@20`; see `workspace.yaml`); the script **never auto-downloads** it
(no implicit `npx` — a supply-chain red line). Base-usage sections use only the
**correlatable set** (claude+codex, the agents the attribution layer also covers); other
CLIs' totals go to a separate unattributed appendix, never mixed into task hotspots.
Everything attribution-related — mounted-repo buckets, branches, usage patterns, git link —
always comes from the built-in collector, which is also the automatic **fallback** when
ccusage is absent, unevaluated, times out, or its output fails the evaluated v20 schema
(the report states the concrete reason); `--source ccusage` fails loudly instead of falling back.
The report labels each section's source. A timeout, non-zero exit, malformed JSON, or JSON
without a `claude`/`codex` agent is an external-source failure with its concrete reason.
When the report shows `native(fallback)` because ccusage is absent, **tell the operator
once** what the optional install adds (USD cost estimates + dual-source reconciliation)
and how (`npm i -g ccusage@20`) — remind, never install for them, and don't repeat the
reminder every run.

The two sources' overlapping scope is compared in the report's cross-check (对账) section:
a gap above 5% is flagged as a data-quality note, never a reason to adjust numbers by
hand. USD cost estimates come **only** from ccusage — this skill maintains no price table.
`--source native` skips the external tool entirely.

**Codex-only behavior:** continue when Claude is missing. Section ① remains usable from
ccusage; after native fallback it has only whole-window Codex session totals — no daily
trend, cache-hit rate, or thinking share. Sections ②, ④, and ⑤ remain present but say
`本节不可用` because Codex lacks message/branch detail. Section ③ uses ccusage when valid;
after native fallback it also says unavailable. Do not invent missing branch, sidechain,
model, stage, or Git-attribution detail. The task-instance companion exits 2 when there is
no Claude instance data.

**Task-instance view** (#32 S2.1 / #127): run the deterministic companion after the aggregate
report; add `--json` when instance IDs will be consumed:

    scripts/token-usage-tasks report --since <YYYY-MM-DD> --until <YYYY-MM-DD> --json

Zero-manual output creates one stable opaque `task_instance_id` per Claude session segment,
splitting again after **more than 30 minutes idle**. It never exposes the raw session ID.
Each row contains tokens, ordered stage sequence and per-stage tokens, the existing
读/改/跑/代理 profile, and Git signals for that instance window.

This is a deterministic **instance heuristic, not semantic task recognition**: adjacent
tasks inside one ≤30-minute segment can remain merged, while one task separated by a longer
pause can split. Use an issue ref to merge confirmed fragments; never claim finer separation
than the rows support. IDs are stable across historical query windows because segmentation
uses the complete local session before applying the requested date filter.

To bind outcomes, first run the report so its sanitized instance catalog exists, then copy
IDs from the local report. Repeat `--instance` to bind several instances at once; equal
issue refs in the strict `#<digits>` form merge them into one manually confirmed task:

    scripts/token-usage-tasks annotate \
      --instance '<task_instance_id>' [--instance '<second_id>'] \
      --result success --ref '#127' --type implementation --first-pass yes

Annotations are optional and structured: result, numeric issue ref (`#<digits>`), task type, first-pass flag, and
the exact instance time window. There is no free-text note field. The sqlite stores only
opaque ID/bucket/branch/window plus those labels — never prompts, paths, raw session IDs, or
user identifiers. Existing v1 `bucket@branch` annotations move to `legacy_annotations_v1`;
the report counts them but never auto-attaches them because the old cluster is ambiguous.
Rows are checkable correlation records, never a person score. Run
`scripts/token-usage-tasks annotate --help` for the current structured enums.

## Phase 2: Interpret — the five threads

Write a short narrative per thread, each claim tied to a concrete number from the report
(cite the section); what the data cannot support is said out loud, not guessed:

1. **消耗速度** → report §①: daily trend, cache hit rate, thinking share; call out spikes
   with their dates.
2. **任务热点** → §② gives bucket × branch ranking; use the task-instance report for
   task-level claims. Worktree/temp-checkout attribution rows are marked `# inferred` —
   carry that marker into any claim built on them.
3. **模型选用** → §③: model mix; note mismatches between model tier and task type if visible.
4. **使用模式** → §④: hour-of-day histogram, session count/median length, sidechain share;
   the task-instance report adds ordered stages and their token allocation.
5. **效果感知** → §⑤ is a coarse bucket-level tokens-per-commit link; the task-instance
   view adds instance-window commits/reverts plus optional outcomes. Repeated edits to the
   same files remain out of scope — say so instead of speculating. Metric caveats:
   `references/metrics-guide.md`.

Anomalies (a token spike, a low cache hit rate, one repo dominating) get a **checkable
suggestion phrased as a hypothesis** ("worth checking whether …"), never a verdict.

## Phase 3: Deliver

**Ask the operator once how they want to view the result** (skip the question if they
already said so): (a) **HTML** — re-run the collector with `--html --open` (renders a local
self-contained page beside the markdown and opens it in their default viewer), or
(b) **terminal** — present the narrative digest directly in chat. The HTML is a local file
under `runs/` exactly like the markdown — it is never published as a web artifact, uploaded,
or shared anywhere.

Report + narrative stay in `runs/token-usage/`; remind the operator it is local-only and
gitignored. If they want to share any of it, they review and redact first — the skill never
publishes, uploads, or commits the output.

## Boundaries

- One machine, one operator. Team/cross-machine aggregation, billing reconciliation, and
  identity joins are issue #22's scope — do not attempt them here.
- On-demand only: no scheduling, no background collection — each run is an explicit opt-in.
- Metric definitions, attribution rules, and data-source limits live in
  `references/metrics-guide.md`; do not restate numbers' meaning beyond what it defines.
