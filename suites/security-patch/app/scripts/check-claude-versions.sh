#!/usr/bin/env bash
# Verify that the trailing patch number matches between the two Anthropic
# packages currently pinned in scanner/Dockerfile, and show the latest pair
# available on npm. Run before bumping CLAUDE_PATCH.
set -euo pipefail

DOCKERFILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scanner/Dockerfile"

# Extract pinned patch number from the Dockerfile.
pinned=$(grep -E '^ARG CLAUDE_PATCH=' "$DOCKERFILE" | sed 's/.*=//')
echo "Pinned in Dockerfile : claude-code@2.1.${pinned} + claude-agent-sdk@0.3.${pinned}"

# Latest on npm.
cc=$(cd "$(dirname "$DOCKERFILE")/.." && bun info @anthropic-ai/claude-code version 2>/dev/null)
sdk=$(cd "$(dirname "$DOCKERFILE")/.." && bun info @anthropic-ai/claude-agent-sdk version 2>/dev/null)
echo "Latest on npm        : claude-code@${cc} + claude-agent-sdk@${sdk}"

cc_patch=${cc##*.}
sdk_patch=${sdk##*.}
if [ "$cc_patch" = "$sdk_patch" ]; then
  echo "✓ npm latest pair is in sync (trailing=${cc_patch})."
else
  echo "⚠ npm latest pair is NOT in sync — wait for both to catch up before bumping."
  exit 1
fi

if [ "$pinned" != "$cc_patch" ]; then
  echo ""
  echo "→ To bump: edit scanner/Dockerfile, set ARG CLAUDE_PATCH=${cc_patch}, then rebuild."
fi
