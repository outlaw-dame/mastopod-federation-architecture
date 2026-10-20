#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
OVERLAY="${AP_INTEROP_OWNCAST_OVERLAY:-${SCRIPT_DIR}/../docker-compose.owncast.yml}"
USERNAME="${AP_INTEROP_OWNCAST_USERNAME:-interop}"
: "${OWNCAST_ADMIN_PASSWORD:?OWNCAST_ADMIN_PASSWORD is required}"
OWNCAST_RUNTIME_UID="${OWNCAST_RUNTIME_UID:-$(id -u)}"
OWNCAST_RUNTIME_GID="${OWNCAST_RUNTIME_GID:-$(id -g)}"
export OWNCAST_RUNTIME_UID OWNCAST_RUNTIME_GID

printf '%s' "${USERNAME}" | LC_ALL=C grep -Eq '^[a-z0-9_]{1,32}$' || { echo "Invalid Owncast federation username" >&2; exit 2; }
[ "${#OWNCAST_ADMIN_PASSWORD}" -eq 64 ] && printf '%s' "${OWNCAST_ADMIN_PASSWORD}" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || {
  echo "Owncast bootstrap password must be 64 lowercase hex characters" >&2
  exit 2
}
case "${OWNCAST_RUNTIME_UID}:${OWNCAST_RUNTIME_GID}" in
  *[!0-9:]*|:*|*::*|*:) echo "Owncast runtime UID and GID must be non-negative integers" >&2; exit 2 ;;
esac

compose() { docker compose -f "${COMPOSE_FILE}" -f "${OVERLAY}" "$@"; }
mkdir -p "${SCRIPT_DIR}/../runtime/owncast"
[ -w "${SCRIPT_DIR}/../runtime/owncast" ] || { echo "Owncast runtime directory is not writable by the fixture UID" >&2; exit 1; }
build_attempt=1
build_delay=5
while ! compose build owncast-app; do
  [ "${build_attempt}" -lt 3 ] || { echo "Owncast image build failed after ${build_attempt} attempts" >&2; exit 1; }
  sleep "${build_delay}"
  build_attempt=$((build_attempt + 1))
  build_delay=$((build_delay * 2))
done
compose up -d --no-build owncast-app

ready=false
attempt=1
while [ "${attempt}" -le 90 ]; do
  if compose exec -T owncast-app wget -q -O /dev/null http://127.0.0.1:8080/api/status; then ready=true; break; fi
  sleep 2
  attempt=$((attempt + 1))
done
[ "${ready}" = true ] || { echo "Owncast did not finish database migration and HTTP startup" >&2; compose ps owncast-app >&2; exit 1; }

authorization=$(printf 'admin:%s' "${OWNCAST_ADMIN_PASSWORD}" | base64 | tr -d '\n')
configure() {
  endpoint="$1"
  value="$2"
  if ! response=$(compose exec -T -e AP_INTEROP_AUTHORIZATION="${authorization}" owncast-app sh -c \
    'wget -q -O - --header="Authorization: Basic $AP_INTEROP_AUTHORIZATION" --header="Content-Type: application/json" --post-data="$2" "http://127.0.0.1:8080/api/admin/config/$1"' sh "${endpoint}" "${value}"); then
    echo "Owncast bootstrap request failed for ${endpoint}" >&2
    exit 1
  fi
  printf '%s' "${response}" | grep -Eq '"success"[[:space:]]*:[[:space:]]*true' || { echo "Owncast rejected bootstrap setting ${endpoint}" >&2; exit 1; }
}

configure serverurl '{"value":"https://owncast.test"}'
configure federation/username "{\"value\":\"${USERNAME}\"}"
configure federation/enable '{"value":true}'
configure federation/private '{"value":false}'
if ! compose exec -T owncast-app wget -q -O /dev/null --header="Accept: application/activity+json" \
  "http://127.0.0.1:8080/federation/user/${USERNAME}"; then
  echo "Owncast ActivityPub actor was not published at the exact configured username" >&2
  exit 1
fi

printf 'Bootstrapped Owncast federation target %s\n' "${USERNAME}"
