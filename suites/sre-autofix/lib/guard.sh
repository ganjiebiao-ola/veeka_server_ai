#!/usr/bin/env sh
# usage: guard.sh <workspace-root> <action> <target>  → exit 0 approved / 1 blocked
# Thin adapter so python can call harness_guard with cwd = workspace root: scripts/lib/harness.sh
# derives its log root (runs/harness-log.jsonl) from `git rev-parse --show-toplevel`, which inside a
# worktree of a mounted repo would point at that repo instead of the workspace.
set -u
cd "$1" || exit 1
. "$1/scripts/lib/harness.sh"
harness_guard "$2" "$3"
