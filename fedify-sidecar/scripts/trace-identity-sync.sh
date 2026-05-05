#!/usr/bin/env bash
# Usage:
#   ./scripts/trace-identity-sync.sh                        # default: proof:identity-sync
#   ./scripts/trace-identity-sync.sh proof:identity-sync:write-miss
#   cmd | ./scripts/trace-identity-sync.sh --pipe
set -euo pipefail

SCRIPT="${1:-proof:identity-sync}"

if [[ "$SCRIPT" == "--pipe" ]]; then
  grep --line-buffered '\[identity-sync\]'
else
  IDENTITY_SYNC_TRACE=true npm run "$SCRIPT" 2>&1 | grep --line-buffered '\[identity-sync\]'
fi
