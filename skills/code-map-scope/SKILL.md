---
name: code-map-scope
description: Decide what a repo's code map covers — review the mounted repo's layout and write the .cbmignore that keeps generated code, vendored deps, historical docs, binary blobs and anything holding credentials OUT of the graph. Use before the first `ws map generate <id>` for a repo, when a map comes back dominated by generated files, when someone asks "why is this junk in the graph", when the repo's layout has moved, or when `scripts/generate-map` reports the .cbmignore as missing or stale. Chinese triggers, 中文触发:"给这个仓写 cbmignore"、"代码地图里都是生成代码"、"更新忽略规则"、"地图噪音太大".
id: skill:code-map-scope
type: skill
owner: EricZhang
version: "292a27ee4ed49920dbe171dc9c4ff988c2ce58ab"
status: active
summary: Scope control for a repo's code map — the exclusion list deciding what the knowledge graph does not index, written to knowledge/maps/<id>/.cbmignore and stamped with who reviewed it.
use_when: A mounted repo has no .cbmignore yet, its map is full of generated noise, or scripts/generate-map reports the existing one as stale (>90 days since review).
usage: Read the repo's layout, write knowledge/maps/<id>/.cbmignore, then `scripts/generate-map --stamp-cbmignore <id>` and `ws map generate <id>` to apply it.
dependencies: ["skill:code-map-query"]
regression: ["regression-case:code-map-scope-smoke"]
---

# code-map-scope — decide what a repo's code map covers

A **code map** is the machine-generated structural layer for one repo, living at
`knowledge/maps/<repo-id>/` — one part of that project's map, which also carries the
cross-repo and human-authored context a graph can't derive. This skill decides that code map's
**scope**: which of the repo's files the graph is built from, expressed as the exclusion list it is
*not* built from.

Scope is what makes the map worth reading. Indexing 936 generated `*.pb.go` files puts
machine-written code nobody edits at the center of the call graph, burying the ~50 functions a
person actually changes.

**This is a rare, deliberate act.** A `.cbmignore` goes stale only when the repo's layout moves, so
expect to run this once per repo and revisit it a couple of times a year — not on every map refresh.

**Two ways in, same procedure.** `scripts/generate-map` runs this headlessly by default when a repo
has no `.cbmignore` yet (`claude -p` / `codex exec`, stamped `via: agent-auto`) — no human needs to
be in the loop. A person can also run it directly, which is the right call when the repo has unusual
layout conventions the survey below would miss. Either way the output is the same file, reviewed by
the same rules, and the accountable identity recorded is the human operator's.

## Where the file lives, and why it isn't in the repo

The canonical copy is **`knowledge/maps/<id>/.cbmignore`**, framework-tracked and reviewed via PR.
`scripts/generate-map` copies it into `repos/<id>/.cbmignore` and leaves that copy in place, hidden
from the business repo's git via its local `.git/info/exclude` — the MCP server's background reindex
reads it too. The copy is never committed to the business repo
(`agent-instructions/mount-points.md`: "does not modify your business code structure"). Edit only
the `knowledge/` copy; `generate-map` overwrites the repo copy on its next run.

## Procedure

1. **Confirm the target.** The repo must be mounted and registered — check `workspace.local.yaml`,
   and read `team-context/mounted-repos/<id>.md` first: its "Known sharp edges" section often
   already names the generated/vendored trees (e.g. "no `composer.json` — deps vendored under
   `app/libs/`", "`.pb.dart` files are message schemas, not RPC stubs").
2. **Survey the layout, don't guess.** From the workspace root, look at what actually exists and how
   big it is — top-level dirs, then the generated-file counts:

   ```sh
   ls repos/<id>
   find repos/<id> -name '*.pb.go' -o -name '*_generated.go' -o -name '*.pb.dart' | wc -l
   du -sh repos/<id>/* | sort -rh | head -20
   ```

   Every path you write must be one you confirmed exists. A `.cbmignore` full of speculative paths
   is worse than none: it reads as reviewed while excluding nothing.
3. **Classify into the four buckets** (keep these as comment headers in the file, they are why the
   next reader trusts it):
   - **Sensitive configuration** — anything holding credentials. This is the credential red line
     (`agent-instructions/security-defaults.md` §3): keep secrets out of the graph entirely, not
     just out of git.
   - **Generated artifacts** — protobuf output, generated DAO/model layers, codegen targets. Keep
     the hand-written layers and the `.proto` sources; exclude the machine output.
   - **Historical / non-runtime material** — `document/`, `docs/`, `deploy/`, per-module doc dirs.
   - **Binary and static data** — `public/`, asset dirs, `*.bin`, `*.db`, `*.log`, big CSVs.
   - **Vendored dependencies** — `vendor/`, `node_modules/`, `app/libs/`. Exclude them even when
     absent from a plain clone, so the rule holds after someone runs `go mod vendor`.
4. **Write the file** to `knowledge/maps/<id>/.cbmignore`, gitignore syntax (`/dir/`, `**/*.pb.go`).
   Lead with a header saying which HEAD you reviewed against and how to re-stamp it.
5. **Stamp and apply:**

   ```sh
   scripts/generate-map --stamp-cbmignore <id>    # records who reviewed it, when, via what
   ws map generate <id>                           # regenerate with the exclusions applied
   ws map verify                                  # smoke-test the artifacts
   ```
6. **Report the delta.** Compare node/edge counts in `knowledge/maps/<id>/README.md`
   before and after. A good exclusion list visibly drops the counts (one large Go repo dropped from
   49,932 to 38,286 nodes and 406k to 244k edges). If nothing moved, your paths didn't match — go back to step 2.

## Hard rules

- **Never exclude hand-written production code** to make a map smaller. The point is removing noise,
  not shrinking the graph; an entry point that vanishes from the map is a bug you introduced.
- **Never write into `repos/<id>/`.** Canonical copy is under `knowledge/maps/<id>/`
  only.
- **Confirm every path exists** before writing it (step 2).
- **Don't stamp a file you didn't review.** The stamp records a human-id as accountable — that
  claim has to be true, including when an agent did the typing (`via: agent-session` says how, the
  operator says who).
