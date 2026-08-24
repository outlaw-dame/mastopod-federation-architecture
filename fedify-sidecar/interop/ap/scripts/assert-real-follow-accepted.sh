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
  echo "usage: assert-real-follow-accepted.sh <mastodon|gotosocial|akkoma|pixelfed|bonfire|misskey|friendica|castopod|peertube|loops> <actor-uri> [local-username]" >&2
  exit 2
fi

case "${TARGET}" in
  mastodon|gotosocial|akkoma|pixelfed|bonfire|misskey|friendica|castopod|peertube|loops) ;;
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
    misskey)
      compose exec -T misskey-db /bin/sh -lc \
        "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U misskey -d misskey -v ON_ERROR_STOP=1 -tAc \"select count(*) from \\\"following\\\" f join \\\"user\\\" follower on follower.id=f.\\\"followerId\\\" join \\\"user\\\" target on target.id=f.\\\"followeeId\\\" where follower.uri='${actor_sql}' and target.username='${username_sql}' and target.host is null;\""
      ;;
    friendica)
      compose exec -T friendica-db /bin/sh -lc \
        "MYSQL_PWD=\"\$MARIADB_PASSWORD\" mariadb --batch --skip-column-names -u friendica friendica -e \"select count(*) from contact c join user u on u.uid=c.uid where c.url='${actor_sql}' and u.nickname='${username_sql}' and c.rel in (1,3) and c.pending=0 and c.deleted=0;\""
      ;;
    castopod)
      compose exec -T castopod-db /bin/sh -lc \
        "MYSQL_PWD=\"\$MARIADB_PASSWORD\" mariadb --batch --skip-column-names -u castopod castopod -e \"select count(*) from cp_fediverse_follows f join cp_fediverse_actors follower on follower.id=f.actor_id join cp_fediverse_actors target on target.id=f.target_actor_id where follower.uri='${actor_sql}' and target.username='${username_sql}' and target.domain='castopod.test';\""
      ;;
    peertube)
      compose exec -T peertube-db /bin/sh -lc \
        "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -tAc \"select count(*) from \\\"actorFollow\\\" f join actor follower on follower.id=f.\\\"actorId\\\" join actor target on target.id=f.\\\"targetActorId\\\" where follower.url='${actor_sql}' and target.\\\"preferredUsername\\\"='${username_sql}' and target.\\\"serverId\\\" is null and target.\\\"accountId\\\" is not null and f.state='accepted';\""
      ;;
    loops)
      compose exec -T loops-db /bin/sh -lc \
        "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql --batch --skip-column-names -u loops loops -e \"select count(*) from followers f join profiles follower on follower.id=f.profile_id join profiles target on target.id=f.following_id where follower.uri='${actor_sql}' and target.username='${username_sql}' and follower.local=0 and target.local=1;\""
      ;;
  esac
}

pixelfed_diagnostics() {
  echo "Pixelfed fail-closed persistence diagnostics:" >&2
  compose exec -T pixelfed-db /bin/sh -lc \
    "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql --batch --skip-column-names -u pixelfed pixelfed -e \"
      select concat('remote_profile_count=', count(*), ',key_id_matches=', coalesce(sum(key_id=concat(remote_url, '#main-key')),0), ',public_key_count=', coalesce(sum(public_key is not null),0)) from profiles where remote_url='${actor_sql}';
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
  compose exec -T -e AP_INTEROP_ACTOR_URI="${ACTOR_URI}" pixelfed-app /bin/sh -lc \
    'curl --connect-timeout 5 --max-time 30 -sS -D - -H "Accept: application/activity+json" "$AP_INTEROP_ACTOR_URI"' \
    >&2 || echo "Pixelfed in-container actor fetch unavailable" >&2
  compose exec -T -e AP_INTEROP_ACTOR_URI="${ACTOR_URI}" pixelfed-app php artisan tinker --execute=\
'$response = App\Services\ActivityPubFetchService::fetchRequest(getenv("AP_INTEROP_ACTOR_URI")); dump(["type" => gettype($response), "bytes" => is_string($response) ? strlen($response) : 0]);' \
    >&2 || echo "Pixelfed application actor-fetch diagnostic unavailable" >&2
  compose exec -T -e AP_INTEROP_ACTOR_URI="${ACTOR_URI}" pixelfed-app php artisan tinker --execute=\
'try { $url = getenv("AP_INTEROP_ACTOR_URI"); $headers = App\Util\ActivityPub\HttpSignature::instanceActorSign($url, false, ["Accept" => "application/activity+json"], "get"); $headers["Accept"] = "application/activity+json"; $response = Illuminate\Support\Facades\Http::withOptions(["allow_redirects" => ["max" => 2, "protocols" => ["https"]]])->withHeaders($headers)->timeout(30)->connectTimeout(5)->get($url); dump(["status" => $response->status(), "contentType" => $response->header("Content-Type"), "bytes" => strlen($response->body())]); } catch (Throwable $error) { dump(["errorClass" => get_class($error), "error" => $error->getMessage()]); }' \
    >&2 || echo "Pixelfed signed actor-fetch diagnostic unavailable" >&2
}

friendica_diagnostics() {
  echo "Friendica fail-closed persistence diagnostics:" >&2
  {
    printf '%s\n' "select concat('remote_contact_count=', count(*), ',local_relationship_count=', coalesce(sum(c.uid <> 0),0), ',accepted_count=', coalesce(sum(c.uid <> 0 and c.rel in (1,3) and c.pending=0 and c.deleted=0),0), ',pending_count=', coalesce(sum(c.uid <> 0 and c.pending=1 and c.deleted=0),0), ',blocked_count=', coalesce(sum(c.blocked=1 and c.deleted=0),0)) from contact c where c.url='${actor_sql}';"
    printf '%s\n' "select concat('apcontact_count=', count(*), ',pubkey_count=', coalesce(sum(pubkey is not null and pubkey <> ''),0), ',inbox_count=', coalesce(sum(inbox is not null and inbox <> ''),0), ',account_type_count=', coalesce(sum(type in ('Person','Organization','Service','Group','Application')),0)) from apcontact where url='${actor_sql}';"
    printf '%s\n' "select concat('actor_uri_cache_count=', count(*)) from \`item-uri\` where uri='${actor_sql}';"
    printf '%s\n' "select concat('inbox_entry_count=', count(*), ',trusted_count=', coalesce(sum(trust=1),0), ',follow_count=', coalesce(sum(type='as:Follow'),0)) from \`inbox-entry\` where signer='${actor_sql}';"
    printf '%s\n' "select concat('inbox_receiver_count=', count(*)) from \`inbox-entry-receiver\` r join \`inbox-entry\` e on e.id=r.\`queue-id\` where e.signer='${actor_sql}';"
    printf '%s\n' "select concat('introduction_count=', count(*)) from intro i join contact c on c.id=i.\`contact-id\` where c.url='${actor_sql}';"
    printf '%s\n' "select concat('pending_worker_count=', count(*), ',retrying_worker_count=', coalesce(sum(retrial > 0),0)) from workerqueue where done=0;"
  } | compose exec -T friendica-db /bin/sh -lc \
    'MYSQL_PWD="$MARIADB_PASSWORD" mariadb --batch --skip-column-names -u friendica friendica' \
    >&2 || echo "Friendica database diagnostics unavailable" >&2
  compose exec -T -e AP_INTEROP_ACTOR_URI="${ACTOR_URI}" \
    -e AP_INTEROP_EXPECTED_ACTOR_HOST="${ACTIVITYPODS_HOST:?ACTIVITYPODS_HOST is required}" friendica-app \
    php /interop/actor-jsonld-diagnostic.php \
    >&2 || echo "Friendica privacy-safe actor JSON-LD diagnostic failed" >&2
  # Friendica's invalid-signature notice includes the full request headers and
  # body. Count only fixed event messages so failure evidence cannot disclose
  # credentials, signatures, or queued ActivityPub payloads.
  compose exec -T friendica-app php -r '
    $patterns = [
      "actor_fetch_discard_count" => "Unable to retrieve AP contact for actor - message is discarded",
      "invalid_http_signature_count" => "Invalid HTTP signature, message will not be trusted.",
      "valid_http_signature_count" => "Valid HTTP signature",
    ];
    $counts = array_fill_keys(array_keys($patterns), 0);
    $lineCount = 0;
    $handle = @fopen("/var/log/friendica/friendica.log", "rb");
    if ($handle === false) {
      fwrite(STDERR, "friendica_log_status=unavailable\n");
      exit(0);
    }
    while (($line = fgets($handle)) !== false) {
      $lineCount++;
      foreach ($patterns as $label => $message) {
        if (str_contains($line, $message)) {
          $counts[$label]++;
        }
      }
    }
    fclose($handle);
    fwrite(STDERR, "friendica_log_line_count=" . $lineCount . "\n");
    foreach ($counts as $label => $count) {
      fwrite(STDERR, $label . "=" . $count . "\n");
    }
  ' >&2 || echo "Friendica log counters unavailable" >&2
}

loops_diagnostics() {
  echo "Loops fail-closed persistence diagnostics:" >&2
  compose exec -T loops-db /bin/sh -lc \
    "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql --batch --skip-column-names -u loops loops -e \"
      select concat('remote_profile_count=', count(*), ',public_key_count=', coalesce(sum(public_key is not null and public_key <> ''),0), ',inbox_count=', coalesce(sum(inbox_url is not null and inbox_url <> ''),0)) from profiles where uri='${actor_sql}';
      select concat('local_target_count=', count(*)) from profiles where username='${username_sql}' and local=1;
      select concat('persisted_follow_count=', count(*)) from followers f join profiles follower on follower.id=f.profile_id join profiles target on target.id=f.following_id where follower.uri='${actor_sql}' and target.username='${username_sql}' and follower.local=0 and target.local=1;
      select concat('failed_job_count=', count(*)) from failed_jobs;\"" >&2 || echo "Loops database diagnostics unavailable" >&2
  compose exec -T loops-horizon php artisan horizon:status >&2 || echo "Loops Horizon status unavailable" >&2
}

peertube_diagnostics() {
  echo "PeerTube fail-closed persistence diagnostics:" >&2
  compose exec -T peertube-db /bin/sh -lc \
    "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -tAc \"
      select concat('remote_actor_count=', count(*), ',public_key_count=', coalesce(sum(case when \\\"publicKey\\\" is not null and \\\"publicKey\\\" <> '' then 1 else 0 end),0)) from actor where url='${actor_sql}';
      select concat('local_target_count=', count(*)) from actor where \\\"preferredUsername\\\"='${username_sql}' and \\\"serverId\\\" is null and \\\"accountId\\\" is not null;
      select concat('accepted_follow_count=', count(*)) from \\\"actorFollow\\\" f join actor follower on follower.id=f.\\\"actorId\\\" join actor target on target.id=f.\\\"targetActorId\\\" where follower.url='${actor_sql}' and target.\\\"preferredUsername\\\"='${username_sql}' and target.\\\"serverId\\\" is null and target.\\\"accountId\\\" is not null and f.state='accepted';\"" >&2 || echo "PeerTube database diagnostics unavailable" >&2
  compose ps peertube-app peertube-db peertube-redis >&2 || true
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
  misskey)
    compose logs --no-color misskey-app >&2 || true
    ;;
  friendica)
    friendica_diagnostics
    compose ps friendica-app friendica-worker >&2 || true
    ;;
  castopod)
    compose logs --no-color castopod-app >&2 || true
    ;;
  peertube)
    peertube_diagnostics
    ;;
  loops)
    # Application logs may contain signed request context. Emit only fixed
    # database and worker-health counters on a failed proof.
    loops_diagnostics
    ;;
esac
exit 1
