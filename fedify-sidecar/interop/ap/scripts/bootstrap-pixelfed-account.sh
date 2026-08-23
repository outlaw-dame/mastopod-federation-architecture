#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
PIXELFED_OVERLAY="${AP_INTEROP_PIXELFED_OVERLAY:-${SCRIPT_DIR}/../docker-compose.pixelfed.yml}"
USERNAME="${AP_INTEROP_PIXELFED_USERNAME:-interop}"

compose() {
  docker compose -f "${COMPOSE_FILE}" -f "${PIXELFED_OVERLAY}" "$@"
}

compose up -d pixelfed-db pixelfed-redis pixelfed-app pixelfed-horizon

ready=false
for attempt in $(seq 1 120); do
  if compose exec -T pixelfed-app php artisan about --only=environment >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [ "${ready}" != true ]; then
  compose logs --no-color pixelfed-app pixelfed-horizon >&2 || true
  exit 1
fi

exists=$(compose exec -T pixelfed-db /bin/sh -lc \
  "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql -N -u pixelfed pixelfed -e \"select count(*) from users where username='${USERNAME}';\"" \
  | tr -d '[:space:]')
if [ "${exists}" != "1" ]; then
  compose exec -T pixelfed-app php artisan user:create \
    --name=Interop --username="${USERNAME}" --email="${USERNAME}@pixelfed.test" \
    --password='Interop-Proof-Only-2026' --confirm_email=1
fi

compose exec -T pixelfed-app php artisan instance:actor >/dev/null
compose exec -T pixelfed-app php artisan config:clear >/dev/null
