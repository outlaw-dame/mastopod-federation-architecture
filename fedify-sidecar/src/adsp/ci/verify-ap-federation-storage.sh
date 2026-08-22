#!/usr/bin/env bash
set -euo pipefail

# CI storage readiness guard for real ActivityPods federation lanes.
# Keep this under src/adsp so changes automatically trigger both P0 and W3.
#
# This runs before the real origin fixture signs up its sender. ActivityPods
# provisions each user's dataset dynamically during signup, so a pre-signup
# guard must not invent fixed user datasets such as "api" or "users". The
# bootstrapped auth/control dataset is the authoritative storage dependency at
# this boundary; the subsequent real signup + outbox execution proves dynamic
# per-user dataset provisioning and ActivityPub persistence end to end.
#
# Probe the actual SPARQL query endpoint rather than Fuseki administrative
# endpoints, which may be access-controlled independently of application data.

FUSEKI_URL="${FUSEKI_URL:-http://localhost:3030}"
WAIT_SECONDS="${WAIT_SECONDS:-120}"
AUTH_DATASET="${ACTIVITYPODS_AUTH_DATASET:-settings}"

if ! [[ "${WAIT_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "WAIT_SECONDS must be a positive integer, got: ${WAIT_SECONDS}" >&2
  exit 1
fi

if ! [[ "${AUTH_DATASET}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ACTIVITYPODS_AUTH_DATASET contains invalid characters: ${AUTH_DATASET}" >&2
  exit 1
fi

probe_dataset() {
  local dataset="$1"
  local response

  response="$(curl -fsS --max-time 2 \
    -H 'Accept: application/sparql-results+json' \
    --data-urlencode 'query=ASK {}' \
    "${FUSEKI_URL%/}/${dataset}/query" 2>/dev/null)" || return 1

  grep -Eq '"boolean"[[:space:]]*:[[:space:]]*true' <<<"${response}"
}

ready=false
for attempt in $(seq 1 "${WAIT_SECONDS}"); do
  if probe_dataset "${AUTH_DATASET}"; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "${ready}" != true ]]; then
  echo "ActivityPods auth/control dataset did not become queryable within ${WAIT_SECONDS}s: ${AUTH_DATASET} (${FUSEKI_URL%/}/${AUTH_DATASET}/query)" >&2
  exit 1
fi

echo "ActivityPods storage bootstrap readiness verified via SPARQL: ${AUTH_DATASET}"
