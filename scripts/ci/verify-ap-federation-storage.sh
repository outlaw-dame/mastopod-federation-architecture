#!/usr/bin/env bash
set -euo pipefail

# CI storage readiness guard for ActivityPub federation lanes.
# This intentionally validates infrastructure state rather than masking
# application-level federation failures.

FUSEKI_URL="${FUSEKI_URL:-http://localhost:3030}"
DATASETS=("api" "users")

for attempt in $(seq 1 60); do
  if curl -fsS "${FUSEKI_URL}/$/server" >/dev/null 2>&1; then
    break
  fi
  if [[ "${attempt}" == "60" ]]; then
    echo "Fuseki did not become reachable: ${FUSEKI_URL}" >&2
    exit 1
  fi
  sleep 2
done

existing="$(curl -fsS "${FUSEKI_URL}/$/datasets")"

for dataset in "${DATASETS[@]}"; do
  if ! grep -q "\"ds.name\".*\"/${dataset}\"\|\"${dataset}\"" <<<"${existing}"; then
    echo "Missing required dataset: ${dataset}" >&2
    echo "Available datasets:" >&2
    echo "${existing}" >&2
    exit 1
  fi
done

echo "ActivityPub storage readiness verified: ${DATASETS[*]}"
