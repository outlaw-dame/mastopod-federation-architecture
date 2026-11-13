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
  echo "usage: assert-real-follow-accepted.sh <mastodon|gotosocial|akkoma|pixelfed|bonfire|misskey|friendica|castopod> <actor-uri> [local-username]" >&2
  exit 2
fi

case "${TARGET}" in
  mastodon|gotosocial|akkoma|pixelfed|bonfire|misskey|friendica|castopod) ;;
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
  # Read only the explicitly enabled diagnostic setting. Do not print
  # arbitrary Friendica config or secret-bearing request logs.
  compose exec -T friendica-app php bin/console.php config system debugging >&2 \
    || echo "Friendica application logging config unavailable" >&2
  # Read-only local fixture diagnostics; 202 receipt never proves Follow state.
  compose exec -T friendica-worker /bin/sh -lc \
    'cd /var/www/html && php bin/console.php daemon status' >&2 \
    || echo "Friendica daemon status unavailable" >&2
  compose exec -T -e AP_INTEROP_ACTOR_URI="${ACTOR_URI}" friendica-app /bin/sh -lc \
    'curl --cacert /interop/runtime/certs/rootCA.crt --connect-timeout 5 --max-time 15 -sS -o /dev/null -w "actor_fetch_http=%{http_code} type=%{content_type}\\n" -H "Accept: application/activity+json" "$AP_INTEROP_ACTOR_URI"' >&2 \
    || echo "Friendica container actor-fetch diagnostic failed" >&2
  # A Follow targeting a local actor needs Friendica's own signed-fetch
  # fallback when its local actor has no APContact cache row. Test canonical
  # HTTPS reachability separately from that application's signed fetch; never
  # print the actor profile or request headers.
  compose exec -T -e AP_INTEROP_LOCAL_USERNAME="${LOCAL_USERNAME}" friendica-app /bin/sh -lc \
    'curl --cacert /interop/runtime/certs/rootCA.crt --connect-timeout 5 --max-time 15 -sS -o /dev/null -w "friendica_local_target_fetch_http=%{http_code} content_type=%{content_type}\\n" -H "Accept: application/activity+json" "https://friendica.test/profile/$AP_INTEROP_LOCAL_USERNAME"' >&2 \
    || echo "Friendica local target actor HTTPS diagnostic failed" >&2
  # Friendica writes application logs to a file, not Apache stdout.
  # Report bounded diagnostic categories only: logs can contain signed
  # requests, actors and other sensitive ActivityPub data.
  friendica_log_summary() {
    service="$1"
    printf 'Friendica %s application-log summary:\n' "${service}" >&2
    compose exec -T "${service}" /bin/sh -s <<'FRIENDICA_LOG_SUMMARY' >&2 \
      || echo "Friendica application-log metrics unavailable" >&2
# The README documents /var/www/friendica.log, while the pinned
# 2026.05 Apache image sets /var/www/html/friendica.log in
# config/zz-docker.config.php. Never print either raw application log.
log=
# The pinned 2026.05 image actively configures the HTML-volume path;
# prefer it over the older README fallback if both happen to exist.
for candidate in /var/www/html/friendica.log /var/www/friendica.log; do
  if [ -r "$candidate" ]; then
    log=$candidate
    break
  fi
done
# Compare both known logfile paths by *counts only*. Friendica 2026.05
# can retain the legacy path from its image installer while the Docker config
# points to the HTML volume. Never print raw log records.
for candidate in /var/www/html/friendica.log /var/www/friendica.log; do
  [ -r "$candidate" ] || continue
  case "$candidate" in
    /var/www/html/friendica.log) source=pinned_image ;;
    /var/www/friendica.log) source=legacy_fallback ;;
    *) exit 2 ;;
  esac
  tail -n 2000 "$candidate" | awk -v source="$source" '
    {
      line=tolower($0)
      n++
      if (index(line, "valid http signature")) good++
      if (index(line, "invalid http signature")) bad++
      if (index(line, "unable to retrieve ap contact for actor")) missing++
      if (index(line, "message for user") && index(line, "is from actor")) receiver++
      if (index(line, "follow user")) follow++
    }
    END {
      printf "friendica_log_compare_source=%s recent_lines=%d valid_signature=%d invalid_signature=%d actor_lookup_failed=%d receiver_messages=%d committed_follows=%d\n",
        source, n, good, bad, missing, receiver, follow
    }
  '
done
if [ -z "$log" ]; then
  echo "friendica_app_log=unavailable"
else
  if [ "$log" = /var/www/html/friendica.log ]; then
    echo "friendica_app_log_source=pinned_image"
  else
    echo "friendica_app_log_source=legacy_fallback"
  fi
  tail -n 2000 "$log" | awk '
    {
      line = tolower($0)
      lines++
      if (index(line, "[debug]")) debug_count++
      if (index(line, "[info]")) info_count++
      if (index(line, "[notice]")) notice_count++
      if (index(line, "[warning]")) warning_count++
      if (index(line, "invalid body.")) invalid_body++
      if (index(line, "signer is a tombstone")) tombstone_signer++
      if (index(line, "empty actor")) empty_actor++
      if (index(line, "no object found")) object_missing++
      if (index(line, "invalid object id")) object_id_invalid++
      if (index(line, "no object data found")) no_object++
      if (index(line, "activitypub")) ap++
      if (index(line, "inbox")) inbox++
      if (index(line, "urlverifier") || index(line, "url verifier")) urlverifier++
      if (index(line, "signature") && (index(line, "invalid") ||
          index(line, "failed") || index(line, "rejected"))) badsig++
      if (index(line, "fetch") && (index(line, "failed") ||
          index(line, "error"))) badfetch++
      if (index(line, "follow")) follows++
      if (index(line, "503")) unavailable++
      if (index(line, "unable to retrieve ap contact for actor")) missing_actor++
      if (index(line, "valid http signature") && !index(line, "invalid http signature")) valid_sig++
      if (index(line, "invalid http signature")) invalid_sig++
      if (index(line, "no signature provided")) absent_sig++
      if (index(line, "message for user") && index(line, "is from actor")) actor_msg++
      if (index(line, "empty type")) empty_type++
      if (index(line, "empty object")) empty_object++
      if (index(line, "actor missmatch")) actor_mismatch++
      if (index(line, "url not reachable")) unreachable++
      if (index(line, "error fetching url")) fetch_error++
      if (index(line, "could not find owner")) no_owner++
      if (index(line, "verification failed")) rsa_failed++
      if (index(line, "digest does not match")) digest_failed++
      if (index(line, "requested header field not found")) missing_signed_header++
      if (index(line, "empty key")) missing_key++
      if (index(line, "empty pubkey")) missing_pubkey++
      if (index(line, "no http_signature header")) no_http_signature++
      if (index(line, "no good signed content")) missing_digest_or_date++
      if (index(line, "activity trust could not be achieved")) untrusted++
      if (index(line, "processing") && index(line, "object_type")) receiver_processing++
      if (index(line, "unhandled activity")) unhandled++
      if (index(line, "follow user")) follow_committed++
      if (index(line, "activity could not been fetched")) activity_fetch_failed++
    }
    END {
      printf "recent_lines=%d activitypub=%d inbox=%d follow=%d url_verifier=%d invalid_signature=%d failed_fetch=%d http_503_mentions=%d\n",
        lines, ap, inbox, follows, urlverifier, badsig, badfetch, unavailable
      printf "actor_lookup_failed=%d valid_http_signature=%d invalid_http_signature=%d missing_signature=%d actor_messages=%d no_object_data=%d empty_type=%d empty_object=%d actor_mismatch=%d url_unreachable=%d url_fetch_error=%d missing_system_owner=%d\n",
        missing_actor, valid_sig, invalid_sig, absent_sig, actor_msg, no_object, empty_type, empty_object, actor_mismatch, unreachable, fetch_error, no_owner
      printf "rsa_failed=%d digest_failed=%d missing_signed_header=%d missing_key=%d missing_pubkey=%d no_http_signature=%d missing_digest_or_date=%d untrusted_activity=%d receiver_processing=%d unhandled_activity=%d follow_committed=%d activity_fetch_failed=%d\n",
        rsa_failed, digest_failed, missing_signed_header, missing_key, missing_pubkey, no_http_signature, missing_digest_or_date, untrusted, receiver_processing, unhandled, follow_committed, activity_fetch_failed
      printf "levels_debug=%d levels_info=%d levels_notice=%d levels_warning=%d invalid_body=%d signer_tombstone=%d empty_actor=%d missing_follow_object=%d invalid_object_id=%d\n",
        debug_count, info_count, notice_count, warning_count, invalid_body, tombstone_signer, empty_actor, object_missing, object_id_invalid
    }
  '
fi
FRIENDICA_LOG_SUMMARY
  }
  friendica_log_summary friendica-app
  friendica_log_summary friendica-worker
  {
    printf '%s\n' "select concat('friendica_apub_inbound_counter=',coalesce((select v from \`key-value\` where k='stats_packets_inbound_apub' limit 1),'absent'));"
    printf '%s\n' "select concat('friendica_local_self_count=', count(*), ',matching_actor_url_count=', coalesce(sum(c.url=concat('https://friendica.test/profile/',u.nickname)),0), ',matching_target_nickname_count=', coalesce(sum(u.nickname='${username_sql}'),0)) from contact c join user u on u.uid=c.uid where c.self=1 and u.nickname='${username_sql}';"
    printf '%s\n' "select concat('local_target_apcontact_count=',count(*), ',local_target_ap_type=',coalesce(max(type),'none')) from apcontact where url=concat('https://friendica.test/profile/','${username_sql}');"
    # Friendica User::getIdForURL() calls Contact::isLocal(), which requires
    # a uid=0 public contact with the same normalized URL and base URL.
    # A uid>0 self-contact alone does not prove the Follow target resolves.
    printf '%s\n' "select concat('local_public_contact_count=',count(*),',public_baseurl_match_count=',coalesce(sum(p.baseurl='https://friendica.test'),0),',public_baseurl_missing_count=',coalesce(sum(p.baseurl is null or p.baseurl=''),0)) from contact p join contact s on s.nurl=p.nurl and s.self=1 and s.uid=(select uid from user where nickname='${username_sql}' limit 1) where p.uid=0;"
    printf '%s\n' "select concat('apcontact_count=', count(*), ',actor_pubkey_count=', coalesce(sum(pubkey is not null and pubkey <> ''),0), ',actor_inbox_count=', coalesce(sum(inbox is not null and inbox <> ''),0)) from apcontact where url='${actor_sql}';"
    printf '%s\n' "select concat('remote_actor_type=',coalesce(max(type),'none'),',person_count=',coalesce(sum(type='Person'),0),',service_or_application_count=',coalesce(sum(type in ('Service','Application')),0),',group_count=',coalesce(sum(type='Group'),0)) from apcontact where url='${actor_sql}';"
    printf '%s\n' "select concat('remote_contact_count=', count(*), ',local_relationship_count=', coalesce(sum(c.uid <> 0),0), ',accepted_count=', coalesce(sum(c.uid <> 0 and c.rel in (1,3) and c.pending=0 and c.deleted=0),0), ',pending_count=', coalesce(sum(c.uid <> 0 and c.pending=1 and c.deleted=0),0), ',blocked_count=', coalesce(sum(c.blocked=1 and c.deleted=0),0)) from contact c where c.url='${actor_sql}';"
    printf '%s\n' "select concat('inbox_entry_count=', count(*), ',trusted_count=', coalesce(sum(trust=1),0), ',follow_count=', coalesce(sum(type='as:Follow'),0)) from \`inbox-entry\` where signer='${actor_sql}';"
    printf '%s\n' "select concat('inbox_receiver_count=', count(*)) from \`inbox-entry-receiver\` r join \`inbox-entry\` e on e.id=r.\`queue-id\` where e.signer='${actor_sql}';"
    printf '%s\n' "select concat('introduction_count=', count(*)) from intro i join contact c on c.id=i.\`contact-id\` where c.url='${actor_sql}';"
    printf '%s\n' "select concat('pending_worker_count=', count(*), ',retrying_worker_count=', coalesce(sum(retrial > 0),0)) from workerqueue where done=0;"
  } | compose exec -T friendica-db /bin/sh -lc \
    'MYSQL_PWD="$MARIADB_PASSWORD" mariadb --batch --skip-column-names -u friendica friendica' \
    >&2 || echo "Friendica database diagnostics unavailable" >&2
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
    compose logs --no-color friendica-app friendica-worker >&2 || true
    ;;
  castopod)
    compose logs --no-color castopod-app >&2 || true
    ;;
esac
exit 1
