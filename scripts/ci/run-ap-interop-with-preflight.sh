#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

compose_file="fedify-sidecar/interop/ap/docker-compose.ap-interop.yml"

if [[ ! -f "${compose_file}" ]]; then
  echo "Missing AP interop compose file: ${compose_file}" >&2
  exit 1
fi

wait_for_http() {
  local name="$1"
  local url="$2"
  local attempts=60

  for ((i=1; i<=attempts; i++)); do
    if curl --fail --silent --show-error "${url}" >/dev/null; then
      echo "${name} is ready"
      return 0
    fi
    sleep 2
  done

  echo "${name} did not become ready: ${url}" >&2
  return 1
}

wait_for_http "Fuseki" "http://localhost:3030/$/ping"

for dataset in api users; do
  if ! curl --fail --silent --show-error "http://localhost:3030/${dataset}/query?query=ASK%20%7B%7D" >/dev/null; then
    echo "Required Fuseki dataset unavailable: ${dataset}" >&2
    echo "Available federation infrastructure is incomplete; refusing ambiguous interop failures." >&2
    exit 1
  fi
done

exec npm --prefix fedify-sidecar run smoke:interop:ap "$@"
