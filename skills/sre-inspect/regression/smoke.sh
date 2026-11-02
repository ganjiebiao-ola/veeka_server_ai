#!/usr/bin/env sh
# regression-case:sre-inspect-smoke — see REGRESSION.md. Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
skill="$here/.."
fail=0
for p in "workspace.yaml" "agent-instructions/security-defaults.md" "suites/sre-inspect/SUITE.md" "suites/sre-inspect/run" \
         "suites/sre-inspect/test" "suites/sre-inspect/docs/quickstart.md" "suites/sre-inspect/docs/dive-contract.md" \
         "suites/sre-autofix/docs/input-contract.md" "skills/grafana-sls/SKILL.md"; do
  [ -e "$root/$p" ] || { echo "MISSING in workspace: $p"; fail=1; }
done
[ -x "$root/suites/sre-inspect/run" ] && [ -x "$root/suites/sre-inspect/test" ] || { echo "suite run/test not executable"; fail=1; }
for s in "run doctor" "run intake" "run dive" "run finish" "sre-autofix/run claim" "anchor check" "cause_locus" \
         "time-zone arithmetic" "never do time-zone" "unrouted" "data_gaps" "read-only" "suspect_change" "L7"; do
  grep -qF -- "$s" "$skill/SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
for n in pazzy partying olachat pt-oversea BlindBox giftConfigV2 5569189085140179 RpcBlindBox; do
  if grep -rqi --exclude-dir=.git --exclude-dir=regression -- "$n" "$skill"; then echo "project-specific noun leaked into skill files: $n"; fail=1; fi
done
ids=$(awk '/^repositories:/{f=1;next} /^[A-Za-z_]/{f=0} f && /^[[:space:]]*- id:/{sub(/.*- id:[[:space:]]*/,""); print}' "$root/workspace.yaml")
for id in $ids; do
  if grep -rqw --exclude-dir=.git --exclude-dir=regression -- "$id" "$skill"; then echo "team-specific repo id leaked into skill files: $id"; fail=1; fi
done
grep -q '^id: skill:sre-inspect$' "$skill/SKILL.md" || { echo "frontmatter id wrong"; fail=1; }
grep -Eq '^version: "[0-9a-f]{40}"$' "$skill/SKILL.md" || { echo "frontmatter version not a 40-hex SHA"; fail=1; }
[ "$fail" = 0 ] && echo "OK: sre-inspect smoke passed" || echo "FAIL"
exit $fail
