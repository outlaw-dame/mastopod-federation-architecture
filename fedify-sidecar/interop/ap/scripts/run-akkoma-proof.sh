#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"
CERTS_DIR="${SCRIPT_DIR}/../runtime/certs"
USERNAME="${AP_INTEROP_AKKOMA_USERNAME:-interop}"
SKIP_BUILD="${AP_INTEROP_SKIP_BUILD:-0}"
RESET_STATE="${AP_INTEROP_AKKOMA_RESET_STATE:-1}"
AKKOMA_RUNTIME_DIR="${SCRIPT_DIR}/../runtime/akkoma"
RESULT_FILE="${SCRIPT_DIR}/../runtime/akkoma-proof-result.json"

run_compose() {
  docker compose -f "${COMPOSE_FILE}" --profile akkoma "$@"
}

reset_akkoma_state() {
  docker compose -f "${COMPOSE_FILE}" --profile akkoma down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${AKKOMA_RUNTIME_DIR}"
  mkdir -p "${AKKOMA_RUNTIME_DIR}/etc" "${AKKOMA_RUNTIME_DIR}/lib"
}

if [ ! -f "${CERTS_DIR}/rootCA.crt" ] || [ ! -f "${CERTS_DIR}/sidecar.crt" ] || [ ! -f "${CERTS_DIR}/akkoma.crt" ]; then
  "${SCRIPT_DIR}/generate-certs.sh"
fi

if [ "${SKIP_BUILD}" != "1" ]; then
  run_compose build mock-activitypods fedify-sidecar ap-interop-proof akkoma-app
fi

if [ "${RESET_STATE}" = "1" ]; then
  reset_akkoma_state
else
  docker compose -f "${COMPOSE_FILE}" stop gotosocial-app >/dev/null 2>&1 || true
  docker compose -f "${COMPOSE_FILE}" --profile mastodon stop mastodon-web-app mastodon-sidekiq >/dev/null 2>&1 || true
fi

run_compose up -d redis redpanda mock-activitypods akkoma-db

docker compose -f "${COMPOSE_FILE}" run --rm fedify-sidecar npm run topics:bootstrap >/dev/null

run_compose up -d fedify-sidecar ap-proxy

AP_INTEROP_AKKOMA_USERNAME="${USERNAME}" \
  "${SCRIPT_DIR}/bootstrap-akkoma-account.sh"

"${SCRIPT_DIR}/reset-harness-redis-state.sh"
rm -f "${RESULT_FILE}"

AP_INTEROP_TARGET=akkoma \
AP_INTEROP_TARGET_USERNAME="${USERNAME}" \
AP_INTEROP_RESULT_PATH=/interop/runtime/akkoma-proof-result.json \
  run_compose run --rm ap-interop-proof

AP_INTEROP_TARGET=akkoma \
AP_INTEROP_COMPOSE_FILE="${COMPOSE_FILE}" \
AP_INTEROP_PROOF_RESULT_FILE="${RESULT_FILE}" \
  npm exec --prefix "${SCRIPT_DIR}/../../.." -- tsx "${SCRIPT_DIR}/verify-target-media-proof.ts"
