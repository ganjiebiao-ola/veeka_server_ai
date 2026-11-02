# Testing requirements

<!-- Thin starter. Fill with YOUR team's actual expectations; keep each rule checkable and give its why. -->

## When tests are required

`TODO(owner)`: which changes must ship with tests (e.g. "any change under `service/` or `api/`").

## Coverage bar

- `TODO(owner)`: your coverage expectation.
- **Note:** this is a **team convention**, not a framework admission gate. Do not phrase it as a hard
  gate that blocks phase progress (see `rules/review.md` §Best-to-have — recommended, never a gate).

## Running tests

- `TODO(owner)`: the command(s) to run the suite locally and in CI.

## Example & anti-example

- **Good:** "Changes under `service/` need unit tests; run `make test`; CI must be green to merge —
  because that path carries the money-affecting logic."
- **Anti:** "Aim for 100% coverage." A wishlist number that drives busywork, not a checkable rule
  tied to risk.
