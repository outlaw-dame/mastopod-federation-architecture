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

monitor_pid=''
backend_pid=''
cleanup() {
  if [[ -n "${monitor_pid}" ]]; then kill "${monitor_pid}" 2>/dev/null || true; fi
  if [[ -n "${backend_pid}" ]]; then kill "${backend_pid}" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

if [[ -n "${GITHUB_WORKSPACE:-}" && -n "${EVIDENCE_DIR:-}" ]]; then
  export AP_REAL_BULL_EVIDENCE_PATH="${GITHUB_WORKSPACE}/${EVIDENCE_DIR}/semapps-remote-post-${SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE:-unknown}.jsonl"
  node "${GITHUB_WORKSPACE}/fedify-sidecar/interop/ap/scripts/semapps-bull-remote-post-evidence.mjs" &
  monitor_pid=$!
fi

# Invoke the backend entrypoint directly instead of `yarn start`.  The workflow
# owns this wrapper PID and terminates it between native and external authority
# lanes.  If Yarn sits between the wrapper and Node, terminating the wrapper
# only kills Yarn and leaves its Node child listening on port 3000, preventing
# the external lane from starting.  Tracking the real backend process here
# makes the TERM trap authoritative and keeps the two federation modes isolated.
node scripts/run-moleculer-fabric.js &
backend_pid=$!
wait "${backend_pid}"
status=$?
backend_pid=''
exit "${status}"
