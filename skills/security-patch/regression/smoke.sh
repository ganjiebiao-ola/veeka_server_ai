#!/usr/bin/env sh
# regression-case:security-patch-smoke
# Guards the operator skill: the suite entry points it drives exist and are executable, the verbs and
# the hard rules are still in the text, and no pilot data or team repo id leaked in.
# Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
skill="$here/.."
fail=0
for p in "workspace.yaml" "agent-instructions/security-defaults.md" \
         "suites/security-patch/SUITE.md" "suites/security-patch/run" "suites/security-patch/test" \
         "suites/security-patch/docs/quickstart.md" \
         "suites/security-patch/app/backend/cli/server.ts" \
         "suites/security-patch/app/backend/bun.lock" \
         "suites/security-patch/app/frontend/bun.lock" \
         "suites/security-patch/app/scanner/bridge.mjs" \
         "suites/security-patch/app/skill/ola-security-audit/SKILL.md"; do
  [ -e "$root/$p" ] || { echo "MISSING in workspace: $p"; fail=1; }
done
[ -x "$root/suites/security-patch/run" ] && [ -x "$root/suites/security-patch/test" ] || { echo "suite run/test not executable"; fail=1; }
for s in "run start" "run stop" "run doctor" "run overview" "run pick" "run status" "run resume" "ask first" "never auto-merges" \
         "Never accept a Pick" "TODO(owner)"; do
  grep -qF -- "$s" "$skill/SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
# Repo ids come from workspace.yaml and the gitignored workspace.local.yaml, so the guard can name a
# locally mounted pilot repo without that name ever entering a tracked file.
ids=$(cat "$root/workspace.yaml" "$root/workspace.local.yaml" 2>/dev/null | awk '/^repositories:/{f=1;next} /^[A-Za-z_]/{f=0} f && /^[[:space:]]*- id:/{sub(/.*- id:[[:space:]]*/,""); print}')
for id in $ids; do
  if grep -rqw --exclude-dir=.git --exclude-dir=regression -- "$id" "$skill"; then echo "team-specific repo id leaked into skill files: $id"; fail=1; fi
done
grep -q '^id: skill:security-patch$' "$skill/SKILL.md" || { echo "frontmatter id wrong"; fail=1; }
grep -Eq '^version: "[0-9a-f]{40}"$' "$skill/SKILL.md" || { echo "frontmatter version not a 40-hex SHA"; fail=1; }
[ "$fail" = 0 ] && echo "OK: security-patch smoke passed" || exit 1
