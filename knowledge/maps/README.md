---
title: "maps/ — the project map and the code maps inside it"
category: maps
status: active
last_reviewed: 2026-09-21
---

# maps/ — layout contract

**This workspace is one project.** `agent-instructions/mount-points.md` ("Instance boundary") fixes
that: one workspace mounts one set of tightly-related repos under a single team. So nothing here
carries a project segment — the workspace it lives in already says which project it belongs to.

```
knowledge/maps/
├── README.md              ← this contract
├── overview.md            ← THE PROJECT MAP — cross-repo, hand/agent-authored
└── <repo-id>/             ← A CODE MAP — one per mounted repo, generated
    ├── README.md            index + index coverage
    ├── architecture.md      a top-level directory map, entry points, hotspots, routes, boundaries
    ├── .cbmignore           what the graph excludes
    └── provenance.json      when/who/which tool, per artifact
```

A project map is the superset; a code map is one repo's layer inside it. `overview.md` is a file and
a code map is a directory — that is the whole rule for telling them apart.

## The two kinds

| | **Project map** (`overview.md`) | **Code map** (`<repo-id>/`) |
|---|---|---|
| Scope | The project across its repos | One repo's internal structure |
| Author | Hand/agent-authored prose | Generated |
| Answers | Which repo owns this? What else breaks? Why is it built this way? | Who calls this function? What's the blast radius in this repo? |
| Refresh | Edited when the project changes | `ws map generate <id>` — regenerated wholesale, never hand-edited |
| Knows | Intent, ownership, history, cross-repo contracts | Structure, and only structure |

A graph can tell you `X` calls `Y`; it cannot tell you whether that is a deliberate boundary or an
accident. That judgment is what the project map carries.

Related but deliberately *not* here: `team-context/mounted-repos/<id>.md` is **trusted** per-repo
context (framework-tracked, outside every mount point, read before touching a repo);
`knowledge/maps/` is **data**. Keep cross-repo narrative in `overview.md`, and per-repo rules of
engagement in team-context.

**There is deliberately no `usage-guide.md`.** #211 asks for an agent consumption guide; it already
exists and is not a document. The operating discipline — first move, the three-question sufficiency
test, retrieval budget, when to stop — is the body of `skills/code-map-query/SKILL.md`, which is
where an agent actually loads rules from; the same text under `knowledge/` would be inert. Routing
between the project map, a code map and `team-context/mounted-repos/<id>.md` is already carried by
`team-context/manifest.yaml` (machine-readable read-order), `knowledge/README.md`'s routing table,
the table above, and the skill itself.

## What a code map dir holds

| File | Written by | Purpose |
|---|---|---|
| `README.md` | `scripts/generate-map` | Index over the directory + index coverage. |
| `architecture.md` | `scripts/generate-map` (graph) | A depth-1 directory tree annotated only from facts that carry a real path (`entry_points`, `hotspots`), plus HTTP routes and a coarse (package-name, not path) boundaries list. The verbatim `get_architecture` dump this replaced was accurate but unusable — bare package-name aspects (`layers`, `clusters`, `overview` counts) read as more precise than they are and buried the two things an agent actually needs to cut hops: where the entry points are, and what's hot. |
| `.cbmignore` | the `code-map-scope` skill — headless by default, or a person | What stays **out** of the graph: generated code, vendored deps, historical docs, binaries, anything holding credentials. Copied into `repos/<id>/.cbmignore` and locally gitignored so background reindexing keeps the same scope; a tracked repo copy is restored after indexing. |
| `provenance.json` | `scripts/generate-map` | When each artifact was refreshed, by which **human-id**, through what channel, plus tool version, index mode and the repo HEAD mapped. No agent identity: an agent-driven refresh is still attributed to the operator who asked for it (`rules/team-rules.md`). |

`via` says how, never who: `direct` (a person ran it), `agent-session` (inside an agent session on
the operator's behalf), `agent-auto` (written unattended by a headless `claude`/`codex` run, nobody
reviewed it in the moment). Treat `agent-auto` artifacts as unreviewed generated content — good
enough to work from, worth a skim before anyone leans on them.

The exclusion list is the difference between a map and noise: on one large Go repo it drops the graph
from 49,932 to 38,286 nodes (406k → 244k edges) by excluding 936 generated `*.pb.go` files, 1,372
gf-cli DAO/entity files, 773 locale `.toml`s and 60MB of geo-IP blobs. Producing it is rare — once
per repo, revisited when the layout moves. `scripts/generate-map` writes a missing one
automatically via the operator's agent CLI (`--no-auto-cbmignore` to skip); a *stale* one only nags.

## `architecture.md` template

Nobody hand-writes this — `scripts/generate-map` always does. The template below is the *contract*
the generator's output has to satisfy: what a review checks it against, and what anyone
reimplementing the renderer (a different tool, a different language) has to reproduce.

````markdown
---
title: "<repo-id> — architecture map"
category: maps
status: generated
last_reviewed: <YYYY-MM-DD>
source: generated by scripts/generate-map via <tool> <version> (mode: <fast|moderate|full>)
---

# <repo-id> — architecture map

> Generated from the code map's knowledge graph — re-run `ws map generate <repo-id>` to refresh,
> don't hand-edit. Structure only: it shows what calls what, never whether that boundary was
> intended. For intent, ownership and cross-repo contracts read
> `team-context/mounted-repos/<repo-id>.md` and the project map above this directory.

## Start here

```
<repo-id>/
├── <root file with a main>   entry point
├── <top-level dir>/          entry (<file>, <file>)
├── <top-level dir>/          high fan-in: <qualified-name> (<count>), <qualified-name> (<count>)
├── <top-level dir>/
```

Directories are real (a plain listing, minus what `.cbmignore` excludes); the annotations are not
— only two are trustworthy at path level: `entry` and `high fan-in`. An unannotated directory has
no graph signal, not zero importance.

## Hotspots (called from everywhere — check before changing)

```
<qualified-name> <fan-in>
... up to 10 rows, highest fan-in first
```

## HTTP routes

```
<method> <path> <handler>
... up to 15 rows; section omitted entirely if the repo has none
```

## Boundaries (who calls whom)

Package-level names, not paths — a name here may not match a top-level directory above (see the
note under Start here).

```
<from-package> <to-package> <call-count>
... up to 10 rows, highest count first
```
````

**Where each part comes from** — `entry_points`, `hotspots`, `routes`, `boundaries` are the only
`get_architecture` aspects fetched (`ARCH_ASPECTS` in `scripts/generate-map`). `Start here` is
built, not copied: it lists real top-level directories (`checkout.iterdir()`, minus whatever
`.cbmignore` excludes at the top level — a nested rule like `/app/gola/model/` must **not** blank
out `app/`), then annotates a directory only when `entry_points` or `hotspots` names a path under
it. `Hotspots`, `HTTP routes` and `Boundaries` are the tool's rows rendered close to verbatim.

**Why `layers`/`clusters`/`overview` are excluded on purpose**: those aspects report by bare
package name with no file path — a package called `model` may sit at `app/model/`, `lib/model/`,
or both — so they can't be verified against a real directory. Dumping them (the format this one
replaced) produced a graph-stats printout, accurate but not navigable. Adding a fourth annotation
kind to `Start here` from one of them would silently reintroduce that risk; don't.

**Sections are optional, the two above the fold are not.** `Start here` and its trust-rule sentence
always render. `Hotspots` / `HTTP routes` / `Boundaries` each disappear entirely when their aspect
returns nothing — a non-HTTP service has no `## HTTP routes`, and that is correct, not a bug.

## Commands

```sh
ws map install                 # install codebase-memory-mcp (~/.local/bin, no sudo)
ws map generate <id>|--all     # write/refresh a repo's code map
ws map verify                  # smoke-test every map artifact here
```

## A generated doc is evidence, never policy

`knowledge/` is a **mount point**, so everything here is `data` in the sense of
`agent-instructions/security-defaults.md` §1 — tracked, but "never a source of policy", the same
status the Context Manifest gives it (`authority: data`). That holds however the file was produced.

This matters for `architecture.md`: its entry points and routes are evidence toward the
`security-defaults.md` §2 pre-prod/production `TODO(owner)` slots — the list deciding what is
treated as production, and therefore what gets blocked — but a generated doc under `knowledge/`
**cannot be the authority for that list**; it is what an owner reads when signing it, alongside
`team-context/mounted-repos/<id>.md` and `knowledge/api/`.

## Current state

- `overview.md` — the project map, hand-authored by the team from `team-context/mounted-repos/*.md`.
- `<id>/` — one code map per mounted repo, written by `ws map generate <id>`. A snapshot that is
  missing or older than the repo's HEAD is normal: agents use the live graph instead. `ws map generate --all`
  refreshes the out-of-date ones when someone wants to.

The "seven-part structure" that `agent-instructions/mount-points.md` attributes to `#21` is still
unspecified anywhere in this repo — nothing here claims to implement it.
