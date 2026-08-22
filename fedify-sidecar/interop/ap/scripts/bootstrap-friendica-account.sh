#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
OVERLAY="${AP_INTEROP_FRIENDICA_OVERLAY:-${SCRIPT_DIR}/../docker-compose.friendica.yml}"
USERNAME="${AP_INTEROP_FRIENDICA_USERNAME:-interop}"
: "${FRIENDICA_DB_PASSWORD:?FRIENDICA_DB_PASSWORD is required}"
: "${FRIENDICA_DB_ROOT_PASSWORD:?FRIENDICA_DB_ROOT_PASSWORD is required}"

printf '%s' "${USERNAME}" | LC_ALL=C grep -Eq '^[a-z0-9_]{1,32}$' || { echo "Invalid Friendica username" >&2; exit 2; }
for value in "${FRIENDICA_DB_PASSWORD}" "${FRIENDICA_DB_ROOT_PASSWORD}"; do
  [ "${#value}" -eq 64 ] && printf '%s' "${value}" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || {
    echo "Friendica database credentials must be 64 lowercase hex characters" >&2
    exit 2
  }
done

compose() { docker compose -f "${COMPOSE_FILE}" -f "${OVERLAY}" "$@"; }
compose up -d friendica-db friendica-app

installed=false
attempt=1
while [ "${attempt}" -le 90 ]; do
  if compose exec -T friendica-db /bin/sh -lc \
    "MYSQL_PWD=\"\$MARIADB_PASSWORD\" mariadb --batch --skip-column-names -u friendica friendica -e \"select count(*) from user;\"" >/dev/null 2>&1; then
    installed=true
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done
[ "${installed}" = true ] || { compose logs --no-color friendica-app >&2; exit 1; }

if ! compose exec -T friendica-db /bin/sh -lc \
  "MYSQL_PWD=\"\$MARIADB_PASSWORD\" mariadb --batch --skip-column-names -u friendica friendica -e \"select 1 from user where nickname='${USERNAME}' limit 1;\"" | grep -qx 1; then
  # Supplying a newline answers only the documented optional avatar prompt.
  printf '\n' | compose exec -T friendica-app php bin/console.php user add \
    "Interop Federation" "${USERNAME}" "interop@friendi.ca" en
fi

compose up -d friendica-worker
echo "Bootstrapped Friendica federation target ${USERNAME}"
