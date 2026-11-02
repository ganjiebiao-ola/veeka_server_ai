---
name: code-map-query
description: "Query the workspace code graph for symbols, callers, dependencies, architecture, impact analysis, and query syntax. Triggers on: research on, how is X implemented, explore the codebase, understand the architecture, explain architecture, what functions exist, show me the structure, who calls this function, what does X call, trace the call chain, find callers of, show dependencies, impact analysis, blast radius, dead code, unused functions, high fan-out, refactor candidates, code quality audit, graph query syntax, Cypher query examples, edge types, how to use search_graph, update the code map tool, upgrade codebase-memory-mcp, 调研, 更新代码地图工具, 查代码地图, 谁调用了这个函数, 影响面分析, 代码架构排查, 模块分析."
id: skill:code-map-query
type: skill
owner: EricZhang
version: "292a27ee4ed49920dbe171dc9c4ff988c2ce58ab"
status: active
summary: Use the repo graph for structural questions. Query symbols, calls, and coverage before broad code searches.
use_when: A task needs symbols, callers, architecture, or change impact inside a mounted repo.
usage: Use the connected codebase-memory-mcp server. Follow the first-query rule and evidence tiers below. Generate snapshots only when the task needs them.
dependencies: []
regression: ["regression-case:code-map-query-smoke"]
---

# code-map-query — ask the code map, don't grep

## What a code map is, and where it sits

A **code map** is the machine-generated structural layer for one repo: a knowledge graph of its
functions, calls, routes and imports, plus the coverage record of what didn't make it in. It lives
at `knowledge/maps/<repo-id>/` — built by `ws map generate <id>`, scoped by the
`code-map-scope` skill, queried by this one.

A code map is **part of a project map, not the whole of it**. The project map
(`knowledge/maps/`) is the superset: it adds the cross-repo and human-authored context a
graph cannot derive — how the repos relate, which service owns which data, deploy topology, sharp
edges, ownership. So:

- **Structural question about code inside one repo** → this skill, the graph.
- **"Which repo does this, and what else breaks"** → the project map first
  (`knowledge/maps/overview.md`, `team-context/mounted-repos/<id>.md`), then come back here
  for the mechanics inside whichever repo it points at.

The graph is authoritative about *structure* and silent about *intent* — it knows `X` calls `Y`, not
whether that's a deliberate boundary or an accident. Intent lives in the project map.

> Prerequisite: this skill only does anything if the `codebase-memory-mcp` MCP server is connected
> (its tools show up as `mcp__codebase-memory-mcp__*`). `ws map install` puts the binary on your PATH
> and registers it with detected MCP clients (Claude Code, Codex, ...). A session reload after that
> is still on the operator — no script can do that part. If the tools aren't available, say so
> instead of guessing at graph results.

Use the exact prefix `mcp__codebase-memory-mcp__` (hyphens, not underscores).
On `No such tool`, check the name. Load deferred tools with `ToolSearch`. Retry before using `rg`.

Graph tools can reduce unnecessary searches for structural questions.
The feedback reports do not establish net token savings.

**Two different indexes, don't confuse them.** `ws map generate <id> --mode full` writes
`knowledge/maps/<id>/` once. The team commits that map, which this skill's docs describe.
The *live* graph is a separate index. CBM's watcher follows only the session's own project (the workspace root).
It never watches `repos/<id>`. In 0.12.1, `index_status` reports `watch.watched: false, reason: not_session_project`.

At session start, `scripts/code-map-hook` starts one background worker to index each mounted repo and its linked git worktrees.

Worktree projects keep `<repo-id>.wt.<folder>` for safe folder basenames that are unique among the repo's current worktrees.
Safe basenames contain only `[A-Za-z0-9._-]` and no `--`.
For other basenames, the worker replaces unsafe characters with `_` and collapses runs of `-` to one `-`.
It then appends `-<hash>`, using the first eight SHA-256 hex characters of the resolved path, without creating `--`.

The worker removes stale worktree projects only when their root paths no longer exist on disk.
It preserves mounted repo IDs, current worktree names across all mounted repos, and names with no folder suffix.
Edits during a session enter the graph at the next session or a manual `index_repository`.
Treat a live-session graph answer as provisional, as Tier 1 (Scout) does.

## Updating the tool

The workspace pins one CBM version: `PINNED_VERSION` in `scripts/setup-map-tool`. The session-start
hook and `ws health` both report when the installed binary differs from the pin.

When the operator asks to update the tool:

1. Pull the workspace branch that carries the pin. Do not change the pin unless the operator asks
   for a new version (see below).
2. Tell the operator that the next step stops every running CBM session on this machine, including
   other agent sessions. Then run `ws map install`. It verifies the download against the release
   checksums, swaps the binary, registers the clients, and removes the always-on block that the
   installer writes into global agent instruction files.
3. Ask the operator to restart agent sessions. The next session-start hook re-indexes each mounted
   repo and worktree. After a version change, that first index can be a full rebuild.
4. Check that `codebase-memory-mcp --version` matches the pin and that `index_status` shows each
   repo as `ready`.

To move to a newer release than the pin: change `PINNED_VERSION`, run `ws map install`, run
`python3 platform-internals/tests/test_code_map.py`, and run `ws map generate <id>` on one repo to
check its output. Read the release notes for breaking changes. `scripts/` is template-owned, so
the pin change also goes to the template.

## Quick Decision Matrix

| Question | Tool call |
|----------|----------|
| Who calls X? | `trace_path(direction="inbound")` |
| What does X call? | `trace_path(direction="outbound")` |
| Full call context | `trace_path(direction="both")` |
| Find by name pattern | `search_graph(name_pattern="...")` |
| Dead code | `search_graph(max_degree=0, exclude_entry_points=true)` |
| Cross-service edges | `query_graph` with Cypher |
| Impact of local changes | `detect_changes()` |
| Risk-classified trace | `trace_path(risk_labels=true)` |
| Text search | `search_code` or Grep |

## Handling Colloquial & Business Concepts (Synonym Expansion)

When investigating broad domain topics or colloquial terms (e.g. "payments", "notifications", "sessions"):
1. **Never query AST nodes using only English colloquial terms.** Natural-language concepts rarely match AST class/method names 1:1.
2. **Consult `team-context/domain-glossary.md`**, if the workspace has one, to expand domain concepts into code identifiers.
   Example shape: *Payments* → `BillingService`, `ChargeTask`, `InvoiceRepo`.
3. **Query the code map with resolved identifiers** across every mounted project that the concept spans.

## Exploration Workflow
1. Use the known repo ID in `search_graph` or `trace_path` before broad structural code searches.
2. Use `list_projects` only when the ID or index state is unknown, or a query reports a missing project.
3. Check coverage for the returned paths before relying on them.
4. Read the relevant decision function with `get_code_snippet` or a narrow source read.
5. **Anti-pattern prohibited**: Do not read large source files (>150 lines) linearly with `view_file` to discover methods or classes. `search_graph` provides the complete method manifest in ~40 lines.

## Tracing Workflow
1. `search_graph(name_pattern=".*FuncName.*", detail="ids", limit=10)` — get the qualified name
2. `trace_path(function_name="<qualified name from step 1>", direction="both", depth=3)` — trace
3. `detect_changes()` — map git diff to affected symbols

For short or common names (`Data`, `Info`, `Create`), first use `search_graph` with `detail: "ids"` and a path filter.
Pass the returned qualified name to `trace_path`.

## First Move

Structural questions go to the graph: where a symbol is defined, who calls it, what it calls,
what a change reaches. Do not open with grep, rg, find, or file reads for those.

Text search stays correct for what the graph does not hold: string literals, configuration and
data files, comments, and ranges `check_index_coverage` reports as uncovered. Use the shell
(`rg`) for those — `search_code` is for finding a symbol you then query structurally, not a
general grep.

## What Counts As Enough

Work one production entry point at a time. For the one you are about to change, you need to be
able to name three things:

1. the production entry point for the behavior you are changing,
2. the function that decides that behavior, and
3. any branch that can bypass it.

`search_graph` finds the entry point, `trace_path` gives callers and callees, and
`get_code_snippet` shows the entry and decision functions. `check_index_coverage` checks the
paths you are about to edit — read any uncovered ranges directly.

Run `trace_path` on an entry point before your first edit to it: callers and callees are what
the graph gives you that text search cannot. `get_code_snippet` is only for the entry and
decision functions you have already named — to see anything else, open the file.

Apply the test per entry point. Check behaviors that enter through the same function together.
This is a sufficiency test, not a checklist to exhaust. The
moment you can name all three, stop querying and edit that entry point, then move to the next —
do not explore every requirement before making any edit. If two calls get you there, two calls
was the right number. Implement and test the task-required paths plus every relevant active
path the trace found.

## Retrieval Budget

A graph query pays for itself only when it removes a file read. Keep each one narrow: pass
`label` and `file_pattern`. Use `detail: "ids"` with `limit` at or below 50 to check a known name.
Page with `offset` (`search_graph` reports `total` and `has_more`) or `cursor` (`trace_path` returns `next`).
Do not raise `limit` to avoid pagination.

Three calls cost more than the file reads they replace. In the pilot they made up 72% of all graph
output:

- **No `index_status` while exploring.** It lists every partly parsed file (38k characters in one
  call). Use `check_index_coverage` on the paths you rely on instead.
- **`search_code`: don't pass `mode=full`.** It returned 13–14k characters a call. Compact returned
  1.6–4k.
- **`get_code_snippet` on one method or function, never a whole class** (one class returned 15k
  characters). Find the method first with `search_graph` or `get_file_outline`.

## Stop

Once you make your first code edit, stop browsing the graph. For the remainder of the run,
spend a graph query only on a structural question that materially affects correctness and
cannot be answered from the files already open.

Before that first edit, stop as soon as the three questions above are answered. Re-running a
query with wider parameters, or re-reading a file the graph already answered for, buys no new
evidence.

## Evidence Tiers
- **Scout (Tier 1):** use few queries and targeted source checks. Treat results as provisional. Do not claim absence, completeness, or dead code.
- **Verify (Tier 2, default):** use relevant trace directions, exact snippets, and all relevant result pages. This evidence tier checks task-specific claims.
- **Auditor (Tier 3):** check a bounded scope with a current graph, complete pagination, and relevant call directions. State unresolved limits.
- **Every tier:** after candidate paths are known, call `check_index_coverage` once with every evidence path. For negative or exhaustive claims also include the relevant scopes. A clean result means no recorded gap, not proof of completeness. For partial, skipped, excluded, stale, pending, or unknown coverage, read/grep the reported ranges or scope before relying on the graph.

## Sessions and Subagents
- Use a known project in the first structural query. List projects only when needed. Choose Scout, Verify, or Auditor for the task.
- Before delegating a broad structural investigation, choose `codebase-memory` (`codebase-memory-scout` for a quick lookup). Never choose `Explore` or `general-purpose`.
  Query the graph and coverage in the parent. Pass the tier, project, freshness, scope, first query, symbols, paths, pagination state, and coverage limits.
- Runtimes such as Hermes isolate child context. Put graph findings in the `context` argument to `delegate_task`.
  Do not assume that the child inherits MCP access or the parent's conversation.
- A child without MCP tools must state that limit. Use supplied graph evidence and read exact uncovered source ranges.

## Quality Analysis
- Dead code: `search_graph(max_degree=0, exclude_entry_points=true)`
- High fan-out: `search_graph(min_degree=10, relationship="CALLS", direction="outbound")`
- High fan-in: `search_graph(min_degree=10, relationship="CALLS", direction="inbound")`

## 15 MCP Tools
`index_repository`, `index_status`, `list_projects`, `delete_project`,
`search_graph`, `search_code`, `trace_path`, `detect_changes`,
`query_graph`, `get_graph_schema`, `get_code_snippet`, `get_architecture`,
`check_index_coverage`, `manage_adr`, `ingest_traces`

## Edge Types
CALLS, HTTP_CALLS, ASYNC_CALLS, DATA_FLOWS, IMPORTS, DEFINES, DEFINES_METHOD,
HANDLES, IMPLEMENTS, OVERRIDE, USAGE, CALL_REFERENCE, CONFIGURES, FILE_CHANGES_WITH,
SIMILAR_TO, SEMANTICALLY_RELATED, CONTAINS_FILE, CONTAINS_FOLDER,
CONTAINS_PACKAGE

## Cypher Examples (for query_graph)
```
MATCH (f:Function) WHERE f.name = 'main' RETURN f.name, f.file_path LIMIT 3
MATCH (a:Function)-[r:CALLS]->(b:Function) WHERE a.name = 'main' RETURN a.name, b.name LIMIT 3
```

## Gotchas
1. `search_graph(relationship="HTTP_CALLS")` filters nodes by degree — use `query_graph` with Cypher to see actual edges.
2. `query_graph` has a 100k row ceiling — add a Cypher `LIMIT` for broad queries or use `search_graph` pagination.
3. `trace_path` needs qualified names for short or common names. First use `search_graph(name_pattern=..., detail="ids")` to get them.
4. `direction="outbound"` misses cross-service callers — use `direction="both"`.
5. `search_graph` results default to 50 per page — check `has_more` and use `offset`.

## Empty Results and Syntax Errors

Map domain terms through the glossary before changing a name pattern.
Use identifier fragments such as `.*(Billing|Charge|Invoice).*`, or `^KnownName$` for an exact name.
Do not add `(?i)`. `name_pattern` already ignores case, and a `(?i)` prefix returns zero rows (October 13 check: `^MAIN$` matched `Main`, `(?i)^Main$` matched nothing).
An empty result does not establish that the feature is absent.
Check the project, candidate names, and path coverage before a source fallback.
File names, scripts, and configuration values remain literal search targets.

The bounded Cypher examples above executed successfully through native MCP during the October 12 checks.
Use one `MATCH`, simple predicates, explicit return fields, and a small `LIMIT` before expanding a query.
Check `get_graph_schema` only when a query needs unfamiliar labels or properties.
If a syntax error occurs, simplify the query before another attempt.
Do not assume that this engine supports every Cypher feature, including list expressions or nested queries.
State whether the fallback follows missing tools, a missing index, unsupported targets, incomplete coverage, or invalid syntax.
