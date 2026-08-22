#!/usr/bin/env bash
set -euo pipefail

# CI storage readiness guard for real ActivityPods federation lanes.
# Keep this under src/adsp so changes automatically trigger both P0 and W3.
# Probe the actual SPARQL endpoints: Fuseki administrative endpoints may be
# access-controlled independently and are not part of the federation contract.

FUSEKI_URL="${FUSEKI_URL:-http://localhost:3030}"
WAIT_SECONDS="${WAIT_SECONDS:-120}"
DATASETS=("api" "users")

if ! [[ "${WAIT_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "WAIT_SECONDS must be a positive integer, got: ${WAIT_SECONDS}" >&2
  exit 1
fi

probe_dataset() {
  local dataset="$1"
  local response

  response="$(curl -fsS --max-time 2 \
    -H 'Accept: application/sparql-results+json' \
    --data-urlencode 'query=ASK {}' \
    "${FUSEKI_URL}/${dataset}/query" 2>/dev/null)" || return 1

  grep -Eq '"boolean"[[:space:]]*:[[:space:]]*true' <<<"${response}"
}

for dataset in "${DATASETS[@]}"; do
  ready=false
  for attempt in $(seq 1 "${WAIT_SECONDS}"); do
    if probe_dataset "${dataset}"; then
      ready=true
      break
    fi
    sleep 1
  done

  if [[ "${ready}" != true ]]; then
    echo "Required ActivityPub dataset did not become queryable within ${WAIT_SECONDS}s: ${dataset} (${FUSEKI_URL}/${dataset}/query)" >&2
    exit 1
  fi
done

echo "ActivityPub storage readiness verified via SPARQL: ${DATASETS[*]}"