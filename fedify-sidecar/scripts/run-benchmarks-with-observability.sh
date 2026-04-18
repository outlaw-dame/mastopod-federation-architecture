#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BASE_DIR"

BENCH_RELAY="${BENCH_RELAY:-true}"
export BENCH_RELAY

echo "[bench+obs] starting benchmark (BENCH_RELAY=${BENCH_RELAY})"
set +e
./scripts/run-benchmarks.sh
bench_status=$?
set -e

latest_dir="$(ls -1dt loadtest/results/* 2>/dev/null | head -n 1 || true)"
if [[ -z "${latest_dir}" ]]; then
  echo "[bench+obs] ERROR: no benchmark result directory found"
  exit 1
fi

echo "[bench+obs] latest result dir: ${latest_dir}"

if [[ -n "${ADMIN_TOKEN:-${MRF_ADMIN_TOKEN:-}}" ]]; then
  echo "[bench+obs] capturing observability snapshot"
  ADMIN_TOKEN="${ADMIN_TOKEN:-${MRF_ADMIN_TOKEN:-}}" \
  BASE_URL="${BASE_URL:-http://127.0.0.1:8080}" \
  LIMIT="${LIMIT:-25}" \
  FORMAT=json \
  OUTPUT_FILE="${latest_dir}/at-observability-snapshot.json" \
  ./scripts/at-observability-report.sh >/dev/null

  echo "[bench+obs] wrote ${latest_dir}/at-observability-snapshot.json"
else
  echo "[bench+obs] ADMIN_TOKEN/MRF_ADMIN_TOKEN not set; skipping observability snapshot"
fi

echo "[bench+obs] stage status:"
cat "${latest_dir}/stage-status.txt"

if [[ $bench_status -ne 0 ]]; then
  echo "[bench+obs] benchmark exited with status ${bench_status}"
fi

exit $bench_status
