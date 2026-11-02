#!/usr/bin/env bash
# Force the Claude Code CLI on this host to refresh its OAuth access_token.
#
# Mechanism: any `claude` invocation triggers the CLI's own internal refresh
# logic — if the cached access_token is past (or near) expiry, the CLI uses
# the refresh_token to mint a new one and writes the file back. `claude --version`
# is the cheapest such invocation.
#
# Install as cron on a Linux server (every 6h, well inside the 24h TTL):
#
#   crontab -e
#   # add this line:
#   0 */6 * * * /opt/ola-security-agent/scripts/keep-claude-token-fresh.sh >> /var/log/ola-agent/token-refresh.log 2>&1
#
# Or as a systemd timer (preferred — better logging, deps, env):
#   see docs/setup-linux-server.md
#
# Limitations:
#   - The refresh_token itself expires (~30 days). After 30 days of no real
#     `claude login`, this script will start failing — you'll need to ssh in
#     and re-login.
#   - If the host's ~/.claude/.credentials.json is missing entirely, this
#     script can't bootstrap auth — run `claude login` first.

set -euo pipefail

claude_bin="${CLAUDE_BIN:-$(command -v claude || echo '/usr/local/bin/claude')}"
creds="${HOME}/.claude/.credentials.json"

if [ ! -x "$claude_bin" ]; then
  echo "$(date -Iseconds) ERROR claude CLI not found at $claude_bin" >&2
  exit 1
fi

if [ ! -f "$creds" ]; then
  echo "$(date -Iseconds) ERROR $creds missing — run 'claude login' first" >&2
  exit 1
fi

# Trigger refresh. `--version` is a no-op command that still goes through the
# CLI's auth bootstrap. Output suppressed except on error.
if ! out=$("$claude_bin" --version 2>&1); then
  echo "$(date -Iseconds) ERROR claude --version failed: $out" >&2
  exit 1
fi

# Report current expiry so the log shows token health over time.
if command -v jq >/dev/null; then
  expires_ms=$(jq -r '.claudeAiOauth.expiresAt // empty' "$creds" 2>/dev/null)
  if [ -n "$expires_ms" ]; then
    # macOS date / GNU date differ on epoch parsing; both accept seconds.
    expires_s=$((expires_ms / 1000))
    if date -d "@$expires_s" >/dev/null 2>&1; then
      hr=$(date -d "@$expires_s" -Iseconds)        # GNU
    else
      hr=$(date -r "$expires_s" "+%Y-%m-%dT%H:%M:%S%z")   # BSD/macOS
    fi
    echo "$(date -Iseconds) OK token now expires at $hr"
    exit 0
  fi
fi

echo "$(date -Iseconds) OK refreshed (expiry unknown — install jq for details)"
