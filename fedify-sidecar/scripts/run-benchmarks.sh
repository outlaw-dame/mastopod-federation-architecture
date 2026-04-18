#!/usr/bin/env bash
# run-benchmarks.sh — full sidecar benchmark suite
#
# Baseline stages (sidecar-loadtest.js, ENABLE_FEDIFY_RUNTIME_INTEGRATION=false):
#   warmup-inbox    Warm the JIT / Redis pool; results discarded for thresholds.
#   inbox           Sustained Create{Note} inbox throughput benchmark.
#   mixed           Concurrent inbox + webhook/outbox throughput benchmark.
#
# Relay stages (relay-loadtest.js, run when BENCH_RELAY=true):
#   relay-subscribe  Follow-to-relay acceptance throughput (/webhook/outbox).
#   relay-inbound    Announce{Note} inbound queue throughput (protected benchmark ingress).
#   relay-mixed      1:2 mix of subscribe + inbound scenarios.
#   signing-api      ActivityPods batch signing API throughput (requires
#                    ACTIVITYPODS_URL + ACTIVITYPODS_TOKEN; skipped otherwise).
#
# Exit codes:
#   0   All enabled stages passed thresholds.
#   99  One or more stages failed k6 thresholds.
#   1   Infrastructure / configuration error.
#
# Environment variables (all optional — sensible defaults shown):
#   TARGET_BASE_URL       http://localhost:8080
#   SIDECAR_TOKEN         benchmark-local-token
#   WARMUP_DURATION       1m
#   TEST_DURATION         4m
#   RAMP_UP_DURATION      20s
#   RAMP_DOWN_DURATION    20s
#   INBOX_VUS             25
#   INBOX_RAMP_TARGET     60
#   MIXED_VUS             20
#   MIXED_RAMP_TARGET     50
#   RELAY_VUS             20
#   RELAY_RAMP_TARGET     40
#   RELAY_ACTOR_URL       https://relay.example.com/actor
#   AP_RELAY_LOCAL_ACTOR_URI (optional canonical local relay actor URI)
#   LOCAL_RELAY_ACTOR_URI http://localhost:3000/relay
#   ACTIVITYPODS_URL      http://localhost:3000
#   ACTIVITYPODS_TOKEN    (unset — signing_api stage skipped when absent)
#   BENCH_RELAY           false  (set to "true" to enable relay stages)
#   RESET_QUEUE_STATE_BEFORE_RUN false (set to "true" for clean-slate queue state)
#   ENABLE_LAG_SOAK_CHECK false  (set to "true" to validate post-run lag drain)
#   LAG_SOAK_SAMPLES      6
#   LAG_SOAK_INTERVAL_SEC 10
#   LAG_SOAK_TARGET       1000
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BASE_DIR"

# ---------------------------------------------------------------------------
# run_stage <name> <output-file> <k6-command…>
#
# Runs a k6 stage, capturing stdout to <output-file>.  Never aborts the
# overall run on k6 threshold failures (exit 99) so that later stages still
# execute and all results are collected.  Any other non-zero exit code
# (infrastructure failure) IS propagated.
# ---------------------------------------------------------------------------
run_stage() {
  local stage_name="$1"
  local output_file="$2"
  shift 2

  echo "[bench] ▶ stage: ${stage_name}"

  set +e
  "$@" > "$output_file" 2>&1
  local status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    echo "[bench] ✔ ${stage_name} passed"
  elif [[ $status -eq 99 ]]; then
    echo "[bench] ✖ ${stage_name} failed thresholds (exit 99)"
  else
    echo "[bench] ✖ ${stage_name} infrastructure error (exit ${status})"
  fi

  echo "${stage_name}=${status}" >> "$RESULT_DIR/stage-status.txt"
  return 0
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

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

# Relay-specific tuning — typically lower concurrency than baseline because
# each relay_subscribe enqueues Redis work and relay_mixed involves crypto.
RELAY_VUS="${RELAY_VUS:-20}"
RELAY_RAMP_TARGET="${RELAY_RAMP_TARGET:-40}"
RELAY_ACTOR_URL="${RELAY_ACTOR_URL:-https://relay.example.com/actor}"
AP_RELAY_LOCAL_ACTOR_URI="${AP_RELAY_LOCAL_ACTOR_URI:-}"
LOCAL_RELAY_ACTOR_URI="${LOCAL_RELAY_ACTOR_URI:-${AP_RELAY_LOCAL_ACTOR_URI:-http://localhost:3000/relay}}"

ACTIVITYPODS_URL="${ACTIVITYPODS_URL:-http://localhost:3000}"
# ACTIVITYPODS_TOKEN intentionally has no default — absence disables signing stage.
ACTIVITYPODS_TOKEN="${ACTIVITYPODS_TOKEN:-}"

# Set BENCH_RELAY=true to run the relay-specific benchmark stages.
BENCH_RELAY="${BENCH_RELAY:-false}"
RESET_QUEUE_STATE_BEFORE_RUN="${RESET_QUEUE_STATE_BEFORE_RUN:-false}"

# Optional post-run lag soak gate.
ENABLE_LAG_SOAK_CHECK="${ENABLE_LAG_SOAK_CHECK:-false}"
LAG_SOAK_SAMPLES="${LAG_SOAK_SAMPLES:-6}"
LAG_SOAK_INTERVAL_SEC="${LAG_SOAK_INTERVAL_SEC:-10}"
LAG_SOAK_TARGET="${LAG_SOAK_TARGET:-1000}"

# ---------------------------------------------------------------------------
# Result directory
# ---------------------------------------------------------------------------

RUN_ID="$(date +%Y%m%d-%H%M%S)"
RESULT_DIR="loadtest/results/$RUN_ID"
mkdir -p "$RESULT_DIR"

echo "[bench] run id:      $RUN_ID"
echo "[bench] target:      $TARGET_BASE_URL"
echo "[bench] bench relay: $BENCH_RELAY"
echo "[bench] results:     $RESULT_DIR"
echo ""

if [[ "$RESET_QUEUE_STATE_BEFORE_RUN" == "true" ]]; then
  echo "[bench] reset queue state"
  ./scripts/reset-queue-state.sh > "$RESULT_DIR/queue-reset.txt" 2>&1
  echo "[bench] ✔ queue state reset"
  echo ""
fi

# ---------------------------------------------------------------------------
# Pre-flight health check — abort early on unreachable target
# ---------------------------------------------------------------------------

echo "[bench] health check"
if ! curl -fsS --max-time 10 "$TARGET_BASE_URL/health" > "$RESULT_DIR/health.json"; then
  echo "[bench] ERROR: sidecar health check failed — is the sidecar running at $TARGET_BASE_URL?"
  exit 1
fi
echo "[bench] ✔ sidecar healthy"
echo ""

# ---------------------------------------------------------------------------
# Baseline benchmark stages (sidecar-loadtest.js)
# ---------------------------------------------------------------------------

echo "[bench] === BASELINE STAGES ==="

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

echo "[bench] benchmark: inbox (Create{Note} throughput)"
run_stage "inbox" "$RESULT_DIR/inbox.json" \
  k6 run loadtest/sidecar-loadtest.js \
    -e TARGET_BASE_URL="$TARGET_BASE_URL" \
    -e SCENARIO=inbox \
    -e DURATION="$TEST_DURATION" \
    -e RAMP_UP_DURATION="$RAMP_UP_DURATION" \
    -e RAMP_DOWN_DURATION="$RAMP_DOWN_DURATION" \
    -e VUS="$INBOX_VUS" \
    -e RAMP_TARGET="$INBOX_RAMP_TARGET"

echo "[bench] benchmark: mixed (inbox + webhook/outbox concurrency)"
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

# ---------------------------------------------------------------------------
# Relay benchmark stages (relay-loadtest.js) — opt-in via BENCH_RELAY=true
# ---------------------------------------------------------------------------

if [[ "$BENCH_RELAY" == "true" ]]; then
  echo ""
  echo "[bench] === RELAY STAGES ==="

  echo "[bench] benchmark: relay_subscribe (Follow-to-relay acceptance)"
  run_stage "relay-subscribe" "$RESULT_DIR/relay-subscribe.json" \
    k6 run loadtest/relay-loadtest.js \
      -e TARGET_BASE_URL="$TARGET_BASE_URL" \
      -e SCENARIO=relay_subscribe \
      -e SIDECAR_TOKEN="$SIDECAR_TOKEN" \
      -e RELAY_ACTOR_URL="$RELAY_ACTOR_URL" \
      -e LOCAL_RELAY_ACTOR_URI="$LOCAL_RELAY_ACTOR_URI" \
      -e DURATION="$TEST_DURATION" \
      -e RAMP_UP_DURATION="$RAMP_UP_DURATION" \
      -e RAMP_DOWN_DURATION="$RAMP_DOWN_DURATION" \
      -e VUS="$RELAY_VUS" \
      -e RAMP_TARGET="$RELAY_RAMP_TARGET"

  echo "[bench] benchmark: relay_inbound (Announce{Note} inbound queue)"
  run_stage "relay-inbound" "$RESULT_DIR/relay-inbound.json" \
    k6 run loadtest/relay-loadtest.js \
      -e TARGET_BASE_URL="$TARGET_BASE_URL" \
      -e SCENARIO=relay_inbound \
      -e SIDECAR_TOKEN="$SIDECAR_TOKEN" \
      -e RELAY_ACTOR_URL="$RELAY_ACTOR_URL" \
      -e DURATION="$TEST_DURATION" \
      -e RAMP_UP_DURATION="$RAMP_UP_DURATION" \
      -e RAMP_DOWN_DURATION="$RAMP_DOWN_DURATION" \
      -e VUS="$RELAY_VUS" \
      -e RAMP_TARGET="$RELAY_RAMP_TARGET"

  echo "[bench] benchmark: relay_mixed (subscribe + inbound concurrency)"
  run_stage "relay-mixed" "$RESULT_DIR/relay-mixed.json" \
    k6 run loadtest/relay-loadtest.js \
      -e TARGET_BASE_URL="$TARGET_BASE_URL" \
      -e SCENARIO=relay_mixed \
      -e SIDECAR_TOKEN="$SIDECAR_TOKEN" \
      -e RELAY_ACTOR_URL="$RELAY_ACTOR_URL" \
      -e LOCAL_RELAY_ACTOR_URI="$LOCAL_RELAY_ACTOR_URI" \
      -e DURATION="$TEST_DURATION" \
      -e RAMP_UP_DURATION="$RAMP_UP_DURATION" \
      -e RAMP_DOWN_DURATION="$RAMP_DOWN_DURATION" \
      -e VUS="$RELAY_VUS" \
      -e RAMP_TARGET="$RELAY_RAMP_TARGET"

  # signing_api is gated on ACTIVITYPODS_TOKEN being set.  The token is
  # passed directly to k6 — it appears only in Authorization request headers
  # and is never written to result files or stdout.
  if [[ -n "$ACTIVITYPODS_TOKEN" ]]; then
    echo "[bench] benchmark: signing_api (ActivityPods batch signing throughput)"
    run_stage "signing-api" "$RESULT_DIR/signing-api.json" \
      k6 run loadtest/relay-loadtest.js \
        -e TARGET_BASE_URL="$TARGET_BASE_URL" \
        -e SCENARIO=signing_api \
        -e ACTIVITYPODS_URL="$ACTIVITYPODS_URL" \
        -e ACTIVITYPODS_TOKEN="$ACTIVITYPODS_TOKEN" \
        -e LOCAL_RELAY_ACTOR_URI="$LOCAL_RELAY_ACTOR_URI" \
        -e RELAY_ACTOR_URL="$RELAY_ACTOR_URL" \
        -e DURATION="$TEST_DURATION" \
        -e RAMP_UP_DURATION="$RAMP_UP_DURATION" \
        -e RAMP_DOWN_DURATION="$RAMP_DOWN_DURATION" \
        -e VUS="$RELAY_VUS" \
        -e RAMP_TARGET="$RELAY_RAMP_TARGET"
  else
    echo "[bench] ⚠ signing_api stage skipped: ACTIVITYPODS_TOKEN is not set"
    echo "signing-api=skipped" >> "$RESULT_DIR/stage-status.txt"
  fi
fi

# ---------------------------------------------------------------------------
# Final metrics snapshot + summary
# ---------------------------------------------------------------------------

echo ""
echo "[bench] metrics snapshot"
curl -fsS --max-time 10 "$TARGET_BASE_URL/metrics" > "$RESULT_DIR/metrics.prom" || \
  echo "[bench] ⚠ metrics endpoint unreachable — snapshot skipped"

echo ""
echo "[bench] === RESULTS ==="
cat "$RESULT_DIR/stage-status.txt"
echo ""
echo "[bench] result files:"
ls -1 "$RESULT_DIR"
echo ""

if [[ "$ENABLE_LAG_SOAK_CHECK" == "true" ]]; then
  echo "[bench] soak: inbound lag slope check"
  set +e
  SAMPLE_COUNT="$LAG_SOAK_SAMPLES" \
    SAMPLE_INTERVAL_SEC="$LAG_SOAK_INTERVAL_SEC" \
    TARGET_FINAL_LAG="$LAG_SOAK_TARGET" \
    ./scripts/check-inbound-lag-slope.sh \
    > "$RESULT_DIR/inbound-lag-soak.txt" 2>&1
  LAG_SOAK_STATUS=$?
  set -e

  if [[ $LAG_SOAK_STATUS -eq 0 ]]; then
    echo "[bench] ✔ lag-soak passed"
  elif [[ $LAG_SOAK_STATUS -eq 99 ]]; then
    echo "[bench] ✖ lag-soak failed (exit 99)"
  else
    echo "[bench] ✖ lag-soak infrastructure/config error (exit ${LAG_SOAK_STATUS})"
  fi

  echo "lag-soak=${LAG_SOAK_STATUS}" >> "$RESULT_DIR/stage-status.txt"
  cat "$RESULT_DIR/inbound-lag-soak.txt"
  echo ""
fi

# Exit 99 if any stage failed k6 thresholds; 0 if all passed or were skipped.
if grep -qE '=[0-9]' "$RESULT_DIR/stage-status.txt" && \
   grep -qE '=99$' "$RESULT_DIR/stage-status.txt"; then
  echo "[bench] ✖ one or more benchmark stages failed thresholds — see result files above"
  exit 99
fi

echo "[bench] ✔ all benchmark stages passed"
