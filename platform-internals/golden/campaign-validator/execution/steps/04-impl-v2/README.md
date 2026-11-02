# campaign-validator

Validates a campaign config against the acceptance criteria in `REQ-001`. Zero dependencies: python3
stdlib and POSIX sh.

## Run it

```sh
./validate.py campaigns/spring-sale.json
```

Exit codes: `0` valid, `1` rejected (one `FAIL: AC-<n> ...` line per violation), `2` unusable input.

## Test it

```sh
./test
```

Each case under `tests/cases/` is a pair — `<name>.json` (the config) and `<name>.expected` (an
`exit=<n>` line plus any `contains=<substring>` lines). Add a criterion, add a case.

## Criteria

Every rule prints the id of the criterion it implements, so a failure points back at a requirement
item rather than at a line number.

| AC | Rule |
|---|---|
| AC-1 | the campaign window moves forward: `start` strictly before `end` |
| AC-2 | `discount_percent` falls within the allowed range |
| AC-3 | the campaign window is no longer than the allowed maximum |

## Config shape

```json
{
  "name": "Spring Sale",
  "start": "2026-03-01",
  "end": "2026-03-15",
  "discount_percent": 20,
  "channels": ["app", "web"]
}
```

## Conventions

- **No wall-clock in the rules.** They compare only the dates inside the config. A rule that consulted
  today's date would make the suite's result drift with the calendar.
- **One rule, one criterion id.** If a rule cannot name the criterion it enforces, the criterion is
  missing from the requirement.
