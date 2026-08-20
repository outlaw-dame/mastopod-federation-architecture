#!/usr/bin/env bash
set -euo pipefail

# The real federation proof intentionally reuses ActivityPods' non-secret
# .env.test fixture values for isolated infrastructure, but it must not run
# SemApps with NODE_ENV=test: SemApps 1.1.4 deliberately suppresses remote
# ActivityPub delivery in test mode for every non-localhost recipient.
#
# Preserve variables explicitly supplied by the workflow and fill only missing
# baseline values from .env.test, then select development runtime semantics so
# the production remotePost queue path is exercised against the real fixture.
fixture="${AP_REAL_ACTIVITYPODS_ENV_FIXTURE:-.env.test}"
if [[ ! -f "${fixture}" ]]; then
  echo "ActivityPods fixture env not found: ${fixture}" >&2
  exit 1
fi

while IFS= read -r line || [[ -n "${line}" ]]; do
  [[ -z "${line}" || "${line}" == \#* ]] && continue
  [[ "${line}" == *=* ]] || continue
  key="${line%%=*}"
  value="${line#*=}"
  if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Invalid environment key in ${fixture}: ${key}" >&2
    exit 1
  fi
  if [[ -z "${!key+x}" ]]; then
    export "${key}=${value}"
  fi
done < "${fixture}"

export NODE_ENV=development
exec yarn start
