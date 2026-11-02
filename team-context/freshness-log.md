# Context freshness log (#49)

A running record of context-freshness reviews and stale-content cleanups — the "no lag" red line in
action. One line per event: date, what was found stale, what was done. The committed state stays
green (`scripts/check-context-freshness` passes); this log is the durable trail of governance.

## Drill: expiry detection & cleanup (2026-07-24)

First exercise of the mechanism, on the template repo itself (a workspace instance). Reproducible:

```sh
# 1. Age one entry past the review window, then run the guard:
sed -i.bak 's/security-defaults.md, authority: trusted, last_reviewed: 2026-07-24/security-defaults.md, authority: trusted, last_reviewed: 2020-01-01/' team-context/manifest.yaml
python3 scripts/check-context-freshness      # -> FAIL: [default] agent-instructions/security-defaults.md: STALE — last_reviewed 2020-01-01 is over 365 days old
# 2. Refresh (re-review, bump the date) and re-run:
mv team-context/manifest.yaml.bak team-context/manifest.yaml
python3 scripts/check-context-freshness      # -> OK: <N> manifest entries fresh, authorities consistent, no bloat  (<N> = however many entries the manifest holds by then; 7 at the time of this drill)
```

| Date | Entry | Finding | Action |
|---|---|---|---|
| 2026-07-24 | `[default] agent-instructions/security-defaults.md` | STALE (aged to 2020-01-01 for the drill) | Re-reviewed, `last_reviewed` bumped to 2026-07-24 → cleared |
| 2026-08-25 | `[suite-run] suites/sre-autofix/SUITE.md` + new `incident-fix` task type | First real suite lands (#141): `suite-run` gains a concrete row; three trusted entries registered | Registered with `last_reviewed` 2026-08-25; `check-context-freshness` green (entry count +4) |

The same run confirmed the guard also catches a malformed date and a conflicting `authority` for one
path (the "no inconsistency" machine check). Refresh vs retire is the owner's call: refresh when the
content is still true after re-review; retire/remove the stale part when it is not.
