#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BASE_DIR"

run_stage() {
  local stage_name="$1"
  local output_file="$2"
  shift 2

  set +e
  "$@" > "$output_file"
  local status=$?
  set -e

  echo "[bench] stage ${stage_name} exit=${status}"
  echo "${stage_name}=${status}" >> "$RESULT_DIR/stage-status.txt"
  return 0
}

TARGET_BASE_URL="${TARGET_BASE_URL:-http://localhost:8080}"
SIDECAR_TOKEN="${SIDECAR_TOKEN:-benchmark-local-token}"
WARMUP_DURATION="${WARMUP_DURATION:-1m}"
TEST_DURATION="${TEST_DURATION:-4m}"
RAMP_UP_DURATION="${RAMP_UP_DURATION:-20s}"
RAMP_DOWN_DURATION="${RAMP_DOWN_DURATION:-20s}"
INBOX_VUS="${INBOX_VUS:-25}"
INBOX_RAMP_TARGET="${INBOX_RAMP_TARGET:-60}"
MIXED_VUS="${MIXED_VUS:-20}"
MIXED_RAMP_TARGET="${MIXED_RAMP_TARGET:-50}"

RUN_ID="$(date +%Y%m%d-%H%M%S)"
RESULT_DIR="loadtest/results/$RUN_ID"
mkdir -p "$RESULT_DIR"

echo "[bench] run id: $RUN_ID"
echo "[bench] target: $TARGET_BASE_URL"
echo "[bench] results: $RESULT_DIR"

echo "[bench] health check"
curl -fsS "$TARGET_BASE_URL/health" > "$RESULT_DIR/health.json"

echo "[bench] warmup: inbox"
run_stage "warmup-inbox" "$RESULT_DIR/warmup-inbox.json" \
  k6 run --no-thresholds loadtest/sidecar-loadtest.js \
  -e TARGET_BASE_URL="$TARGET_BASE_URL" \
  -e SCENARIO=inbox \
  -e DURATION="$WARMUP_DURATION" \
  -e RAMP_UP_DURATION="$RAMP_UP_DURATION" \
  -e RAMP_DOWN_DURATION="$RAMP_DOWN_DURATION" \
  -e VUS="10" \
  -e RAMP_TARGET="20"

echo "[bench] benchmark: inbox"
run_stage "inbox" "$RESULT_DIR/inbox.json" \
  k6 run loadtest/sidecar-loadtest.js \
  -e TARGET_BASE_URL="$TARGET_BASE_URL" \
  -e SCENARIO=inbox \
  -e DURATION="$TEST_DURATION" \
  -e RAMP_UP_DURATION="$RAMP_UP_DURATION" \
  -e RAMP_DOWN_DURATION="$RAMP_DOWN_DURATION" \
  -e VUS="$INBOX_VUS" \
  -e RAMP_TARGET="$INBOX_RAMP_TARGET"

echo "[bench] benchmark: mixed"
run_stage "mixed" "$RESULT_DIR/mixed.json" \
  k6 run loadtest/sidecar-loadtest.js \
  -e TARGET_BASE_URL="$TARGET_BASE_URL" \
  -e SCENARIO=mixed \
  -e DURATION="$TEST_DURATION" \
  -e RAMP_UP_DURATION="$RAMP_UP_DURATION" \
  -e RAMP_DOWN_DURATION="$RAMP_DOWN_DURATION" \
  -e VUS="$MIXED_VUS" \
  -e RAMP_TARGET="$MIXED_RAMP_TARGET" \
  -e SIDECAR_TOKEN="$SIDECAR_TOKEN"

echo "[bench] metrics snapshot"
curl -fsS "$TARGET_BASE_URL/metrics" > "$RESULT_DIR/metrics.prom"

echo "[bench] done"
echo "[bench] stage status:"
cat "$RESULT_DIR/stage-status.txt"
echo "[bench] result files:"
ls -1 "$RESULT_DIR"

if grep -q '=99' "$RESULT_DIR/stage-status.txt"; then
  echo "[bench] one or more benchmark stages failed thresholds"
  exit 99
fi
