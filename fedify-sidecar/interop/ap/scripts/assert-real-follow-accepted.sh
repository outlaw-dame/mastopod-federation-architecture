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

fail() {
  echo "$*" >&2
  exit 2
}

canonicalize_compose_path() {
  path="$1"
  case "${path}" in
    /*) printf '%s\n' "${path}" ;;
    *)
      if [ -n "${GITHUB_WORKSPACE:-}" ] && [ -f "${GITHUB_WORKSPACE}/${path}" ]; then
        printf '%s\n' "${GITHUB_WORKSPACE}/${path}"
      elif [ -f "${path}" ]; then
        path_dir=$(CDPATH= cd -- "$(dirname -- "${path}")" && pwd)
        printf '%s/%s\n' "${path_dir}" "$(basename -- "${path}")"
      else
        printf '%s\n' "${path}"
      fi
      ;;
  esac
}

COMPOSE_FILE=$(canonicalize_compose_path "${COMPOSE_FILE}")
if [ -n "${COMPOSE_OVERLAY}" ]; then
  COMPOSE_OVERLAY=$(canonicalize_compose_path "${COMPOSE_OVERLAY}")
fi

[ -f "${COMPOSE_FILE}" ] || fail "ActivityPub interop compose file does not exist: ${COMPOSE_FILE}"
if [ -n "${COMPOSE_OVERLAY}" ]; then
  [ -f "${COMPOSE_OVERLAY}" ] || fail "ActivityPub interop compose overlay does not exist: ${COMPOSE_OVERLAY}"
fi

if [ -z "${TARGET}" ] || [ -z "${ACTOR_URI}" ]; then
  echo "usage: assert-real-follow-accepted.sh <mastodon|gotosocial|akkoma|pixelfed|bonfire> <actor-uri> [local-username]" >&2
  exit 2
fi

case "${TARGET}" in
  mastodon|gotosocial|akkoma|pixelfed|bonfire) ;;
  *) fail "unsupported target '${TARGET}'" ;;
esac
case "${EXPECTED_COUNT}:${ATTEMPTS}:${DELAY_SECONDS}" in
  *[!0-9:]*|:*|*::*|*:) fail "follow assertion counts, attempts, and delay must be non-negative integers" ;;
esac
[ "${EXPECTED_COUNT}" -ge 1 ] || fail "AP_INTEROP_EXPECTED_FOLLOW_COUNT must be at least 1"
[ "${ATTEMPTS}" -ge 1 ] && [ "${ATTEMPTS}" -le 300 ] || fail "AP_INTEROP_FOLLOW_ASSERT_ATTEMPTS must be between 1 and 300"
[ "${DELAY_SECONDS}" -le 30 ] || fail "AP_INTEROP_FOLLOW_ASSERT_DELAY_SECONDS must be at most 30"
printf '%s\n' "${LOCAL_USERNAME}" | LC_ALL=C grep -Eq '^[A-Za-z0-9_.-]{1,64}$' || fail "local username contains unsupported characters"
node -e '
  const value = process.argv[1];
  let parsed;
  try { parsed = new URL(value); } catch { process.exit(1); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.href !== value) process.exit(1);
' "${ACTOR_URI}" || fail "actor URI must be a canonical credential-free HTTPS URL"

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
        "PGPASSWORD=postgres psql -U postgres -d mastodon_production -v ON_ERROR_STOP=1 -tAc \"select count(*) from follows f join accounts follower on follower.id=f.account_id join accounts target on target.id=f.target_account_id where follower.uri='${actor_sql}' and target.username='${username_sql}' and target.domain is null;\""
      ;;
    gotosocial)
      db_file="${SCRIPT_DIR}/../runtime/gotosocial/sqlite.db"
      if [ ! -f "${db_file}" ]; then
        echo "GoToSocial persistence database is missing: ${db_file}" >&2
        return 1
      fi
      sqlite3 "${db_file}" \
        "PRAGMA busy_timeout=30000; select count(*) from follows f join accounts follower on follower.id=f.account_id join accounts target on target.id=f.target_account_id where follower.uri='${actor_sql}' and target.username='${username_sql}' and target.domain is null;"
      ;;
    akkoma)
      compose --profile akkoma exec -T akkoma-db /bin/sh -lc \
        "PGPASSWORD=postgres psql -U postgres -d akkoma -v ON_ERROR_STOP=1 -tAc \"select count(*) from following_relationships fr join users follower on follower.id=fr.follower_id join users target on target.id=fr.following_id where follower.ap_id='${actor_sql}' and target.nickname='${username_sql}' and fr.state=2;\""
      ;;
    pixelfed)
      compose exec -T pixelfed-db /bin/sh -lc \
        "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql --batch --skip-column-names -u pixelfed pixelfed -e \"select count(*) from followers f join profiles follower on follower.id=f.profile_id join profiles target on target.id=f.following_id where follower.remote_url='${actor_sql}' and target.username='${username_sql}' and target.domain is null;\""
      ;;
    bonfire)
      output=$(compose exec -T -e AP_INTEROP_ACTOR_URI="${ACTOR_URI}" -e AP_INTEROP_TARGET_USERNAME="${LOCAL_USERNAME}" \
        bonfire-app bin/bonfire rpc \
        'with {:ok, follower} <- Bonfire.Federate.ActivityPub.AdapterUtils.get_or_fetch_character_by_ap_id(System.fetch_env!("AP_INTEROP_ACTOR_URI")), {:ok, target} <- Bonfire.Me.Users.by_username(System.fetch_env!("AP_INTEROP_TARGET_USERNAME")) do IO.puts(if Bonfire.Social.Graph.Follows.following?(follower, target), do: "1", else: "0") else _ -> IO.puts("0") end')
      value=$(printf '%s\n' "${output}" | awk '/^[01]$/{value=$0} END{print value}')
      [ -n "${value}" ] || return 1
      printf '%s\n' "${value}"
      ;;
  esac
}

pixelfed_diagnostics() {
  echo "Pixelfed fail-closed persistence diagnostics:" >&2
  compose exec -T pixelfed-db /bin/sh -lc \
    "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql --batch --skip-column-names -u pixelfed pixelfed -e \"
      select concat('remote_profile_count=', count(*), ',key_id_matches=', coalesce(sum(key_id=concat(remote_url, '/keys/main')),0), ',public_key_count=', coalesce(sum(public_key is not null),0)) from profiles where remote_url='${actor_sql}';
      select concat('local_target_count=', count(*), ',private_count=', coalesce(sum(is_private=1),0)) from profiles where username='${username_sql}' and domain is null;
      select concat('follow_request_count=', count(*)) from follow_requests fr join profiles follower on follower.id=fr.follower_id join profiles target on target.id=fr.following_id where follower.remote_url='${actor_sql}' and target.username='${username_sql}' and target.domain is null;
      select concat('failed_job_count=', count(*)) from failed_jobs;\"" >&2 || echo "Pixelfed database diagnostics unavailable" >&2
  for queue in follow shared; do
    ready=$(compose exec -T pixelfed-redis redis-cli --raw LLEN "queues:${queue}" 2>/dev/null || printf 'unknown')
    reserved=$(compose exec -T pixelfed-redis redis-cli --raw ZCARD "queues:${queue}:reserved" 2>/dev/null || printf 'unknown')
    delayed=$(compose exec -T pixelfed-redis redis-cli --raw ZCARD "queues:${queue}:delayed" 2>/dev/null || printf 'unknown')
    printf 'queue=%s ready=%s reserved=%s delayed=%s\n' "${queue}" "${ready}" "${reserved}" "${delayed}" >&2
  done
  compose exec -T pixelfed-horizon php artisan horizon:status >&2 || echo "Pixelfed Horizon status unavailable" >&2
}

query_error_file=$(mktemp "${TMPDIR:-/tmp}/ap-follow-query.XXXXXX")
trap 'rm -f "${query_error_file}"' EXIT HUP INT TERM
query_failures=0
count=""
attempt=1
while [ "${attempt}" -le "${ATTEMPTS}" ]; do
  if raw_count=$(query_count 2>"${query_error_file}"); then
    count=$(printf '%s\n' "${raw_count}" | awk 'NF { value=$0 } END { gsub(/[[:space:]]/, "", value); print value }')
    case "${count}" in
      ''|*[!0-9]*)
        printf 'persistence query returned a non-numeric result on attempt %s\n' "${attempt}" >"${query_error_file}"
        query_failures=$((query_failures + 1))
        count=""
        ;;
    esac
  else
    query_failures=$((query_failures + 1))
    count=""
  fi
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

if [ "${query_failures}" -eq "${ATTEMPTS}" ]; then
  echo "${TARGET} persistence verification failed on every attempt; the remote state is unknown" >&2
  sed -n '1,20p' "${query_error_file}" >&2
  exit 1
fi
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
    pixelfed_diagnostics
    compose logs --no-color pixelfed-app pixelfed-horizon >&2 || true
    ;;
  bonfire)
    compose logs --no-color bonfire-app >&2 || true
    ;;
esac
exit 1
