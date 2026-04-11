#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SIDECAR_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)

PORT=${MRF_SMOKE_PORT:-18080}
HOST=${MRF_SMOKE_HOST:-127.0.0.1}
BASE_URL=${MRF_ADMIN_BASE_URL:-"http://${HOST}:${PORT}"}
STORE_MODE=${MRF_ADMIN_STORE:-memory}
REDIS_URL_VALUE=${REDIS_URL:-redis://localhost:6379}
LOG_FILE=${MRF_SMOKE_LOG_FILE:-"/tmp/fedify-sidecar-mrf-smoke.log"}

if lsof -i "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use; set MRF_SMOKE_PORT to a free port" >&2
  exit 1
fi

if [ -z "${MRF_ADMIN_TOKEN:-}" ]; then
  MRF_ADMIN_TOKEN=$(node --input-type=module -e 'import crypto from "node:crypto"; console.log(crypto.randomBytes(24).toString("hex"));')
fi

cleanup() {
  if [ -n "${SIDECAR_PID:-}" ] && kill -0 "${SIDECAR_PID}" >/dev/null 2>&1; then
    kill "${SIDECAR_PID}" >/dev/null 2>&1 || true
    wait "${SIDECAR_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

cd "${SIDECAR_ROOT}"

echo "[mrf-smoke] building sidecar"
npm run build >/dev/null

echo "[mrf-smoke] starting sidecar on ${HOST}:${PORT}"
ENABLE_MRF_ADMIN_API=true \
MRF_ADMIN_TOKEN="${MRF_ADMIN_TOKEN}" \
MRF_ADMIN_STORE="${STORE_MODE}" \
MRF_ADMIN_REDIS_PREFIX="mrf:admin:smoke" \
REDIS_URL="${REDIS_URL_VALUE}" \
NODE_ENV=test \
HOST="${HOST}" \
PORT="${PORT}" \
ENABLE_OUTBOUND_WORKER=false \
ENABLE_INBOUND_WORKER=false \
ENABLE_OUTBOX_INTENT_WORKER=false \
ENABLE_OPENSEARCH_INDEXER=false \
ENABLE_XRPC_SERVER=false \
ENABLE_ATPROTO_OAUTH=false \
ENABLE_PROTOCOL_BRIDGE_AP_TO_AT=false \
ENABLE_PROTOCOL_BRIDGE_AT_TO_AP=false \
ENABLE_FEDIFY_RUNTIME_INTEGRATION=false \
node dist/index.js >"${LOG_FILE}" 2>&1 &
SIDECAR_PID=$!

# Exponential backoff readiness probe.
READY=0
for DELAY in 0.1 0.2 0.4 0.8 1.6 2 2 2; do
  if curl -fsS --max-time 2 "${BASE_URL}/health" >/dev/null 2>&1; then
    READY=1
    break
  fi

  if ! kill -0 "${SIDECAR_PID}" >/dev/null 2>&1; then
    break
  fi

  sleep "${DELAY}"
done

if [ "${READY}" -ne 1 ]; then
  echo "[mrf-smoke] sidecar did not become ready" >&2
  echo "[mrf-smoke] tailing startup logs from ${LOG_FILE}" >&2
  tail -n 80 "${LOG_FILE}" >&2 || true
  exit 1
fi

echo "[mrf-smoke] running API smoke verifier"
MRF_ADMIN_BASE_URL="${BASE_URL}" \
MRF_ADMIN_TOKEN="${MRF_ADMIN_TOKEN}" \
npm run smoke:mrf-admin

echo "[mrf-smoke] success"
