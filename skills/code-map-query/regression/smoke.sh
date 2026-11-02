#!/usr/bin/env sh
# regression-case:code-map-query-smoke
# Guards the skill's contract: SKILL.md hasn't silently lost the MCP tool names, the evidence-tier
# framework, or the server-prerequisite note it depends on to be more than dead prose.
# Usage: regression/smoke.sh
set -e
here="$(dirname "$0")"
skill="$here/../SKILL.md"
fail=0
for s in \
  "search_graph" "trace_path" "get_code_snippet" "check_index_coverage" "detect_changes" \
  "Scout" "Verify" "Auditor" \
  "codebase-memory-mcp" \
  "What Counts As Enough" "Retrieval Budget" "## Stop"
do
  grep -q -- "$s" "$skill" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
[ "$fail" = 0 ] && echo "OK: code-map-query smoke passed" || echo "FAIL"
exit $fail
