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

# Friendica's schema install creates the reserved uid=0 system-actor row with
# nickname='' (empty string, not NULL). User::getActorName() checks
# isset($systemuser['nickname']) to decide whether the system actor already
# has a name — but isset() treats an empty string as "set", so it returns ''
# immediately instead of falling through to its own sensible fallback list
# (friendica/actor/system/internal). User::createSystemAccount() then aborts
# on that empty name, so User::getSystemAccount() never creates Friendica's
# own relay/system contact — and HTTPSignature::fetchRaw() (used for every
# signed outbound dereference of a remote actor, including while processing
# an inbound Follow) throws "Could not find owner for uid 0" and is caught
# and swallowed several layers up. The result: Receiver::processInbox()
# logs "Unable to retrieve AP contact for actor - message is discarded" and
# silently drops the activity — even though it was successfully delivered
# (HTTP 202) and the remote actor is genuinely reachable end-to-end. This
# reproduces on every inbound activity, not just Follow, since it blocks
# any actor lookup Friendica itself has to make.
#
# Root-caused and verified live for real (not guessed): patched a running
# instance to trace the exact call chain (User::getActorName ->
# createSystemAccount -> getSystemAccount -> HTTPSignature::fetchRaw),
# confirmed the empty-string nickname on uid=0 via direct query, and
# confirmed that setting it unblocks processing past the exact point that
# was failing (the signed actor fetch that previously threw now succeeds).
#
# Give the reserved system row a real nickname before any inbound activity
# needs Friendica to dereference a remote actor.
compose exec -T friendica-db /bin/sh -lc \
  "MYSQL_PWD=\"\$MARIADB_PASSWORD\" mariadb --batch --skip-column-names -u friendica friendica -e \"update user set nickname='friendica' where uid=0 and nickname='';\""

# Disposable federation fixture only. Friendica 2026.05's stream
# logger refuses to start unless the logfile already exists and is writable
# by the Apache/worker www-data account. Keep private wire records out of CI.
compose exec -T -u root friendica-app /bin/sh -ec \
  'test -e /var/www/html/friendica.log || install -o www-data -g www-data -m 0600 /dev/null /var/www/html/friendica.log'
# Explicitly enable diagnostics *after* installation wrote persistent config.
# Logging never bypasses URL validation or HTTP-signature verification.
compose exec -T friendica-app php bin/console.php config system debugging 1 >/dev/null
compose exec -T friendica-app php bin/console.php config system logfile /var/www/html/friendica.log >/dev/null
compose exec -T friendica-app php bin/console.php config system loglevel debug >/dev/null
# The pinned Docker image starts its daemon as www-data but its fallback
# PID path is /var/run/friendica.pid. Use a container-local writable PID path
# for this disposable worker and verify daemon readiness before delivery.
# This setting is not applied to production Friendica instances.
compose exec -T friendica-app php bin/console.php config system pidfile /tmp/friendica-worker.pid >/dev/null

# Verify that the newly created local account is actually exposed as an
# ActivityPub actor, not merely a working HTML profile. Friendica can return
# HTTP 202 for inbound Follow even if its target actor is not resolvable.
# This check never prints actor JSON, keys or personal profile fields.
compose exec -T -e AP_INTEROP_LOCAL_ACTOR="https://friendica.test/profile/${USERNAME}" \
  -e AP_INTEROP_LOCAL_USERNAME="${USERNAME}" \
  friendica-app /bin/sh -ec '
    # The proxy aliases are not installed on this bootstrap container yet.
    # Test the local Apache origin, still requiring the canonical HTTPS actor
    # ID in JSON; later wire tests verify real TLS and signed delivery.
    curl --fail --silent --show-error \
      --connect-timeout 5 --max-time 20 \
      -H "Accept: application/activity+json" \
      "http://127.0.0.1/profile/$AP_INTEROP_LOCAL_USERNAME" |
    php -r '\''$body = stream_get_contents(STDIN);
      $actor = json_decode($body, true);
      $expected = getenv("AP_INTEROP_LOCAL_ACTOR");
      $type = is_array($actor) ? ($actor["type"] ?? null) : null;
      $inbox = is_array($actor) ? ($actor["inbox"] ?? null) : null;
      if (!is_array($actor) || ($actor["id"] ?? null) !== $expected ||
          !in_array($type, ["Person", "Service", "Organization", "Group", "Application"], true) ||
          !is_string($inbox) || $inbox === "") {
        fwrite(STDERR, "Friendica local ActivityPub actor validation failed\\n");
        exit(1);
      }
      echo "Friendica local ActivityPub actor validated\\n";'\''
  '

compose up -d friendica-worker
# Do not accept a started container as evidence of an active daemon.
# The bounded poll handles first boot and prevents a 3-minute false pass
# when the worker exits before processing its first incoming Follow.
worker_ready=false
attempt=1
while [ "${attempt}" -le 30 ]; do
  if compose exec -T friendica-worker php /var/www/html/bin/console.php daemon status 2>/dev/null \
    | grep -Eq '^Daemon process [0-9]+ is running \(/tmp/friendica-worker\.pid\)$'; then
    worker_ready=true
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done
if [ "${worker_ready}" != true ]; then
  echo "Friendica worker daemon was not ready (PID path /tmp/friendica-worker.pid)" >&2
  exit 1
fi
echo "Bootstrapped Friendica federation target ${USERNAME}"
