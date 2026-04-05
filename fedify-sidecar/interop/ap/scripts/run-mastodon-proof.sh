#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"
CERTS_DIR="${SCRIPT_DIR}/../runtime/certs"
ENV_FILE="${SCRIPT_DIR}/../runtime/mastodon.env"
USERNAME="${AP_INTEROP_MASTODON_USERNAME:-interop}"
SKIP_BUILD="${AP_INTEROP_SKIP_BUILD:-0}"

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

docker compose -f "${COMPOSE_FILE}" --profile mastodon up -d \
  redis redpanda mock-activitypods fedify-sidecar mastodon-db mastodon-redis ap-proxy

AP_INTEROP_MASTODON_ENV_FILE="${ENV_FILE}" \
AP_INTEROP_MASTODON_USERNAME="${USERNAME}" \
  "${SCRIPT_DIR}/bootstrap-mastodon-account.sh"

"${SCRIPT_DIR}/reset-harness-redis-state.sh"

AP_INTEROP_TARGET=mastodon \
AP_INTEROP_TARGET_USERNAME="${USERNAME}" \
  docker compose -f "${COMPOSE_FILE}" --profile proof run --rm ap-interop-proof
