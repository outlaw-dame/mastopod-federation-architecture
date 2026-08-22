#!/usr/bin/env bash
set -euo pipefail

# CI storage readiness guard for real ActivityPods federation lanes.
# Keep this under src/adsp so changes automatically trigger both P0 and W3.

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

  query_result="$(curl -fsS -G \
    -H 'Accept: application/sparql-results+json' \
    --data-urlencode 'query=ASK {}' \
    "${FUSEKI_URL}/${dataset}/query")"
  if ! grep -Eq '"boolean"[[:space:]]*:[[:space:]]*true' <<<"${query_result}"; then
    echo "Dataset is registered but not queryable: ${dataset}" >&2
    echo "SPARQL response:" >&2
    echo "${query_result}" >&2
    exit 1
  fi
done

echo "ActivityPub storage readiness verified and queryable: ${DATASETS[*]}"