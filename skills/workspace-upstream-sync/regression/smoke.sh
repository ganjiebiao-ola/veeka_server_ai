#!/usr/bin/env sh
# regression-case:workspace-upstream-sync-smoke
# Guards the skill's contract: the scripts it calls exist and keep their CLI shape, SKILL.md keeps its key
# mechanics, and the sync mechanism itself works — regression/sync-fixture.sh builds a synthetic
# upstream + downstream pair and runs two sync rounds with the real check-ownership / upstream-pin.
# Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
fail=0
for p in workspace.yaml platform-internals/ownership.yaml .gitattributes scripts/sync-upstream-ship \
         scripts/lib/merge-keep-team scripts/check-ownership scripts/upstream-pin scripts/render-agent-entries scripts/render-context-manifest \
         scripts/lib/harness.sh scripts/ws; do
  [ -e "$root/$p" ] || { echo "MISSING in workspace: $p"; fail=1; }
done
[ -x "$root/scripts/sync-upstream-ship" ] || { echo "scripts/sync-upstream-ship is not executable"; fail=1; }
usage_text="$(sh "$root/scripts/sync-upstream-ship" 2>&1 || true)"
echo "$usage_text" | grep -q -- "usage: sync-upstream-ship <branch> <base> <title-file> <body-file>" \
  || { echo "scripts/sync-upstream-ship lost its usage contract"; fail=1; }
for s in "Never rebase" "harness_guard" "merge.ours.driver" "merge-keep-team" "upstream-pin" "Never force-push" "squash"; do
  grep -q "$s" "$here/../SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
sh "$here/sync-fixture.sh" "$root" || fail=1
[ "$fail" = 0 ] && echo "OK: workspace-upstream-sync smoke passed" || echo "FAIL"
exit $fail
