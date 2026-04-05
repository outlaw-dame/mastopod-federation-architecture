#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../../.." && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"

cd "${REPO_ROOT}"

npm exec --prefix fedify-sidecar -- tsc -p fedify-sidecar/tsconfig.json --noEmit
npm exec --prefix fedify-sidecar -- vitest run src/queue/tests/RedisStreamsQueue.test.ts

docker compose -f "${COMPOSE_FILE}" build \
  mock-activitypods fedify-sidecar ap-interop-proof

AP_INTEROP_SKIP_BUILD=1 "${SCRIPT_DIR}/run-gotosocial-proof.sh"
AP_INTEROP_SKIP_BUILD=1 "${SCRIPT_DIR}/run-mastodon-proof.sh"
