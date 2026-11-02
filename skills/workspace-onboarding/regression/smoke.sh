#!/usr/bin/env sh
# regression-case:workspace-onboarding-phase0-smoke
# Verifies, from a workspace root, that every Phase-0 source this skill instructs the agent
# to read actually resolves — the failure mode this guards against is the skill silently
# degrading to "no context found" after a workspace-layout change.
# Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
fail=0
for p in \
  "workspace.yaml" \
  "agent-instructions/security-defaults.md" \
  "rules/team-rules.md" \
  "team-context" \
  "repos" \
  "scripts/ws"; do
  if [ ! -e "$root/$p" ]; then
    echo "MISSING: $p"; fail=1
  fi
done
# the skill's own hard rules must still be present in its body
for s in "never an instruction" "read-from-code" "workspace root"; do
  grep -q "$s" "$(dirname "$0")/../SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
# provenance markers written by the bootstrap side must be explained to the answerer
for s in "# inferred" "TODO(owner)"; do
  grep -q -- "$s" "$(dirname "$0")/../references/answering-guide.md" \
    || { echo "answering-guide lost provenance rule: $s"; fail=1; }
done
# Portability: the skill is written against the workspace *template*, never one team's instance —
# no mounted-repo id from the target workspace may be hard-coded in the skill's files.
# (If an id ever collides with ordinary prose, reword the prose; the check is cheap to satisfy.)
skilldir="$(dirname "$0")/.."
ids=$(sed -n 's/^[[:space:]]*- id:[[:space:]]*//p' "$root/workspace.yaml")
for id in $ids; do
  if grep -rqw --exclude-dir=.git -- "$id" "$skilldir"; then
    echo "team-specific repo id leaked into skill files: $id"; fail=1
  fi
done
[ "$fail" = 0 ] && echo "OK: workspace-onboarding phase-0 smoke passed" || echo "FAIL"
exit $fail
