#!/usr/bin/env sh
# regression-case:code-map-scope-smoke
# Guards the skill's contract: the scripts it drives exist and still carry the flags its body
# hardcodes (a generate-map interface change is the likeliest way this skill silently breaks), and
# SKILL.md keeps the rules that make its output safe — canonical location under knowledge/maps/,
# never writing into repos/, and the stamp step.
# Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
fail=0
for p in "scripts/generate-map" "scripts/check-map" "scripts/ws"; do
  [ -x "$root/$p" ] || { echo "MISSING or not executable: $p"; fail=1; }
done
# CLI contract: the flag the skill tells the operator to run must actually exist.
help_text="$("$root/scripts/generate-map" --help 2>&1 || true)"
for flag in "\-\-stamp-cbmignore" "\-\-mode" "\-\-no-auto-cbmignore"; do
  echo "$help_text" | grep -q -- "$flag" || { echo "scripts/generate-map --help lost flag: $flag"; fail=1; }
done
grep -q "map generate" "$root/scripts/ws" || { echo "scripts/ws lost the 'map generate' subcommand"; fail=1; }
for s in "knowledge/maps/<id>/.cbmignore" "Never write into \`repos/<id>/\`" "stamp-cbmignore" "credential red line"; do
  grep -q "$s" "$here/../SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
[ "$fail" = 0 ] && echo "OK: code-map-scope smoke passed" || echo "FAIL"
exit $fail
