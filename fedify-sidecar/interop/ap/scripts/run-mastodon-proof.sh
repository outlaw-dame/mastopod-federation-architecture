#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"
CERTS_DIR="${SCRIPT_DIR}/../runtime/certs"
ENV_FILE="${SCRIPT_DIR}/../runtime/mastodon.env"
USERNAME="${AP_INTEROP_MASTODON_USERNAME:-interop}"
SKIP_BUILD="${AP_INTEROP_SKIP_BUILD:-0}"
RESULT_FILE="${SCRIPT_DIR}/../runtime/mastodon-proof-result.json"

if [ ! -f "${CERTS_DIR}/rootCA.crt" ] || [ ! -f "${CERTS_DIR}/sidecar.crt" ] || [ ! -f "${CERTS_DIR}/mastodon.crt" ]; then
  "${SCRIPT_DIR}/generate-certs.sh"
fi

if [ ! -f "${ENV_FILE}" ]; then
  "${SCRIPT_DIR}/prepare-mastodon-env.sh"
fi

set -a
. "${ENV_FILE}"
set +a

if [ "${SKIP_BUILD}" != "1" ]; then
  docker compose -f "${COMPOSE_FILE}" build \
    mock-activitypods fedify-sidecar ap-interop-proof
fi

docker compose -f "${COMPOSE_FILE}" stop gotosocial-app >/dev/null 2>&1 || true
docker compose -f "${COMPOSE_FILE}" --profile akkoma stop akkoma-app >/dev/null 2>&1 || true

docker compose -f "${COMPOSE_FILE}" --profile mastodon up -d \
  redis redpanda mock-activitypods mastodon-db mastodon-redis

docker compose -f "${COMPOSE_FILE}" run --rm fedify-sidecar npm run topics:bootstrap >/dev/null

docker compose -f "${COMPOSE_FILE}" --profile mastodon up -d \
  fedify-sidecar ap-proxy

AP_INTEROP_MASTODON_ENV_FILE="${ENV_FILE}" \
AP_INTEROP_MASTODON_USERNAME="${USERNAME}" \
  "${SCRIPT_DIR}/bootstrap-mastodon-account.sh"

"${SCRIPT_DIR}/reset-harness-redis-state.sh"
rm -f "${RESULT_FILE}"

AP_INTEROP_TARGET=mastodon \
AP_INTEROP_TARGET_USERNAME="${USERNAME}" \
AP_INTEROP_RESULT_PATH=/interop/runtime/mastodon-proof-result.json \
  docker compose -f "${COMPOSE_FILE}" --profile proof run --rm ap-interop-proof

AP_INTEROP_TARGET=mastodon \
AP_INTEROP_COMPOSE_FILE="${COMPOSE_FILE}" \
AP_INTEROP_PROOF_RESULT_FILE="${RESULT_FILE}" \
  npm exec --prefix "${SCRIPT_DIR}/../../.." -- tsx "${SCRIPT_DIR}/verify-target-media-proof.ts"
