#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
OVERLAY="${AP_INTEROP_CASTOPOD_OVERLAY:-${SCRIPT_DIR}/../docker-compose.castopod.yml}"
HANDLE="${AP_INTEROP_CASTOPOD_HANDLE:-interop}"
: "${CASTOPOD_DB_PASSWORD:?CASTOPOD_DB_PASSWORD is required}"
: "${CASTOPOD_DB_ROOT_PASSWORD:?CASTOPOD_DB_ROOT_PASSWORD is required}"
: "${CASTOPOD_ANALYTICS_SALT:?CASTOPOD_ANALYTICS_SALT is required}"
: "${CASTOPOD_ADMIN_PASSWORD:?CASTOPOD_ADMIN_PASSWORD is required}"

printf '%s' "${HANDLE}" | LC_ALL=C grep -Eq '^[a-z0-9_]{1,32}$' || { echo "Invalid Castopod handle" >&2; exit 2; }
for value in "${CASTOPOD_DB_PASSWORD}" "${CASTOPOD_DB_ROOT_PASSWORD}" "${CASTOPOD_ANALYTICS_SALT}" "${CASTOPOD_ADMIN_PASSWORD}"; do
  [ "${#value}" -eq 64 ] && printf '%s' "${value}" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || {
    echo "Castopod bootstrap secrets must be 64 lowercase hex characters" >&2
    exit 2
  }
done

compose() { docker compose -f "${COMPOSE_FILE}" -f "${OVERLAY}" "$@"; }
compose up -d castopod-db castopod-redis castopod-app

ready=false
attempt=1
while [ "${attempt}" -le 60 ]; do
  # The image is considered started before its official entrypoint finishes
  # rendering .env one section at a time. A merely non-empty file can still be
  # a partial file, and invoking Spark in that window fails before CodeIgniter
  # defines its environment constants. `cache.redis.database` is the final
  # setting emitted for this fixture, so require that exact configured value.
  if compose exec -T castopod-app php -r '$env = @file_get_contents(".env"); exit(is_file("spark") && is_string($env) && preg_match("/^cache\\.redis\\.database=0$/m", $env) === 1 ? 0 : 1);'; then
    ready=true
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done
[ "${ready}" = true ] || {
  echo "Castopod entrypoint did not finish rendering its runtime environment" >&2
  compose logs --no-color castopod-app >&2
  exit 1
}

compose exec -T castopod-app php spark install:init-database
if ! compose exec -T castopod-db /bin/sh -lc \
  "MYSQL_PWD=\"\$MARIADB_PASSWORD\" mariadb --batch --skip-column-names -u castopod castopod -e \"select 1 from cp_users where username='interop-admin' limit 1;\"" | grep -qx 1; then
  printf '%s\n%s\n' "${CASTOPOD_ADMIN_PASSWORD}" "${CASTOPOD_ADMIN_PASSWORD}" | \
    compose exec -T castopod-app php spark install:create-superadmin -n interop-admin -e interop@castopod.org
fi
compose exec -T -e AP_INTEROP_CASTOPOD_HANDLE="${HANDLE}" castopod-app php spark interop:create-podcast

echo "Bootstrapped Castopod federation target ${HANDLE}"
