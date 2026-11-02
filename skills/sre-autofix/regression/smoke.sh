#!/usr/bin/env sh
# regression-case:sre-autofix-smoke
# Guards the operator skill: the suite entry points and docs it drives exist, the verb sequence and
# the hard rules are still in the text, and no project noun / team repo id leaked in.
# Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
skill="$here/.."
fail=0
for p in "workspace.yaml" "agent-instructions/security-defaults.md" "scripts/lib/harness.sh" \
         "suites/sre-autofix/SUITE.md" "suites/sre-autofix/run" "suites/sre-autofix/test" \
         "suites/sre-autofix/docs/runbook.md" "skills/incident-fix/SKILL.md"; do
  [ -e "$root/$p" ] || { echo "MISSING in workspace: $p"; fail=1; }
done
[ -x "$root/suites/sre-autofix/run" ] && [ -x "$root/suites/sre-autofix/test" ] || { echo "suite run/test not executable"; fail=1; }
for s in "run claim" "run plan" "run fix" "run gate" "run ship" "harness_guard" "never auto-merged" \
         "Closes" "Refs" "local path" "TODO(owner)"; do
  grep -qF -- "$s" "$skill/SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
for n in mustLogin BlindBox getCurrentUser pt-oversea olachat authcode BbcStrategy live_pk config_db pingMysql \
         LivePk giftConfigV2 RpcBlindBox pazzy; do
  if grep -rq --exclude-dir=.git --exclude-dir=regression -- "$n" "$skill"; then echo "project-specific noun leaked into skill files: $n"; fail=1; fi
done
ids=$(awk '/^repositories:/{f=1;next} /^[A-Za-z_]/{f=0} f && /^[[:space:]]*- id:/{sub(/.*- id:[[:space:]]*/,""); print}' "$root/workspace.yaml")
for id in $ids; do
  if grep -rqw --exclude-dir=.git --exclude-dir=regression -- "$id" "$skill"; then echo "team-specific repo id leaked into skill files: $id"; fail=1; fi
done
grep -q '^id: skill:sre-autofix$' "$skill/SKILL.md" || { echo "frontmatter id wrong"; fail=1; }
grep -Eq '^version: "[0-9a-f]{40}"$' "$skill/SKILL.md" || { echo "frontmatter version not a 40-hex SHA"; fail=1; }
[ "$fail" = 0 ] && echo "OK: sre-autofix smoke passed" || echo "FAIL"
exit $fail
