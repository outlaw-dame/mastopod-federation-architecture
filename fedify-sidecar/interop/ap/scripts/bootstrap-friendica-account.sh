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

# The image's FRIENDICA_LOG* environment values are install-time inputs and do
# not override the database-backed runtime settings. Persist the pinned
# Friendica logging keys so HTTP 500s / silently-discarded activities produce
# privacy-redactable evidence in real CI, since the empty-nickname fix above
# was confirmed necessary but not sufficient — a second, unidentified
# blocker remains, and local debugging (patching a running container's PHP
# source with error_log()/file_put_contents() traces) is the only technique
# that's reliably surfaced detail so far. This gives real CI the same
# visibility going forward instead of requiring another local repro.
ensure_config() {
  category="$1"
  key="$2"
  value="$3"
  current="$(compose exec -T friendica-app php bin/console.php config "${category}" "${key}")"
  if [ "${current}" != "${category}.${key} => ${value}" ]; then
    compose exec -T friendica-app php bin/console.php config "${category}" "${key}" "${value}"
  fi
}
ensure_config system logger_config stream
ensure_config system debugging 1
ensure_config system logfile /var/log/friendica/friendica.log
ensure_config system loglevel debug

# Root-caused for real (not the earlier empty-nickname bug, which is fixed
# and confirmed separately — see the block above): a brand-new inbound
# Follow ALWAYS creates its contact row with pending=1
# (Model/Contact::addRelationship() in Friendica's own source), and that
# only auto-flips to accepted + triggers an Accept back to the sender when
# the RECEIVING account's `page-flags` is Soapbox, Freelove, or Community —
# never for a plain/normal profile (PAGE_FLAGS_NORMAL, the default this
# account was created with). For a normal profile, every Follow instead
# creates a manual "intro" that a human has to approve in the web UI, which
# obviously never happens in CI. This isn't a bug in Friendica or in this
# repo's earlier fixes — the interop test account was simply never
# configured as a page type that accepts followers automatically. Confirmed
# directly from Friendica's own pinned source
# (Model/Contact.php's addRelationship(), Protocol/ActivityPub/Processor.php's
# followUser()), not guessed: `pending` is unconditionally 1 on insert, and
# the auto-accept branch is gated on
# `in_array($user['page-flags'], [PAGE_FLAGS_SOAPBOX, PAGE_FLAGS_FREELOVE, PAGE_FLAGS_COMMUNITY])`.
# PAGE_FLAGS_SOAPBOX (1) auto-accepts every follow — the DB update that
# path takes only flips pending to false, it does NOT touch `rel` (that
# only happens for FREELOVE), so the contact keeps its original insert-time
# rel=FOLLOWER(1). Confirmed this lands as rel=1,pending=0, which is exactly
# what this repo's own assertion query counts (`rel in (1,3) and pending=0`)
# — the right, verified choice for a broadcast-style federation test actor
# that only needs inbound follows to resolve, not to follow anyone back.
compose exec -T friendica-db /bin/sh -lc \
  "MYSQL_PWD=\"\$MARIADB_PASSWORD\" mariadb --batch --skip-column-names -u friendica friendica -e \"update user set \\\`page-flags\\\`=1 where nickname='${USERNAME}';\""

compose up -d friendica-worker
echo "Bootstrapped Friendica federation target ${USERNAME}"
