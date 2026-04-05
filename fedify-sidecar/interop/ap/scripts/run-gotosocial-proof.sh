#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"
CERTS_DIR="${SCRIPT_DIR}/../runtime/certs"
USERNAME="${AP_INTEROP_GOTOSOCIAL_USERNAME:-interop}"
SKIP_BUILD="${AP_INTEROP_SKIP_BUILD:-0}"

if [ ! -f "${CERTS_DIR}/rootCA.crt" ] || [ ! -f "${CERTS_DIR}/sidecar.crt" ] || [ ! -f "${CERTS_DIR}/gotosocial.crt" ]; then
  "${SCRIPT_DIR}/generate-certs.sh"
fi

if [ "${SKIP_BUILD}" != "1" ]; then
  docker compose -f "${COMPOSE_FILE}" build \
    mock-activitypods fedify-sidecar ap-interop-proof
fi

docker compose -f "${COMPOSE_FILE}" --profile mastodon stop mastodon-web-app mastodon-sidekiq >/dev/null 2>&1 || true

docker compose -f "${COMPOSE_FILE}" up -d \
  redis redpanda mock-activitypods fedify-sidecar gotosocial-app ap-proxy

AP_INTEROP_GOTOSOCIAL_USERNAME="${USERNAME}" \
  "${SCRIPT_DIR}/bootstrap-gotosocial-account.sh"

"${SCRIPT_DIR}/reset-harness-redis-state.sh"

AP_INTEROP_TARGET=gotosocial \
AP_INTEROP_TARGET_USERNAME="${USERNAME}" \
  docker compose -f "${COMPOSE_FILE}" --profile proof run --rm ap-interop-proof
