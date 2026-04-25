#!/usr/bin/env bash
set -euo pipefail

# Checks whether inbound consumer-group lag trends down over a soak window.
# Exit 0: lag is strictly decreasing and final lag is <= target lag.
# Exit 99: lag not decreasing fast enough, or final lag still too high.
# Exit 2: usage/config error.

STREAM_KEY="${STREAM_KEY:-ap:queue:inbound:v1}"
GROUP_NAME="${GROUP_NAME:-sidecar-workers}"
SAMPLE_COUNT="${SAMPLE_COUNT:-6}"
SAMPLE_INTERVAL_SEC="${SAMPLE_INTERVAL_SEC:-10}"
TARGET_FINAL_LAG="${TARGET_FINAL_LAG:-1000}"
REDIS_CLI="${REDIS_CLI:-redis-cli}"

if ! [[ "$SAMPLE_COUNT" =~ ^[0-9]+$ ]] || ! [[ "$SAMPLE_INTERVAL_SEC" =~ ^[0-9]+$ ]] || ! [[ "$TARGET_FINAL_LAG" =~ ^[0-9]+$ ]]; then
  echo "[lag-check] SAMPLE_COUNT, SAMPLE_INTERVAL_SEC, and TARGET_FINAL_LAG must be integers" >&2
  exit 2
fi

if [ "$SAMPLE_COUNT" -lt 2 ]; then
  echo "[lag-check] SAMPLE_COUNT must be >= 2" >&2
  exit 2
fi

get_lag() {
  "$REDIS_CLI" xinfo groups "$STREAM_KEY" 2>/dev/null \
    | awk 'BEGIN{seen=0} $1=="lag"{seen=1; next} seen==1 {gsub(/[^0-9]/, "", $0); print $0; exit}'
}

declare -a lags=()

echo "[lag-check] stream=$STREAM_KEY group=$GROUP_NAME samples=$SAMPLE_COUNT interval=${SAMPLE_INTERVAL_SEC}s target_final_lag=$TARGET_FINAL_LAG"

for i in $(seq 1 "$SAMPLE_COUNT"); do
  lag="$(get_lag || true)"
  if [ -z "${lag:-}" ]; then
    echo "[lag-check] could not read lag from XINFO GROUPS" >&2
    exit 2
  fi

  lags+=("$lag")
  echo "[lag-check] sample $i/$SAMPLE_COUNT lag=$lag"

  if [ "$i" -lt "$SAMPLE_COUNT" ]; then
    sleep "$SAMPLE_INTERVAL_SEC"
  fi
done

start_lag="${lags[0]}"
end_lag="${lags[$(( ${#lags[@]} - 1 ))]}"

monotonic_drop=1
for i in $(seq 1 $(( ${#lags[@]} - 1 ))); do
  prev="${lags[$((i - 1))]}"
  curr="${lags[$i]}"
  if [ "$curr" -gt "$prev" ]; then
    monotonic_drop=0
    break
  fi
done

slope=$((start_lag - end_lag))

if [ "$monotonic_drop" -eq 1 ] && [ "$end_lag" -le "$TARGET_FINAL_LAG" ]; then
  echo "[lag-check] PASS: lag dropped monotonically by $slope ($start_lag -> $end_lag), final <= $TARGET_FINAL_LAG"
  exit 0
fi

if [ "$monotonic_drop" -eq 1 ]; then
  echo "[lag-check] FAIL: lag dropped by $slope ($start_lag -> $end_lag) but final lag still above target $TARGET_FINAL_LAG"
  exit 99
fi

echo "[lag-check] FAIL: lag is not monotonically decreasing (start=$start_lag end=$end_lag target=$TARGET_FINAL_LAG)"
exit 99
