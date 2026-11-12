#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
OVERLAY="${AP_INTEROP_PEERTUBE_OVERLAY:-${SCRIPT_DIR}/../docker-compose.peertube.yml}"
: "${PEERTUBE_DB_PASSWORD:?PEERTUBE_DB_PASSWORD is required}"
: "${PEERTUBE_SECRET:?PEERTUBE_SECRET is required}"

for value in "${PEERTUBE_DB_PASSWORD}" "${PEERTUBE_SECRET}"; do
  [ "${#value}" -eq 64 ] && printf '%s' "${value}" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || {
    echo "PeerTube bootstrap secrets must be 64 lowercase hex characters" >&2
    exit 2
  }
done

compose() { docker compose -f "${COMPOSE_FILE}" -f "${OVERLAY}" "$@"; }
compose up -d peertube-db peertube-redis peertube-app

ready=false
attempt=1
while [ "${attempt}" -le 90 ]; do
  if compose exec -T peertube-app curl -fsS http://127.0.0.1:9000/api/v1/config >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done
[ "${ready}" = true ] || {
  echo "PeerTube did not finish database migration and HTTP startup" >&2
  # Startup logs may include request or configuration context. Keep failure
  # evidence bounded to container state unless explicitly inspected locally.
  compose ps peertube-app peertube-db peertube-redis >&2
  exit 1
}

count=$(compose exec -T peertube-db /bin/sh -lc \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tAc "select count(*) from actor where \"preferredUsername\"='"'"'root'"'"' and \"serverId\" is null and \"accountId\" is not null;"' | tr -d '[:space:]')
[ "${count}" = 1 ] || {
  echo "PeerTube root ActivityPub actor was not provisioned exactly once" >&2
  exit 1
}

echo "Bootstrapped PeerTube federation target root"
