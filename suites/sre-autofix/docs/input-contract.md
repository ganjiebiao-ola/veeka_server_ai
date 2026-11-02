# Input contract — what `run claim` accepts and reads

The suite consumes the upstream report **as a local file**; it never fetches from Slack, HTTP or
another host. Two forms are accepted (`lib/inputs.py`):

| Form | Detect | Required | Optional |
|---|---|---|---|
| **archive directory** (an ola-sre-agent incident dir) | dir contains `bugissue-draft.json` | `bugissue-draft.json` (the 22-field packing draft), `issue.draft.md` (the Egress-scrubbed 12-section render, used **verbatim** as the INCIDENT.md 根因 section) | `alert.json`, `route.json`, `state.json`, `egress.json`, `n2/pr.json` |
| **`report.json` v1.1** (the Slack-thread attachment `report-<id>.json`) | a JSON file with `report_version` | `incident.id`, `root_cause.statement` | `attachments.draft` / `attachments.issue_md` (resolved next to the file, then under `incident.archive_dir`) |

A `report.json` sitting next to `bugissue-draft.json` is upgraded to the archive form (richer:
evidence excerpts). A bare `bugissue-draft.json` is refused with a hint to pass its directory.

## Fields consumed from `report.json` v1.1

| report.json | Used for |
|---|---|
| `incident.{id, fingerprint, rule_uid, rid, rule_name, subject, title, eval_epoch, archive_dir}` | `## 告警` in INCIDENT.md, PR body 关联 block, machine tag |
| `root_cause.{statement, chain, confidence, confidence_basis, severity, severity_basis, impact.*, repro.*, suggested_fix}` | eligibility (confidence), source-file candidates (statement + suggested_fix), PR body |
| `root_cause.{cause_locus, cause_locus_basis}` (v1.1; empty on v1.0 reports) | eligibility predicate 根因归属=代码缺陷 — `""` passes with a trace, only `code_defect` passes otherwise |
| `evidence[].{claim, tool, ref, query, time_window}` | `tool_call_id` is parsed from `ref = ev://<id>/tool/<tcid>`; **`excerpt` is not in report.json** |
| `excluded_hypotheses[]`, `data_gaps[]`, `suspect_change`, `duplicate_of` | PR body; candidates; dedup check |
| `fix.pr.{state, review_summary}` | `state == closed` with a non-empty `review_summary` → **返修 mode**: the text becomes `## 人工评审意见（必须遵照）` |
| `sufficiency.{total, grade}`, `degradations[]` | PR body header |
| `scrub.egress_blocked` | `true` → `claim` refuses the input (exit 2) |
| `attachments.{draft, issue_md}` | upgrade to the full draft / verbatim render when reachable |

When no `issue.draft.md` is reachable, the 根因 section is **reconstructed** from the fields above
(`reconstruct_issue_md`): same 12 headings, an evidence table with `ev://` refs, and the note that
excerpts live in the archive. The incident's `degradations` records this. Prefer the archive form.

## Claim criteria (local form of `eligibility.go`)

Five reasons, names identical to upstream, all evaluated (never short-circuited):

1. `置信度达标` — `confidence ≥ min_confidence` (`--min-confidence` > `config.yaml min_confidence` > `medium`).
2. `根因归属=代码缺陷` — `cause_locus ∈ {code_defect, ""}`; anything else parks ("code is the propagation path").
3. `非重复件` — `duplicate_of` empty/`none` passes; otherwise passes with a note unless
   `runs/sre-autofix/<dup>/pr.json` shows this workspace already opened a PR for it.
4. `预算预留充足` — always ok locally (no ledger; headless spend is capped by `max_budget_usd`).
5. `修复目标可定位` — source-file basenames (`SRC_FILE_RE`, 17 extensions) from statement +
   suggested_fix + suspect_change, located by basename in the base tree (`git ls-tree`) of every
   configured **and mounted** repo; exactly one repo must hit. `--repo`/`--file` override the search.

Not passing → phase `parked`, exit 3, nothing else written. `eligibility.json` = the upstream shape
(`passed`, `reasons[]{name, ok, detail}`, `repo`, `files`, `blocked_reason`) plus `evaluated_at`,
`min_confidence`, `base_ref`, `base_sha`, `notes[]`.
