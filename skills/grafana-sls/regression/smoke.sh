#!/usr/bin/env sh
# regression-case:grafana-sls-smoke — see REGRESSION.md. Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
skill="$here/.."
fail=0
for p in "suites/sre-inspect/run" "suites/sre-inspect/tools/grafana-sls/sls_query.py" "suites/sre-inspect/toolsets/grafana-sls.custom_toolset.yaml" "suites/sre-inspect/SUITE.md"; do
  [ -e "$root/$p" ] || { echo "MISSING in workspace: $p"; fail=1; }
done
[ -x "$root/suites/sre-inspect/run" ] || { echo "suite run not executable"; fail=1; }
help="$(python3 "$root/suites/sre-inspect/tools/grafana-sls/sls_query.py" --help 2>&1)" || { echo "sls_query.py --help failed"; fail=1; }
for sub in datasources logstores query context; do
  printf '%s' "$help" | grep -q "$sub" || { echo "sls_query.py --help lost subcommand: $sub"; fail=1; }
done
for s in "NOT double-quoted" "__tag__:__hostname__: \"" "injected" "count(\*)" "max 200" "ParameterInvalid" "incomplete logs" "run sls" "anchor" "silently as"; do
  grep -q -- "$s" "$skill/SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
for n in pazzy partying olachat pt-oversea BlindBox giftConfigV2 5569189085140179; do
  if grep -rqi --exclude-dir=.git --exclude-dir=regression -- "$n" "$skill"; then echo "project-specific noun leaked into skill files: $n"; fail=1; fi
done
ids=$(awk '/^repositories:/{f=1;next} /^[A-Za-z_]/{f=0} f && /^[[:space:]]*- id:/{sub(/.*- id:[[:space:]]*/,""); print}' "$root/workspace.yaml")
for id in $ids; do
  if grep -rqw --exclude-dir=.git --exclude-dir=regression -- "$id" "$skill"; then echo "team-specific repo id leaked into skill files: $id"; fail=1; fi
done
grep -q '^id: skill:grafana-sls$' "$skill/SKILL.md" || { echo "frontmatter id wrong"; fail=1; }
grep -Eq '^version: "[0-9a-f]{40}"$' "$skill/SKILL.md" || { echo "frontmatter version not a 40-hex SHA"; fail=1; }
[ "$fail" = 0 ] && echo "OK: grafana-sls smoke passed" || echo "FAIL"
exit $fail
