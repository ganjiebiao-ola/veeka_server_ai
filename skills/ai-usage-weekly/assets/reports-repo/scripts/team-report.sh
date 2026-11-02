#!/usr/bin/env sh
# Re-render changed weeks; shared configuration and requests refresh all stored submission weeks.
# Usage: scripts/team-report.sh <template-root> <reports-repo> <changed-path>...
#   template-root : checkout of ai-native-workspace-template (holds scripts/ai-usage-weekly + the schema)
#   reports-repo  : this repo's checkout (reports/<week>/<human_id>.json live here)
#   changed-path  : paths from the push, e.g. reports/2026-W37/alice.json — each distinct week is rendered once
# Never pushes; the workflow (or the lead) commits the rendered files. Exit 2 = a week had nothing to aggregate.
set -eu
template="${1:?template-root}"; repo="${2:?reports-repo}"; shift 2
[ -x "$template/scripts/ai-usage-weekly" ] || { echo "FAIL: $template/scripts/ai-usage-weekly not found"; exit 2; }
weeks=""
refresh_all=0
for p in "$@"; do
  case "$p" in
    reports/team.json|reports/budget.json|reports/requests/*.json) refresh_all=1 ;;
  esac
  w=$(printf '%s\n' "$p" | sed -n 's#^reports/\([0-9][0-9][0-9][0-9]-W[0-9][0-9]\)/.*#\1#p')
  [ -n "$w" ] || continue
  case " $weeks " in *" $w "*) ;; *) weeks="$weeks $w";; esac
done
if [ "$refresh_all" -eq 1 ]; then
  for d in "$repo"/reports/[0-9][0-9][0-9][0-9]-W[0-9][0-9]; do
    [ -d "$d" ] || continue
    # An empty directory or a platform-only rendered page has no stored input to aggregate.
    has_submission=0
    for f in "$d"/*.json; do
      [ -f "$f" ] || continue
      case "${f##*/}" in team-report*) continue ;; esac
      has_submission=1; break
    done
    [ "$has_submission" -eq 1 ] || continue
    w="${d##*/}"
    case " $weeks " in *" $w "*) ;; *) weeks="$weeks $w";; esac
  done
fi
[ -n "$weeks" ] || { echo "no stored report weeks affected — nothing to render"; exit 0; }
rc=0
for w in $weeks; do
  echo "== team report $w"
  "$template/scripts/ai-usage-weekly" team --week "$w" --reports-dir "$repo" --workspace-root "$template" || rc=$?
done
exit $rc
