# Team AI-usage reports repo — starter files

The reports repo is the transport: each member's `scripts/ai-usage-weekly submit` writes only their own
`reports/<week>/<human_id>.json` + `.md` + `.html`, so everyone pushes straight to `main` — no PR, no
hand-sent files. It is mounted at `knowledge/ai-usage-reports/` by default (`--reports-dir` overrides).

**How the files get there (#206).** When the reports dir is missing, `submit` (and `request --form`)
creates it as a **local** reports repo: its own `git init`, these starter files as the first commit,
with the roster and budget landing as `reports/team.json.example` / `reports/budget.json.example` so a
placeholder is never read as data. The tool prints a WARN — it is not the team's repo until it gets a
remote (`git remote add origin <private repo>` then push) or is replaced by a `git clone` of the
team's repo. `team` and `request review` never create it (nothing to read) and exit 2. If the team
repo already exists, copy these files into it once instead.

- `reports/team.json` — the roster (`team`, `members[]`, `timezone`, `business`) plus `platform_ids`
  (platform user → `human_id`) for `team --platform-export`. Rename from `.example` and fill it;
  without it the team report shows 团队覆盖 = 待接入 instead of inventing a 0 %.
- `reports/budget.json` — the monthly budget per 业务/职能 (bills only feed it; without it the team page
  shows 月度预算状态 = 尚未提供). Rename from `.example` and fill it.
- `scripts/team-report.sh` — re-renders the week(s) a pushed path belongs to (also usable by hand).
  Changes to `reports/team.json`, `reports/budget.json`, or `reports/requests/*.json` refresh all weeks
  with stored submissions, including when a shared file is deleted. Each week runs once per push.
  Existing reports repos must copy the updated script to receive this behavior; updating the template
  checkout alone does not replace the reports repo's own script.
- `.github/workflows/team-report.yml` — runs it on every push to `reports/**` and commits
  `team-report.html/.md` back. Only the job's `GITHUB_TOKEN`; never a team-wide key.

The lead's review flow stays: open `reports/<week>/team-report.html`, draft the 管理摘要, re-render
with `--summary-file`, commit.
