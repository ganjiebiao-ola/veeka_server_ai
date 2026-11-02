#!/usr/bin/env python3
"""Validate a campaign config against the criteria in REQ-001.

Zero-dependency (stdlib only). Each rule prints the acceptance-criterion id it implements, so a
failure can be traced straight back to a requirement item.

No wall-clock: rules compare only the dates inside the config. A rule that consulted today's date
would make the test suite's red/green drift with the calendar.

usage: validate.py <config.json>        exit 0 = valid, 1 = rejected, 2 = unusable input
"""
import datetime
import json
import sys

MAX_DISCOUNT = 60  # AC-2: upper bound of the discount range (tightened at REQ-001 v2)
MAX_WINDOW_DAYS = 90  # AC-3: longest campaign window (REQ-001 v2)


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def parse_day(value, field):
    try:
        return datetime.date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} is not an ISO date (YYYY-MM-DD): {value!r}")


def check(config):
    """Return the list of criterion violations; empty means the config is valid."""
    problems = []

    # AC-1 — the campaign window must move forward: start strictly before end.
    start = parse_day(config.get("start"), "start")
    end = parse_day(config.get("end"), "end")
    if not start < end:
        problems.append(f"FAIL: AC-1 window: start ({start}) must be before end ({end})")

    # AC-2 — discount_percent must fall in (0, MAX_DISCOUNT]: a campaign that discounts nothing is
    # not a campaign, and anything past the cap needs an approval this validator does not model.
    discount = config.get("discount_percent")
    if not isinstance(discount, int):
        problems.append(f"FAIL: AC-2 discount: discount_percent must be an integer, got {discount!r}")
    elif not 0 < discount <= MAX_DISCOUNT:
        problems.append(
            f"FAIL: AC-2 discount: discount_percent must be in (0, {MAX_DISCOUNT}], got {discount}"
        )

    # AC-3 — a window longer than MAX_WINDOW_DAYS days overloads the downstream reporting pipeline.
    span = (end - start).days
    if span > MAX_WINDOW_DAYS:
        problems.append(
            f"FAIL: AC-3 duration: window is {span} days, must be at most {MAX_WINDOW_DAYS}"
        )

    return problems


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    try:
        config = load(argv[1])
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: could not read config: {exc}", file=sys.stderr)
        return 2
    try:
        problems = check(config)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if problems:
        for p in problems:
            print(p)
        return 1
    print(f"OK: {config.get('name', '(unnamed)')} passes all criteria")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
