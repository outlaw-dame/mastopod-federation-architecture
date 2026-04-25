#!/usr/bin/env bash
# run-relay-confidence-ci.sh — CI-safe relay confidence check
#
# Runs relay_burst and relay_mixed, emits a compact JSON summary artifact
# per run, and appends a one-line trend record for longitudinal tracking.
#
# Usage (from fedify-sidecar root):
#   npm run loadtest:k6:relay:confidence:ci
#   MIXED_VUS=10 npm run loadtest:k6:relay:confidence:ci
#
# Environment (all optional — defaults shown):
#   TARGET_BASE_URL   http://localhost:8080
#   BURST_DURATION    5s
#   BURST_VUS         1
#   MIXED_DURATION    5s
#   MIXED_VUS         5
#
# Exits:
#   0   All scenarios passed thresholds.
#   99  One or more scenarios failed thresholds.
#   1   Configuration / infrastructure error.
#
# Artifact layout (matches existing benchmark convention):
#   loadtest/results/<RUN_ID>/relay-burst-summary.json   k6 per-scenario summary
#   loadtest/results/<RUN_ID>/relay-burst.log            k6 console output
#   loadtest/results/<RUN_ID>/relay-mixed-summary.json
#   loadtest/results/<RUN_ID>/relay-mixed.log
#   loadtest/results/<RUN_ID>/relay-confidence-summary.json  combined compact artifact
#   loadtest/results/<RUN_ID>/stage-status.txt
#   loadtest/results/relay-confidence-trend.ndjson           appended trend line

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SIDECAR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SIDECAR_ROOT"

# ---------------------------------------------------------------------------
# Environment bootstrap
# ---------------------------------------------------------------------------

if [ ! -f .env.local ]; then
  echo "[confidence-ci] ERROR: .env.local not found in $SIDECAR_ROOT" >&2
  exit 1
fi

# shellcheck disable=SC1091
. ./.env.local

if [ -z "${SIDECAR_TOKEN:-}" ]; then
  echo "[confidence-ci] ERROR: SIDECAR_TOKEN not set after loading .env.local" >&2
  exit 1
fi

BURST_DURATION="${BURST_DURATION:-5s}"
BURST_VUS="${BURST_VUS:-1}"
MIXED_DURATION="${MIXED_DURATION:-5s}"
MIXED_VUS="${MIXED_VUS:-5}"
TARGET_BASE_URL="${TARGET_BASE_URL:-http://localhost:8080}"

# ---------------------------------------------------------------------------
# Result directory (matches existing loadtest/results/YYYYMMDD-HHMMSS layout)
# ---------------------------------------------------------------------------

RUN_ID="$(date +%Y%m%d-%H%M%S)"
RESULT_DIR="loadtest/results/$RUN_ID"
mkdir -p "$RESULT_DIR"

echo "[confidence-ci] run id:  $RUN_ID"
echo "[confidence-ci] target:  $TARGET_BASE_URL"
echo "[confidence-ci] results: $RESULT_DIR"
echo ""

# ---------------------------------------------------------------------------
# Stage runner
#
# Collects k6 console output to a .log file and a structured JSON metric
# summary via --summary-export.  Never aborts on exit 99 (threshold failure)
# so both scenarios always run; propagates any non-99 infra error immediately.
# ---------------------------------------------------------------------------

OVERALL_STATUS=0

run_stage() {
  local stage_name="$1"
  local summary_file="$2"
  local log_file="$3"
  shift 3

  echo "[confidence-ci] ▶ $stage_name"

  set +e
  "$@" --summary-export="$summary_file" > "$log_file" 2>&1
  local status=$?
  set -e

  if [ $status -eq 0 ]; then
    echo "[confidence-ci] ✔ $stage_name passed"
  elif [ $status -eq 99 ]; then
    echo "[confidence-ci] ✖ $stage_name FAILED thresholds"
    OVERALL_STATUS=99
  else
    echo "[confidence-ci] ✖ $stage_name infrastructure error (exit $status)" >&2
    cat "$log_file" >&2
    exit $status
  fi

  printf '%s=%d\n' "$stage_name" "$status" >> "$RESULT_DIR/stage-status.txt"
}

# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

run_stage "relay_burst" \
  "$RESULT_DIR/relay-burst-summary.json" \
  "$RESULT_DIR/relay-burst.log" \
  k6 run loadtest/relay-loadtest.js \
    -e SCENARIO=relay_burst \
    -e DURATION="$BURST_DURATION" \
    -e RAMP_UP_DURATION=0s \
    -e RAMP_DOWN_DURATION=0s \
    -e VUS="$BURST_VUS" \
    -e SIDECAR_TOKEN="$SIDECAR_TOKEN" \
    -e TARGET_BASE_URL="$TARGET_BASE_URL"

run_stage "relay_mixed" \
  "$RESULT_DIR/relay-mixed-summary.json" \
  "$RESULT_DIR/relay-mixed.log" \
  k6 run loadtest/relay-loadtest.js \
    -e SCENARIO=relay_mixed \
    -e DURATION="$MIXED_DURATION" \
    -e RAMP_UP_DURATION=0s \
    -e RAMP_DOWN_DURATION=0s \
    -e VUS="$MIXED_VUS" \
    -e SIDECAR_TOKEN="$SIDECAR_TOKEN" \
    -e TARGET_BASE_URL="$TARGET_BASE_URL"

# ---------------------------------------------------------------------------
# Compact combined artifact — assembled via Node.js (CommonJS stdin mode
# avoids conflicts with the project's "type":"module" package.json)
# ---------------------------------------------------------------------------

ARTIFACT="$RESULT_DIR/relay-confidence-summary.json"

node --input-type=commonjs - \
  "$RUN_ID" \
  "$RESULT_DIR/relay-burst-summary.json" \
  "$RESULT_DIR/relay-mixed-summary.json" \
  "$RESULT_DIR/stage-status.txt" \
  "$ARTIFACT" \
  <<'NODEEOF'
const fs = require('fs');
const [,, runId, burstFile, mixedFile, statusFile, artifactFile] = process.argv;

function loadSummary(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

function pickMetrics(summary) {
  if (!summary || !summary.metrics) return null;
  const m = summary.metrics;
  // k6 v1.x --summary-export: values are flat on the metric object (no .values wrapper).
  // Rate metrics expose the rate as `.value`; Trend metrics expose percentiles directly as `p(95)` etc.
  const get = (key, sub) => {
    const mm = m[key];
    if (!mm) return null;
    const v = mm[sub];
    return v != null ? v : null;
  };
  return {
    http_req_failed_rate:      get('http_req_failed', 'value'),
    http_req_duration_p95_ms:  get('http_req_duration', 'p(95)'),
    http_req_duration_p99_ms:  get('http_req_duration', 'p(99)'),
    expected_status_rate:      get('relay_loadtest_expected_status_rate', 'value'),
    app_latency_p95_ms:        get('relay_loadtest_app_latency_ms', 'p(95)'),
    checks_passes:             get('checks', 'passes'),
    checks_fails:              get('checks', 'fails'),
  };
}

const stageStatus = Object.fromEntries(
  fs.readFileSync(statusFile, 'utf8').trim().split('\n').map(l => {
    const eq = l.indexOf('=');
    return [l.slice(0, eq), parseInt(l.slice(eq + 1), 10)];
  })
);

const artifact = {
  run_id:      runId,
  timestamp:   new Date().toISOString(),
  all_passed:  Object.values(stageStatus).every(v => v === 0),
  stages:      stageStatus,
  relay_burst: pickMetrics(loadSummary(burstFile)),
  relay_mixed: pickMetrics(loadSummary(mixedFile)),
};

fs.writeFileSync(artifactFile, JSON.stringify(artifact, null, 2) + '\n');
NODEEOF

echo ""
echo "[confidence-ci] artifact: $ARTIFACT"
cat "$ARTIFACT"

# ---------------------------------------------------------------------------
# Trend log — one JSON line per run appended for longitudinal tracking.
# Never fails the overall exit if trend write fails.
# ---------------------------------------------------------------------------

TREND_FILE="loadtest/results/relay-confidence-trend.ndjson"

node --input-type=commonjs - "$ARTIFACT" "$TREND_FILE" <<'NODEEOF' || true
const fs = require('fs');
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const line = JSON.stringify({
  run_id:               a.run_id,
  timestamp:            a.timestamp,
  all_passed:           a.all_passed,
  burst_p95_ms:         a.relay_burst  && a.relay_burst.http_req_duration_p95_ms,
  burst_fail_rate:      a.relay_burst  && a.relay_burst.http_req_failed_rate,
  mixed_p95_ms:         a.relay_mixed  && a.relay_mixed.http_req_duration_p95_ms,
  mixed_fail_rate:      a.relay_mixed  && a.relay_mixed.http_req_failed_rate,
  mixed_checks_passes:  a.relay_mixed  && a.relay_mixed.checks_passes,
  mixed_checks_fails:   a.relay_mixed  && a.relay_mixed.checks_fails,
});
fs.appendFileSync(process.argv[3], line + '\n');
NODEEOF

echo "[confidence-ci] trend:    $TREND_FILE"
echo ""

# ---------------------------------------------------------------------------
# Final exit
# ---------------------------------------------------------------------------

if [ "$OVERALL_STATUS" -ne 0 ]; then
  echo "[confidence-ci] RESULT: FAILED — one or more scenarios did not meet thresholds" >&2
  exit "$OVERALL_STATUS"
fi

echo "[confidence-ci] RESULT: All scenarios passed."
