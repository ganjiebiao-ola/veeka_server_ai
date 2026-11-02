# Code map (graph-first code navigation)

Each mounted repo `repos/<id>` has a **code map**: a `codebase-memory-mcp` graph of its
functions, calls, routes, and imports. Use it to narrow structural investigations and expose call relationships.
No measurement has established net token savings. Measure complete tasks before claiming a saving.

## Two-Stage Exploration Standard

0. **Use the known repo ID directly.** Make one real `search_graph` or `trace_path` query before broad code searches on a structural question.
   Use `list_projects` when the ID or index state is unknown, or a query reports a missing project.
   Project listing alone does not answer the task.
   An earlier literal lookup does not violate this rule.

   For cross-repo questions, read `knowledge/maps/overview.md` to select repos, then their trusted `team-context/mounted-repos/<id>.md` context.
   For unfamiliar repo orientation, call the live graph's `get_architecture`. Use the live graph for symbols and calls.
   The manifest's `structural-code` and `repo-orientation` task types record these read orders.

1. **Stage 1 (Vocabulary Discovery & Synonym Expansion)**:
   - When asked about a domain feature or colloquial concept (e.g., "payments", "notifications", "sessions"),
     do not query AST nodes with only the English colloquial term.
   - Map colloquial terms to the repo's actual code identifiers, in this order:
     1. `team-context/domain-glossary.md`, if the workspace has one (e.g., `payment` → `BillingService`, `ChargeTask`).
     2. `search_graph` with a regex of candidate names (e.g., `name_pattern=".*(Billing|Charge).*"`).
     3. `rg` only if both miss.

2. **Stage 2 (Graph-First AST Navigation)**:
   - For structural questions (symbol manifests, who calls X / what X calls, where a route or handler
     lives, architecture, blast radius), **query the code map first** (`search_graph`, `trace_path`,
     `detect_changes`, `query_graph`). How to query it: `skills/code-map-query/SKILL.md`.
   - For short or common names (`Data`, `Info`, `Create`), use a qualified name with `trace_path`.
     If unknown, first use `search_graph` with `detail: "ids"` and a path filter to get it.
   - **Anti-pattern prohibited**: Do not read whole large source files (>150 lines) just to discover what
     methods or classes exist. `search_graph` gives a symbol list in
     ~40 lines. Use `get_code_snippet` or narrow file reads only for pinpoint verification of decision logic.
   - **Check coverage before trusting the graph:** call `check_index_coverage` for the files you rely on.
     The graph can have gaps. Read or `rg` any range it reports as uncovered.
   - **Before delegating a broad structural investigation** (a whole feature flow, or several repos), choose
     `codebase-memory` (`codebase-memory-scout` for a quick lookup). Never choose `Explore` or `general-purpose`.
     Pass the repo ID, target symbol, bounded scope, first query, and known coverage limits.
     If the target role lacks graph tools, delegate to a graph subagent instead, or pass your graph evidence.
     State the access limit instead of silently treating search-only work as graph verification.

- **Runtime access:** a mounted folder, registration command, or successful CLI probe does not prove native or subagent tool access.
  Test `search_graph` and `check_index_coverage` in the actual client and role.
  Use the exact prefix `mcp__codebase-memory-mcp__` (hyphens, not underscores).
  Diagnose Read augmentation separately from direct graph queries.
- **Query failures:** on `No such tool`, check the name. Load deferred tools with `ToolSearch`. Retry before using `rg`.
  Distinguish a missing project, wrong vocabulary, unsupported targets, coverage gaps, and invalid syntax.
  State the fallback reason. Use the query skill's bounded examples before composing larger Cypher queries.

- **Good fit for grep (`rg`):** literal strings, error messages, config values, non-code files, and uncovered ranges.
- **"Where is endpoint X"** → if the workspace has a route inventory at `knowledge/api/ENDPOINTS.md`
  (method, path and handler for every endpoint, built from the router code), `rg` the path there, then
  query the handler in the graph. The graph's `Route` nodes miss routes that a loop registers from a table.
- **Ignore "no indexed graph project matched this working directory"** from the session-start and
  subagent-start hooks. It only checks the folder the session started in (the workspace root).
  Graph projects belong to individual repos. A mounted folder does not prove an index exists.
  Use a known repo ID in the first query. When you delegate, tell the
  subagent the same.
- **Set it up yourself, don't hand it back:**
  - No `mcp__codebase-memory-mcp__*` tools in your tool list → first call `list_projects` on the
    `codebase-memory-mcp` server by name. Some clients (Codex 0.162) leave MCP tools out of the list
    the model sees but still run them when called. Only if that call fails, run `ws map install` and
    `ws map generate --index-only --all`, then use grep for now and tell the operator to reload the
    session.
  - Tools present but the repo is missing from `list_projects` → call `index_repository` with
    `repo_path` = the absolute `repos/<id>` path and `name` = `<id>`. First, if
    `knowledge/maps/<id>/.cbmignore` exists, copy it to `repos/<id>/.cbmignore` and add `/.cbmignore`
    to that repo's `.git/info/exclude` — keep the copy, the tool's auto re-index reads it.
  - Resolve the repo's path from `workspace.local.yaml`. Compare snapshot provenance with that checkout's HEAD, including feature branches.
    Report uncommitted changes separately. Check live coverage for edited files.
    Do not regenerate a snapshot during a task: it leaves changed files under `knowledge/` for the
    operator.
  - `index_repository` fails with a daemon coordination error → run
    `scripts/generate-map <id> --index-only`. It restarts a stuck daemon and retries, and writes
    nothing under `knowledge/`. The restart cuts the graph tools in every open session, including
    yours. Continue with `rg`, and tell the operator to exit and resume their sessions.
