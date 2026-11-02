#!/usr/bin/env sh
# regression-case:workspace-context-bootstrap-smoke
# Guards the skill's contract: workspace-mode preflight paths resolve, the template and its
# required sections exist, and the hard rules haven't been edited away.
# Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
fail=0
for p in "workspace.yaml" "agent-instructions/security-defaults.md" "rules/team-rules.md" \
         "team-context/manifest.yaml" "team-context/mounted-repos" "repos"; do
  [ -e "$root/$p" ] || { echo "MISSING in workspace: $p"; fail=1; }
done
tpl="$here/../assets/templates/mounted-repo-context.md"
[ -f "$tpl" ] || { echo "MISSING template"; fail=1; }
for s in "Cross-repo relations" "Known sharp edges" "TODO(owner)"; do
  grep -q "$s" "$tpl" || { echo "template lost section: $s"; fail=1; }
done
for s in "Never generate context at the workspace root" "at least 2 cross-repo questions" "# inferred" \
         "never a rewrite" "important sub-folders" "output whitelist" "repo-security-block" \
         "check-repo-agent-entries" "report a blocker" "no-op (idempotent)"; do
  grep -q "$s" "$here/../SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
# The canonical security block template and its checker exist and are wired
[ -f "$here/../assets/templates/repo-security-block.md" ] || { echo "MISSING repo-security-block template"; fail=1; }
grep -q "@SECURITY_DEFAULTS_BLOB@" "$here/../assets/templates/repo-security-block.md" 2>/dev/null \
  || { echo "repo-security-block template lost its blob placeholder"; fail=1; }

# Behavioral: check-repo-agent-entries must green the good fixture and red every planted problem.
chk="$root/scripts/check-repo-agent-entries"
fx="$root/platform-internals/tests/repo-agent-entries"
if [ -x "$chk" ] && [ -d "$fx" ]; then
  blob=$(git hash-object "$root/agent-instructions/security-defaults.md")
  tmp=$(mktemp -d)
  for case in good missing-agents no-marker stale-sha diverged; do
    mkdir -p "$tmp/$case"
    for f in "$fx/$case"/*; do
      sed "s/@SECURITY_DEFAULTS_BLOB@/$blob/" "$f" > "$tmp/$case/$(basename "$f")"
    done
  done
  "$chk" "$tmp/good" "$root" >/dev/null || { echo "agent-entry checker rejected the good fixture"; fail=1; }
  for case in missing-agents no-marker stale-sha diverged; do
    if "$chk" "$tmp/$case" "$root" >/dev/null 2>&1; then
      echo "agent-entry checker passed planted problem: $case"; fail=1
    fi
  done
  rm -rf "$tmp"
else
  echo "MISSING scripts/check-repo-agent-entries or its fixtures"; fail=1
fi
# Portability: the skill is written against the workspace *template*, never one team's instance —
# no mounted-repo id from the target workspace may be hard-coded in the skill's files.
# (If an id ever collides with ordinary prose, reword the prose; the check is cheap to satisfy.)
ids=$(sed -n 's/^[[:space:]]*- id:[[:space:]]*//p' "$root/workspace.yaml")
for id in $ids; do
  if grep -rqw --exclude-dir=.git -- "$id" "$here/.."; then
    echo "team-specific repo id leaked into skill files: $id"; fail=1
  fi
done
[ "$fail" = 0 ] && echo "OK: workspace-context-bootstrap smoke passed" || echo "FAIL"
exit $fail
