#!/usr/bin/env sh
# Fake headless agent for tests: applies the fixture patch, writes the two output files, and emits
# claude-style stream-json lines. Runs with cwd = worktree. $1 = fixtures dir, $2 = "sleep" to hang.
set -e
fx="$1"
if [ "${2:-}" = "sleep" ]; then sleep 30; exit 0; fi
if [ "${2:-}" = "fail" ]; then echo '{"type":"result","result":"boom","is_error":true,"total_cost_usd":0.001,"num_turns":1}'; exit 1; fi
git apply "$fx/shipped.diff"
cp "$fx/fixnotes-sample.md" FIXNOTES.md
mkdir -p .sre-evidence && cp "$fx/verification-shipped.json" .sre-evidence/verification.json
echo '{"type":"system","subtype":"init"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"editing"}]}}'
echo '{"type":"result","result":"Fix applied per INCIDENT.md","is_error":false,"total_cost_usd":0.0123,"num_turns":3,"duration_ms":1200}'
