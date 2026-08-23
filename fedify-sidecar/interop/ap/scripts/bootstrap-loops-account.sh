#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_DIR="${SCRIPT_DIR}/../runtime"
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
OVERLAY="${AP_INTEROP_LOOPS_OVERLAY:-${SCRIPT_DIR}/../docker-compose.loops.yml}"
USERNAME="${AP_INTEROP_LOOPS_USERNAME:-interop}"
: "${LOOPS_DB_PASSWORD:?LOOPS_DB_PASSWORD is required}"
: "${LOOPS_DB_ROOT_PASSWORD:?LOOPS_DB_ROOT_PASSWORD is required}"
: "${LOOPS_REDIS_PASSWORD:?LOOPS_REDIS_PASSWORD is required}"
: "${LOOPS_APP_KEY:?LOOPS_APP_KEY is required}"
: "${LOOPS_ADMIN_PASSWORD:?LOOPS_ADMIN_PASSWORD is required}"

printf '%s' "${USERNAME}" | LC_ALL=C grep -Eq '^[a-zA-Z0-9_-]{3,50}$' || {
  echo "Invalid Loops username" >&2
  exit 2
}
for value in "${LOOPS_DB_PASSWORD}" "${LOOPS_DB_ROOT_PASSWORD}" "${LOOPS_REDIS_PASSWORD}" "${LOOPS_ADMIN_PASSWORD}"; do
  [ "${#value}" -eq 64 ] && printf '%s' "${value}" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || {
    echo "Loops bootstrap secrets must be 64 lowercase hex characters" >&2
    exit 2
  }
done
printf '%s' "${LOOPS_APP_KEY}" | LC_ALL=C grep -Eq '^base64:[A-Za-z0-9+/]{43}=$' || {
  echo "LOOPS_APP_KEY must be a Laravel base64 key" >&2
  exit 2
}

compose() { docker compose -f "${COMPOSE_FILE}" -f "${OVERLAY}" "$@"; }
compose up -d loops-db loops-redis loops-app

ready=false
attempt=1
while [ "${attempt}" -le 120 ]; do
  if compose exec -T loops-app curl -fsS http://127.0.0.1:8080/ >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done
[ "${ready}" = true ] || {
  echo "Loops did not finish database migration and HTTP startup" >&2
  compose logs --no-color loops-app >&2
  exit 1
}

compose exec -T loops-app php artisan db:seed --class=AdminSettingsSeeder --force
compose exec -T loops-app php artisan passport:keys --force
compose exec -T loops-app php artisan app:ensure-boottime

if ! compose exec -T loops-db /bin/sh -lc \
  "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql --batch --skip-column-names -u loops loops -e \"select 1 from users where username='${USERNAME}' limit 1;\"" | grep -qx 1; then
  compose exec -T loops-app php artisan create-admin-account \
    --name="Interop User" --username="${USERNAME}" --email="interop@loops.invalid" \
    --password="${LOOPS_ADMIN_PASSWORD}" --force
fi

compose exec -T loops-app php artisan tinker --execute=\
'$setting = App\Models\AdminSetting::where("key", "federation.enableFederation")->firstOrFail(); $setting->value = true; $setting->save(); app(App\Services\ConfigService::class)->federation(true);'

profile_id=$(compose exec -T loops-db /bin/sh -lc \
  "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql --batch --skip-column-names -u loops loops -e \"select p.id from profiles p join users u on u.id=p.user_id where u.username='${USERNAME}' and p.local=1;\"" | tr -d '[:space:]')
case "${profile_id}" in
  ''|*[!0-9]*) echo "Loops local ActivityPub profile was not provisioned exactly once" >&2; exit 1 ;;
esac

compose up -d loops-horizon
mkdir -p "${RUNTIME_DIR}"
umask 077
printf 'TARGET_ACTOR_URI=https://loops.test/ap/users/%s\n' "${profile_id}" > "${RUNTIME_DIR}/loops-actor.env"
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'TARGET_ACTOR_URI=https://loops.test/ap/users/%s\n' "${profile_id}" >> "${GITHUB_ENV}"
fi
echo "Bootstrapped Loops federation target ${USERNAME} with profile ${profile_id}"
