#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
OVERLAY="${AP_INTEROP_MISSKEY_OVERLAY:-${SCRIPT_DIR}/../docker-compose.misskey.yml}"
USERNAME="${AP_INTEROP_MISSKEY_USERNAME:-interop}"
: "${MISSKEY_SETUP_PASSWORD:?MISSKEY_SETUP_PASSWORD is required}"
: "${MISSKEY_USER_PASSWORD:?MISSKEY_USER_PASSWORD is required}"

printf '%s' "${USERNAME}" | LC_ALL=C grep -Eq '^[a-z0-9_]{1,20}$' || { echo "Invalid Misskey username" >&2; exit 2; }
for value in "${MISSKEY_SETUP_PASSWORD}" "${MISSKEY_USER_PASSWORD}"; do
  [ "${#value}" -eq 64 ] && printf '%s' "${value}" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || {
    echo "Misskey bootstrap secrets must be 64 lowercase hex characters" >&2
    exit 2
  }
done

compose() { docker compose -f "${COMPOSE_FILE}" -f "${OVERLAY}" "$@"; }
compose up -d misskey-db misskey-redis misskey-app

wait_for_meta() {
  ready=false
  attempt=1
  while [ "${attempt}" -le 90 ]; do
    if compose exec -T misskey-app node -e "fetch('http://127.0.0.1:3000/api/meta',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      ready=true
      break
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  [ "${ready}" = true ] || { compose logs --no-color misskey-app >&2; exit 1; }
}

wait_for_meta

# Keep both directional credentials out of argv, output, and persisted evidence.
compose exec -T \
  -e AP_INTEROP_USERNAME="${USERNAME}" \
  -e AP_INTEROP_SETUP_PASSWORD="${MISSKEY_SETUP_PASSWORD}" \
  -e AP_INTEROP_USER_PASSWORD="${MISSKEY_USER_PASSWORD}" \
  misskey-app node -e '
    const body = JSON.stringify({
      username: process.env.AP_INTEROP_USERNAME,
      password: process.env.AP_INTEROP_USER_PASSWORD,
      setupPassword: process.env.AP_INTEROP_SETUP_PASSWORD,
    });
    fetch("http://127.0.0.1:3000/api/admin/accounts/create", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }).then(async response => {
      const value = await response.json().catch(() => null);
      if (!response.ok || value?.username !== process.env.AP_INTEROP_USERNAME || typeof value?.id !== "string") process.exit(1);
    }).catch(() => process.exit(1));
  '

actor_id=$(compose exec -T misskey-db /bin/sh -lc \
  "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U misskey -d misskey -v ON_ERROR_STOP=1 -tAc \"select id from \\\"user\\\" where username='${USERNAME}' and host is null;\"")
actor_id=$(printf '%s' "${actor_id}" | tr -d '[:space:]')
printf '%s' "${actor_id}" | LC_ALL=C grep -Eq '^[0-9a-z]{16,32}$' || { echo "Misskey actor ID was not created" >&2; exit 1; }

# Misskey 2026.7.0 deliberately defaults meta.federation to 'none'. Its
# WellKnownServerService returns HTTP 403 for WebFinger/NodeInfo while that
# value is 'none', and ActivityPub federation is therefore disabled even
# though the local account has been created successfully. This fixture exists
# specifically to prove real federation, so enable the stock server's normal
# 'all' federation mode after bootstrap, verify the authoritative DB value,
# then restart the app so the injected MiMeta snapshot is reloaded before the
# external readiness/federation proof begins.
federation_mode=$(compose exec -T misskey-db /bin/sh -lc \
  "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U misskey -d misskey -v ON_ERROR_STOP=1 -tAc \"update meta set federation='all' where federation='none'; select federation from meta;\"")
federation_mode=$(printf '%s' "${federation_mode}" | tr -d '[:space:]')
[ "${federation_mode}" = all ] || { echo "Misskey federation mode was not enabled" >&2; exit 1; }
compose restart misskey-app >/dev/null
wait_for_meta

printf 'TARGET_ACTOR_URI=https://misskey.test/users/%s\n' "${actor_id}" >"${SCRIPT_DIR}/../runtime/misskey-actor.env"
echo "Bootstrapped Misskey federation target ${USERNAME}"
