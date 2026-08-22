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
# Probe the actual authenticated SPARQL query endpoint rather than Fuseki
# administrative endpoints. The pinned ActivityPods fixture protects Fuseki
# with the same credentials its bootstrap script uses, so an anonymous probe
# would test authorization failure rather than dataset queryability.

FUSEKI_URL="${FUSEKI_URL:-http://localhost:3030}"
FUSEKI_USER="${FUSEKI_USER:-admin}"
FUSEKI_PASSWORD="${FUSEKI_PASSWORD:-admin}"
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
  curl --fail --silent --show-error --max-time 2 \
    -u "${FUSEKI_USER}:${FUSEKI_PASSWORD}" \
    "${FUSEKI_URL%/}/${dataset}/query?query=ASK%20%7B%7D" \
    >/dev/null 2>&1
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

echo "ActivityPods storage bootstrap readiness verified via authenticated SPARQL ASK: ${AUTH_DATASET}"
