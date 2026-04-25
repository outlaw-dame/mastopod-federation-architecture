#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SIDECAR_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)

cd "${SIDECAR_ROOT}"

if [ ! -f .env.local ]; then
  echo "Missing .env.local in ${SIDECAR_ROOT}" >&2
  exit 1
fi

# shellcheck disable=SC1091
. ./.env.local

if [ -z "${SIDECAR_TOKEN:-}" ]; then
  echo "SIDECAR_TOKEN is not set after loading .env.local" >&2
  exit 1
fi

COMMON_FLAGS="-e RAMP_UP_DURATION=0s -e RAMP_DOWN_DURATION=0s -e SIDECAR_TOKEN=${SIDECAR_TOKEN}"

echo "[relay-confidence] Running relay_burst (5s, VUS=1)"
k6 run loadtest/relay-loadtest.js \
  -e SCENARIO=relay_burst \
  -e DURATION="${BURST_DURATION:-5s}" \
  -e VUS="${BURST_VUS:-1}" \
  ${COMMON_FLAGS}

echo "[relay-confidence] Running relay_mixed (5s, VUS=5)"
k6 run loadtest/relay-loadtest.js \
  -e SCENARIO=relay_mixed \
  -e DURATION="${MIXED_DURATION:-5s}" \
  -e VUS="${MIXED_VUS:-5}" \
  ${COMMON_FLAGS}

echo "[relay-confidence] Completed"