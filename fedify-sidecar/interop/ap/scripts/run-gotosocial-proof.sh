#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"
COMPOSE_OVERRIDE="${AP_INTEROP_COMPOSE_OVERRIDE:-}"
CERTS_DIR="${SCRIPT_DIR}/../runtime/certs"
RUNTIME_DIR="${SCRIPT_DIR}/../runtime/gotosocial"
DB_FILE="${RUNTIME_DIR}/sqlite.db"
USERNAME="${AP_INTEROP_GOTOSOCIAL_USERNAME:-interop}"
SKIP_BUILD="${AP_INTEROP_SKIP_BUILD:-0}"
RESULT_FILE="${SCRIPT_DIR}/../runtime/gotosocial-proof-result.json"
RESET_STATE="${AP_INTEROP_GOTOSOCIAL_RESET_STATE:-0}"

compose() {
  if [ -n "${COMPOSE_OVERRIDE}" ]; then
    docker compose -f "${COMPOSE_FILE}" -f "${COMPOSE_OVERRIDE}" "$@"
  else
    docker compose -f "${COMPOSE_FILE}" "$@"
  fi
}

ensure_gotosocial_runtime_dir() {
  mkdir -p "${RUNTIME_DIR}"
  chmod 0777 "${RUNTIME_DIR}"
  if [ -f "${DB_FILE}" ]; then
    chmod 0666 "${DB_FILE}" >/dev/null 2>&1 || true
  fi
}

reset_gotosocial_state() {
  compose stop gotosocial-app >/dev/null 2>&1 || true
  rm -rf "${RUNTIME_DIR}"
  ensure_gotosocial_runtime_dir
  : > "${DB_FILE}"
  chmod 0666 "${DB_FILE}"
}

if [ ! -f "${CERTS_DIR}/rootCA.crt" ] || [ ! -f "${CERTS_DIR}/sidecar.crt" ] || [ ! -f "${CERTS_DIR}/gotosocial.crt" ]; then
  "${SCRIPT_DIR}/generate-certs.sh"
fi

if [ "${SKIP_BUILD}" != "1" ]; then
  compose build \
    mock-activitypods fedify-sidecar ap-interop-proof
fi

ensure_gotosocial_runtime_dir

if [ "${RESET_STATE}" = "1" ] || ! gotosocial_db_is_healthy; then
  reset_gotosocial_state
fi

compose --profile mastodon stop mastodon-web-app mastodon-sidekiq >/dev/null 2>&1 || true
compose --profile akkoma stop akkoma-app >/dev/null 2>&1 || true

compose up -d \
  redis redpanda mock-activitypods gotosocial-app

compose run --rm fedify-sidecar npm run topics:bootstrap >/dev/null

compose up -d \
  fedify-sidecar ap-proxy

AP_INTEROP_GOTOSOCIAL_USERNAME="${USERNAME}" \
  "${SCRIPT_DIR}/bootstrap-gotosocial-account.sh"

"${SCRIPT_DIR}/reset-harness-redis-state.sh"
rm -f "${RESULT_FILE}"

AP_INTEROP_TARGET=gotosocial \
AP_INTEROP_TARGET_USERNAME="${USERNAME}" \
AP_INTEROP_RESULT_PATH=/interop/runtime/gotosocial-proof-result.json \
  compose --profile proof run --rm ap-interop-proof

AP_INTEROP_TARGET=gotosocial \
AP_INTEROP_COMPOSE_FILE="${COMPOSE_FILE}" \
AP_INTEROP_PROOF_RESULT_FILE="${RESULT_FILE}" \
  npm exec --prefix "${SCRIPT_DIR}/../../.." -- tsx "${SCRIPT_DIR}/verify-target-media-proof.ts"
