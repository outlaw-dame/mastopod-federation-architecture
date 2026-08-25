#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.yml}"
OVERLAY="${AP_INTEROP_LOOPS_OVERLAY:-${SCRIPT_DIR}/../docker-compose.loops.yml}"
AUTHORITY="${1:-}"

if [[ ! "${AUTHORITY}" =~ ^[a-z0-9-]+\.trycloudflare\.com$ ]]; then
  echo "Loops proof authority must be an exact credentialless Quick Tunnel hostname" >&2
  exit 2
fi

compose() {
  LOOPS_LOCAL_DOMAINS="${AUTHORITY}" docker compose -f "${COMPOSE_FILE}" -f "${OVERLAY}" "$@"
}

# Loops intentionally exempts only configured same-server domains from its DNS
# SSRF rejection. Recreate the application before its worker so both processes
# receive the one exact path-restricted proof authority and refreshed config cache.
compose up -d --no-deps --force-recreate loops-app
app_ready=false
for attempt in $(seq 1 60); do
  if compose exec -T loops-app curl -fsS --max-time 3 http://127.0.0.1:8080/ >/dev/null 2>&1; then
    app_ready=true
    break
  fi
  sleep 2
done
if [[ "${app_ready}" != true ]]; then
  echo "Loops application did not recover after proof-authority reconfiguration" >&2
  compose logs --no-color --tail 200 loops-app >&2 || true
  exit 1
fi

compose exec -T -e AP_INTEROP_EXPECTED_AUTHORITY="${AUTHORITY}" loops-app \
  php artisan tinker --execute=\
'$expected = getenv("AP_INTEROP_EXPECTED_AUTHORITY"); if (config("loops.local_domains") !== $expected) { throw new RuntimeException("Loops proof authority configuration mismatch"); }'

compose up -d --no-deps --force-recreate loops-horizon
worker_ready=false
for attempt in $(seq 1 60); do
  if compose exec -T loops-horizon php artisan horizon:status >/dev/null 2>&1; then
    worker_ready=true
    break
  fi
  sleep 2
done
if [[ "${worker_ready}" != true ]]; then
  echo "Loops Horizon did not recover after proof-authority reconfiguration" >&2
  compose logs --no-color --tail 200 loops-horizon >&2 || true
  exit 1
fi

printf '{"schema":"activitypods.activitypub.loops-proof-authority.v1","authority":"%s","scope":"exact-path-restricted-quick-tunnel"}\n' \
  "${AUTHORITY}"
