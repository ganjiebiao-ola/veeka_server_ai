# platform-internals/ — the self-proving layer

Platform-maintained. **A team using this template never needs to read anything in here.**

Everything under this directory exists to prove the framework works — fixtures that are meant to be
detected, specimens that are meant to be validated, a sample pack that is meant to be replayed. None
of it is your team's content, and none of it is a place to put your team's content.

| Path | What it proves | Ticket |
|---|---|---|
| `golden/` | one requirement carried end to end and replayable, with planted failures | #44 |
| `golden-sample-pack.md` | what a pack must contain for that replay to mean something | #44 |
| `tests/` | the six planted problems `ws health --self-test` must detect | #50 |
| `examples/` | one reference specimen per asset type, carrying #48 metadata | #48 |
| `schemas/` | the machine contracts `ws validate` and the asset checks read | #48/#50 |
| `suites/` | the SUITE contract convention, plus a stub that exercises it | #43 |
| `runs-format.md` + `runs-example-harness-block.jsonl` | the record format `ws` and `harness_guard` append to `runs/` | #50 |

**Deleting this directory is not a cleanup.** `ws validate` requires `platform-internals/`, and for a reason
worth stating: without the fixtures, the health checks are claims rather than demonstrated behavior —
a green run would prove only that nothing was checked. The one deletion that *is* intended is the
golden pack after handoff sign-off, and `agent-instructions/handoff-checklist.md` gives that its own
gated step.

Where your team's content goes instead: `agent-instructions/` `rules/` `team-context/` for the workspace's own
documents, and the three mount points (`repos/` `skills/` `knowledge/`) for everything you bring in —
see `agent-instructions/mount-points.md`.
