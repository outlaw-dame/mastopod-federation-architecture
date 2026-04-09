#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${FEDIFY_ENV_FILE:-$ROOT_DIR/.env.local}

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

: "${AT_LOCAL_FIXTURE:=true}"
: "${ENABLE_XRPC_SERVER:=false}"
: "${ENABLE_OPENSEARCH_INDEXER:=true}"
: "${ACTIVITYPODS_URL:=http://localhost:3000}"
: "${ACTIVITYPODS_TOKEN:=local-dev-token}"
: "${REDIS_URL:=redis://localhost:6379}"
: "${REDPANDA_BROKERS:=localhost:19092}"
: "${OPENSEARCH_NODE:=http://localhost:9200}"

export AT_LOCAL_FIXTURE
export ENABLE_XRPC_SERVER
export ENABLE_OPENSEARCH_INDEXER
export ACTIVITYPODS_URL
export ACTIVITYPODS_TOKEN
export REDIS_URL
export REDPANDA_BROKERS
export OPENSEARCH_NODE

cd "$ROOT_DIR"

npm run topics:bootstrap
npm run dev
