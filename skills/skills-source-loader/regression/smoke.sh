#!/usr/bin/env sh
# regression-case:skills-source-loader-smoke
# Guards the skill's contract: workspace prerequisites exist, SKILL.md hasn't lost its key
# mechanics, and setup-skills (the primitive this skill relies on) is present and executable.
# Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
fail=0
for p in "workspace.yaml" "scripts/setup-skills" "agent-instructions/mount-points.md"; do
  [ -e "$root/$p" ] || { echo "MISSING in workspace: $p"; fail=1; }
done
[ -x "$root/scripts/setup-skills" ] || { echo "scripts/setup-skills is not executable"; fail=1; }
grep -q "skill_catalog" "$root/workspace.yaml" || { echo "workspace.yaml missing skill_catalog"; fail=1; }
# CLI-contract check, not just prose: the flags this skill's body hardcodes must actually exist,
# since a setup-skills interface change is the likeliest way this skill silently breaks.
help_text="$("$root/scripts/setup-skills" --help 2>&1 || true)"
for flag in "\-\-index" "\-\-id" "\-\-category" "\-\-list"; do
  echo "$help_text" | grep -q -- "$flag" || { echo "scripts/setup-skills --help lost flag: $flag"; fail=1; }
done
for s in "scripts/setup-skills --index" "mode: trial" "fresh subagent" "Do not attempt a same-turn workaround"; do
  grep -q "$s" "$here/../SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
[ "$fail" = 0 ] && echo "OK: skills-source-loader smoke passed" || echo "FAIL"
exit $fail
