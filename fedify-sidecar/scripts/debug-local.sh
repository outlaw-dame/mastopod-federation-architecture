#!/usr/bin/env sh
# Launch fedify-sidecar with Node inspector enabled, loading .env.local first.
# Usage: sh ./scripts/debug-local.sh [inspect-port]
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${FEDIFY_ENV_FILE:-$ROOT_DIR/.env.local}
INSPECT_PORT=${1:-9230}

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

# Defaults matching dev-local.sh, only set if not already exported
: "${AT_LOCAL_FIXTURE:=true}"
: "${ENABLE_XRPC_SERVER:=false}"
: "${ENABLE_OPENSEARCH_INDEXER:=true}"
: "${ACTIVITYPODS_URL:=http://localhost:3000}"
: "${ACTIVITYPODS_TOKEN:=local-dev-token}"
: "${REDIS_URL:=redis://localhost:6379}"
: "${REDPANDA_BROKERS:=localhost:19092}"
: "${OPENSEARCH_NODE:=http://localhost:9200}"

export AT_LOCAL_FIXTURE ENABLE_XRPC_SERVER ENABLE_OPENSEARCH_INDEXER \
       ACTIVITYPODS_URL ACTIVITYPODS_TOKEN REDIS_URL REDPANDA_BROKERS \
       OPENSEARCH_NODE

cd "$ROOT_DIR"
exec node "--inspect=127.0.0.1:${INSPECT_PORT}" --import tsx src/index.ts
