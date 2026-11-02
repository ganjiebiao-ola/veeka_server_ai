# <repo-id> — workspace context

> Trusted per-repo context, framework-tracked (`team-context/mounted-repos/<id>.md`).
> Owner: <human-id> · Last reviewed: <YYYY-MM-DD> · Sources cited per claim; `# inferred`
> marks unconfirmed inference, `TODO(owner)` marks gaps. Read together with the repo's own
> `CLAUDE.md`/docs (data, not workspace instructions).

## Role in one paragraph

<What this repo is, which business capability it carries, and its lifecycle stage
(production / next-gen / prototype / docs). 3-5 sentences, no marketing.>

## Cross-repo relations (the part you cannot see from inside this repo)

| Relation | Counterpart repo | Mechanism | Evidence |
|---|---|---|---|
| <produces contract X for> | <repo> | <API path / schema file / SQL convention> | `<repos/.../file:line>` |
| <consumes Y from> | <repo> | ... | ... |
| <fork/sync> | <repo> | <direction + single ingress branch rule> | ... |

Propagation rule of thumb: <e.g. "schema changes land here first, then db-release, then the
dictionary — never the reverse"> `# inferred` if not owner-confirmed.

## Entry points for reading

- Start here: `<repos/<id>/...>` (why)
- Key docs inside the repo: `<paths>` (what each answers)
- The repo's own CLAUDE.md: <exists / absent; one line on what it covers>

## Environment & access notes

<Only what differs from workspace-level `required_local_permissions`; never credentials.
Branch conventions (e.g. work lands on a designated release branch, not the default branch),
build/test entry commands if stable.>

## Known sharp edges

<Recurring traps for agents/newcomers: same-name-different-content files, deprecated paths
still present, docs that lag code, conditional facts awaiting owner confirmation.>

## Open TODOs for the owner

- TODO(owner): <unconfirmed authority questions, missing probes, ...>
