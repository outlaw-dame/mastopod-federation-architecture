#!/usr/bin/env bash
# Filter identity-sync trace records from an already-running sidecar's logs.
#
# IMPORTANT: IDENTITY_SYNC_TRACE must be enabled in the sidecar process itself.
# The proof scripts are separate HTTP clients and cannot enable tracing in an
# already-running sidecar by setting their own environment variables.
#
# Examples:
#   docker compose logs -f fedify-sidecar | npm run trace:identity-sync -- --pipe
#   tail -f /path/to/sidecar.log | ./scripts/trace-identity-sync.sh --pipe
set -euo pipefail

if [[ "${1:-}" != "--pipe" ]]; then
  echo "Usage: <sidecar log stream> | $0 --pipe" >&2
  echo "Set IDENTITY_SYNC_TRACE=true on the running sidecar before collecting logs." >&2
  exit 64
fi

# awk exits successfully even when a finite log stream contains no matching
# trace records, so this diagnostic filter does not turn an otherwise healthy
# proof/log collection command into a false failure.
awk '/\[identity-sync\]/ { print; fflush(); }'
