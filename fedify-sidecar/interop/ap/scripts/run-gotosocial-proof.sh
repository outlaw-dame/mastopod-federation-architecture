#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"
CERTS_DIR="${SCRIPT_DIR}/../runtime/certs"
RUNTIME_DIR="${SCRIPT_DIR}/../runtime/gotosocial"
DB_FILE="${RUNTIME_DIR}/sqlite.db"
USERNAME="${AP_INTEROP_GOTOSOCIAL_USERNAME:-interop}"
SKIP_BUILD="${AP_INTEROP_SKIP_BUILD:-0}"
RESULT_FILE="${SCRIPT_DIR}/../runtime/gotosocial-proof-result.json"
RESET_STATE="${AP_INTEROP_GOTOSOCIAL_RESET_STATE:-0}"

ensure_gotosocial_runtime_dir() {
  mkdir -p "${RUNTIME_DIR}"
  chmod 0777 "${RUNTIME_DIR}"
  if [ -f "${DB_FILE}" ]; then
    chmod 0666 "${DB_FILE}" >/dev/null 2>&1 || true
  fi
}

reset_gotosocial_state() {
  docker compose -f "${COMPOSE_FILE}" stop gotosocial-app >/dev/null 2>&1 || true
  rm -rf "${RUNTIME_DIR}"
  ensure_gotosocial_runtime_dir
  : > "${DB_FILE}"
  chmod 0666 "${DB_FILE}"
}

gotosocial_db_is_healthy() {
  if [ ! -f "${DB_FILE}" ]; then
    return 0
  fi

  output=$(sqlite3 "file:${DB_FILE}?mode=ro" "pragma integrity_check;" 2>/dev/null || true)
  [ "${output}" = "ok" ]
}

if [ ! -f "${CERTS_DIR}/rootCA.crt" ] || [ ! -f "${CERTS_DIR}/sidecar.crt" ] || [ ! -f "${CERTS_DIR}/gotosocial.crt" ]; then
  "${SCRIPT_DIR}/generate-certs.sh"
fi

if [ "${SKIP_BUILD}" != "1" ]; then
  docker compose -f "${COMPOSE_FILE}" build \
    mock-activitypods fedify-sidecar ap-interop-proof
fi

ensure_gotosocial_runtime_dir

if [ "${RESET_STATE}" = "1" ] || ! gotosocial_db_is_healthy; then
  reset_gotosocial_state
fi

docker compose -f "${COMPOSE_FILE}" --profile mastodon stop mastodon-web-app mastodon-sidekiq >/dev/null 2>&1 || true
docker compose -f "${COMPOSE_FILE}" --profile akkoma stop akkoma-app >/dev/null 2>&1 || true

docker compose -f "${COMPOSE_FILE}" up -d \
  redis redpanda mock-activitypods gotosocial-app

docker compose -f "${COMPOSE_FILE}" run --rm fedify-sidecar npm run topics:bootstrap >/dev/null

docker compose -f "${COMPOSE_FILE}" up -d \
  fedify-sidecar ap-proxy

AP_INTEROP_GOTOSOCIAL_USERNAME="${USERNAME}" \
  "${SCRIPT_DIR}/bootstrap-gotosocial-account.sh"

"${SCRIPT_DIR}/reset-harness-redis-state.sh"
rm -f "${RESULT_FILE}"

AP_INTEROP_TARGET=gotosocial \
AP_INTEROP_TARGET_USERNAME="${USERNAME}" \
AP_INTEROP_RESULT_PATH=/interop/runtime/gotosocial-proof-result.json \
  docker compose -f "${COMPOSE_FILE}" --profile proof run --rm ap-interop-proof

AP_INTEROP_TARGET=gotosocial \
AP_INTEROP_COMPOSE_FILE="${COMPOSE_FILE}" \
AP_INTEROP_PROOF_RESULT_FILE="${RESULT_FILE}" \
  npm exec --prefix "${SCRIPT_DIR}/../../.." -- tsx "${SCRIPT_DIR}/verify-target-media-proof.ts"
