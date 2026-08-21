#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
COMPOSE_OVERLAY="${AP_INTEROP_COMPOSE_OVERLAY:-}"
TARGET="${1:-}"
ACTOR_URI="${2:-}"
LOCAL_USERNAME="${3:-interop}"
EXPECTED_COUNT="${AP_INTEROP_EXPECTED_FOLLOW_COUNT:-1}"
ATTEMPTS="${AP_INTEROP_FOLLOW_ASSERT_ATTEMPTS:-60}"
DELAY_SECONDS="${AP_INTEROP_FOLLOW_ASSERT_DELAY_SECONDS:-2}"

if [ -z "${TARGET}" ] || [ -z "${ACTOR_URI}" ]; then
  echo "usage: assert-real-follow-accepted.sh <mastodon|gotosocial|akkoma|pixelfed|bonfire> <actor-uri> [local-username]" >&2
  exit 2
fi

compose() {
  if [ -n "${COMPOSE_OVERLAY}" ]; then
    docker compose -f "${COMPOSE_FILE}" -f "${COMPOSE_OVERLAY}" "$@"
  else
    docker compose -f "${COMPOSE_FILE}" "$@"
  fi
}

sql_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

actor_sql=$(sql_quote "${ACTOR_URI}")
username_sql=$(sql_quote "${LOCAL_USERNAME}")

query_count() {
  case "${TARGET}" in
    mastodon)
      compose exec -T mastodon-db /bin/sh -lc \
        "PGPASSWORD=postgres psql -U postgres -d mastodon_production -tAc \"select count(*) from follows f join accounts follower on follower.id=f.account_id join accounts target on target.id=f.target_account_id where follower.uri='${actor_sql}' and target.username='${username_sql}' and target.domain is null;\"" \
        | tr -d '[:space:]'
      ;;
    gotosocial)
      db_file="${SCRIPT_DIR}/../runtime/gotosocial/sqlite.db"
      if [ ! -f "${db_file}" ]; then
        printf '0'
        return
      fi
      sqlite3 "${db_file}" \
        "PRAGMA busy_timeout=30000; select count(*) from follows f join accounts follower on follower.id=f.account_id join accounts target on target.id=f.target_account_id where follower.uri='${actor_sql}' and target.username='${username_sql}' and target.domain is null;" \
        | tail -n 1 | tr -d '[:space:]'
      ;;
    akkoma)
      compose --profile akkoma exec -T akkoma-db /bin/sh -lc \
        "PGPASSWORD=postgres psql -U postgres -d akkoma -tAc \"select count(*) from following_relationships fr join users follower on follower.id=fr.follower_id join users target on target.id=fr.following_id where follower.ap_id='${actor_sql}' and target.nickname='${username_sql}' and fr.state=2;\"" \
        | tr -d '[:space:]'
      ;;
    pixelfed)
      compose exec -T pixelfed-db /bin/sh -lc \
        "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql -N -u pixelfed pixelfed -e \"select count(*) from followers f join profiles follower on follower.id=f.profile_id join profiles target on target.id=f.following_id where follower.remote_url='${actor_sql}' and target.username='${username_sql}' and target.domain is null;\"" \
        | tr -d '[:space:]'
      ;;
    bonfire)
      output=$(compose exec -T -e AP_INTEROP_ACTOR_URI="${ACTOR_URI}" -e AP_INTEROP_TARGET_USERNAME="${LOCAL_USERNAME}" \
        bonfire-app bin/bonfire rpc \
        'with {:ok, follower} <- Bonfire.Federate.ActivityPub.AdapterUtils.get_or_fetch_character_by_ap_id(System.fetch_env!("AP_INTEROP_ACTOR_URI")), {:ok, target} <- Bonfire.Me.Users.by_username(System.fetch_env!("AP_INTEROP_TARGET_USERNAME")) do IO.puts(if Bonfire.Social.Graph.Follows.following?(follower, target), do: "1", else: "0") else _ -> IO.puts("0") end' \
        2>/dev/null || true)
      printf '%s\n' "${output}" | awk '/^[01]$/{value=$0} END{if(value=="") value="0"; print value}'
      ;;
    *)
      echo "unsupported target '${TARGET}'" >&2
      exit 2
      ;;
  esac
}

attempt=1
while [ "${attempt}" -le "${ATTEMPTS}" ]; do
  count=$(query_count 2>/dev/null || printf '0')
  if [ "${count}" = "${EXPECTED_COUNT}" ]; then
    printf '{"ok":true,"target":"%s","actorUri":"%s","localUsername":"%s","persistedFollowCount":%s}\n' \
      "${TARGET}" "${ACTOR_URI}" "${LOCAL_USERNAME}" "${count}"
    exit 0
  fi
  if [ "${attempt}" -lt "${ATTEMPTS}" ]; then
    sleep "${DELAY_SECONDS}"
  fi
  attempt=$((attempt + 1))
done

echo "${TARGET} did not persist the expected Follow from ${ACTOR_URI}; observed count=${count:-0}" >&2
case "${TARGET}" in
  mastodon)
    compose logs --no-color mastodon-web-app mastodon-sidekiq >&2 || true
    ;;
  gotosocial)
    compose logs --no-color gotosocial-app >&2 || true
    ;;
  akkoma)
    compose --profile akkoma logs --no-color akkoma-app >&2 || true
    ;;
  pixelfed)
    compose logs --no-color pixelfed-app pixelfed-horizon >&2 || true
    ;;
  bonfire)
    compose logs --no-color bonfire-app >&2 || true
    ;;
esac
exit 1
