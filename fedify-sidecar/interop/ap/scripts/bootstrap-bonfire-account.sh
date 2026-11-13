#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
BONFIRE_OVERLAY="${AP_INTEROP_BONFIRE_OVERLAY:-${SCRIPT_DIR}/../docker-compose.bonfire.yml}"
USERNAME="${AP_INTEROP_BONFIRE_USERNAME:-interop}"
printf '%s' "$USERNAME" | LC_ALL=C grep -Eq '^[a-z][a-z0-9_]{0,31}$' ||
  { echo 'Bonfire fixture username contains unsupported characters' >&2; exit 2; }
compose() { docker compose -f "$COMPOSE_FILE" -f "$BONFIRE_OVERLAY" "$@"; }

# Compile nothing; unpack the checksum-verified official RC8 Community release.
bash "$SCRIPT_DIR/../bonfire-rc8/prepare-rc8.sh"
: "${AP_INTEROP_BONFIRE_PASSWORD:=$(openssl rand -hex 24)}"
export AP_INTEROP_BONFIRE_PASSWORD
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  printf '::add-mask::%s\n' "$AP_INTEROP_BONFIRE_PASSWORD"
fi
compose build bonfire-app
compose up -d bonfire-db bonfire-app

# First-boot migrations are asynchronous. An existing Users table or an
# accepting BEAM process is NOT proof that settings/Federate tables exist.
# The official RC8 clean release has 169 migrations. Require their ledger
# and the exact settings table before performing any user/instance writes.
ready=false
for attempt in $(seq 1 180); do
  if compose exec -T -e PGPASSWORD="$BONFIRE_DB_PASSWORD" bonfire-db \
    psql -h 127.0.0.1 -U postgres -d bonfire_db -X -Atqc \
    "SELECT CASE WHEN to_regclass('public.bonfire_data_identity_settings') IS NOT NULL AND (SELECT count(*) FROM schema_migrations) >= 169 THEN 1 ELSE 0 END;" \
    2>/dev/null | grep -qx 1; then
    ready=true; break
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  # Fixed-category diagnostics only: release logs can contain sensitive
  # configuration, so never upload or print unredacted application logs.
  for symptom in 'Postgrex.Error' 'DBConnection.ConnectionError' \
      'could not start application' 'missing postgres' \
      'permission denied' 'UndefinedFunctionError' \
      'relation' 'migration'; do
    if compose logs --no-color --tail=180 bonfire-app 2>/dev/null \
       | grep -qiF "$symptom"; then
      case "$symptom" in
        *Postgrex*|*DBConnection*|*postgres*|relation)
          echo 'bonfire_docker_failure=database_or_schema' ;;
        *migration*) echo 'bonfire_docker_failure=migrations' ;;
        *) echo 'bonfire_docker_failure=release_bootstrap' ;;
      esac
    fi
  done
  # Report only non-sensitive schema presence/count from disposable SQL.
  compose exec -T -e PGPASSWORD="$BONFIRE_DB_PASSWORD" bonfire-db \
    psql -h 127.0.0.1 -U postgres -d bonfire_db -X -Atqc \
    "SELECT 'bonfire_docker_schema_count=' || count(*) FROM schema_migrations;" \
    2>/dev/null || true
  echo 'Bonfire Community RC8 database schema failed readiness' >&2
  exit 1
fi

# Use the fixture CA with normal signature and TLS validation. Never turn off
# signed fetch, HTTPS checks, or SSRF protections in actual deployments.
certifi_path=$(compose exec -T bonfire-app bin/bonfire rpc ':certifi.cacertfile() |> IO.puts()' \
  | awk '/^\//{value=$0} END{print value}')
case "$certifi_path" in
  /opt/bonfire/*) ;;
  *) echo 'Bonfire certifi path is not within the release directory' >&2; exit 1 ;;
esac
compose exec -T -u 0 bonfire-app /bin/sh -c \
  'cat /interop/runtime/certs/rootCA.crt >> "$1"' sh "$certifi_path"

# OTP's public_key:cacerts_get/0 uses a separately cached OS trust store,
# even if the application's :certifi file was extended. The real Bonfire
# delivery adapter uses TLS peer verification against that OTP trust store.
# Reload a complete OS+fixture CA bundle into the *disposable* BEAM node;
# do NOT change TLS verify_peer, signatures, or global SSRF rules.
compose exec -T -u 0 bonfire-app /bin/sh -c \
  'cat /etc/ssl/certs/ca-certificates.crt /interop/runtime/certs/rootCA.crt > /tmp/ap-interop-combined-ca.pem && chmod 644 /tmp/ap-interop-combined-ca.pem'
otp_ca_status=$(compose exec -T bonfire-app bin/bonfire rpc \
  'case :public_key.cacerts_load("/tmp/ap-interop-combined-ca.pem") do :ok -> :ssl.clear_pem_cache(); IO.puts("AP_INTEROP_OTP_CA_READY"); _ -> raise "Unable to load fixture trust roots" end' \
  | tr -d '\r' | grep -c '^AP_INTEROP_OTP_CA_READY
# environment. It is never interpolated into the Elixir RPC or printed.
# Postgres schema readiness is not BEAM Cachex application readiness.
# A clean release can finish all 169 migrations before its cache is running.
# Only this known transient cache-startup exception is retried; any other
# failure is a hard error. Every attempt first checks the existing user so
# that uncertainty after account creation cannot mint a duplicate.
rpc_out=$(mktemp "${TMPDIR:-/tmp}/bonfire-user-rpc.XXXXXX")
rpc_err=$(mktemp "${TMPDIR:-/tmp}/bonfire-user-err.XXXXXX")
trap 'rm -f "$rpc_out" "$rpc_err"' EXIT HUP INT TERM
user_ready=false
for attempt in $(seq 1 60); do
  if compose exec -T bonfire-app bin/bonfire rpc \
    "Bonfire.Federate.ActivityPub.set_federating(:instance, true); name = \"$USERNAME\"; case Bonfire.Me.Users.by_username(name) do {:ok, user} -> Bonfire.Federate.ActivityPub.set_federating(user, true); IO.puts(\"AP_INTEROP_USER_READY\"); _ -> case Bonfire.Me.make_account_and_user(name, name <> \"@bonfire.test\", System.fetch_env!(\"AP_INTEROP_USER_PASSWORD\")) do {:ok, user} -> Bonfire.Federate.ActivityPub.set_federating(user, true); IO.puts(\"AP_INTEROP_USER_READY\"); _ -> raise \"Bonfire test user creation failed\" end end" \
    >"$rpc_out" 2>"$rpc_err" && grep -qx 'AP_INTEROP_USER_READY' "$rpc_out"; then
    user_ready=true
    break
  fi
  if ! grep -Fq 'Specified cache not running' "$rpc_out" "$rpc_err"; then
    echo 'Bonfire user/instance setup failed for a non-retryable reason' >&2
    exit 1
  fi
  if [ "$attempt" -eq 60 ]; then break; fi
  sleep 2
done
if [ "$user_ready" != true ]; then
  echo 'Bonfire Cachex was not ready within the bounded fixture startup window' >&2
  exit 1
fi

# Public discovery is mandatory; 401/403 or bare HTTP startup is not a pass.
# The BEAM release may have committed migrations and accepted RPCs before
# its HTTP listener is ready. Do not treat curl's exit 7 as a federation
# failure, nor suppress a persistent 401/403: retry the SAME local fixture
# only for a bounded startup window, then require an actual 200.
status=unavailable
webfinger_ready=false
for attempt in $(seq 1 120); do
  status=$(compose exec -T bonfire-app curl --silent --output /dev/null \
    --max-time 5 --write-out '%{http_code}' \
    -H 'Host: bonfire.test' -H 'Accept: application/jrd+json' \
    "http://127.0.0.1:4000/.well-known/webfinger?resource=acct:$USERNAME@bonfire.test" \
    2>/dev/null) || status=unavailable
  if [ "$status" = 200 ]; then
    webfinger_ready=true
    break
  fi
  sleep 2
done
if [ "$webfinger_ready" != true ]; then
  echo "Bonfire fixture WebFinger never became public (last HTTP $status)" >&2
  exit 1
fi
echo 'bonfire_rc8_person_ready'
 || true)
if [ "$otp_ca_status" != 1 ]; then
  echo 'Bonfire OTP TLS CA reload was not confirmed' >&2
  exit 1
fi
echo 'bonfire_fixture_otp_tls_trust=verified'

# Password is available only to this disposable server through its startup
# environment. It is never interpolated into the Elixir RPC or printed.
# Postgres schema readiness is not BEAM Cachex application readiness.
# A clean release can finish all 169 migrations before its cache is running.
# Only this known transient cache-startup exception is retried; any other
# failure is a hard error. Every attempt first checks the existing user so
# that uncertainty after account creation cannot mint a duplicate.
rpc_out=$(mktemp "${TMPDIR:-/tmp}/bonfire-user-rpc.XXXXXX")
rpc_err=$(mktemp "${TMPDIR:-/tmp}/bonfire-user-err.XXXXXX")
trap 'rm -f "$rpc_out" "$rpc_err"' EXIT HUP INT TERM
user_ready=false
for attempt in $(seq 1 60); do
  if compose exec -T bonfire-app bin/bonfire rpc \
    "Bonfire.Federate.ActivityPub.set_federating(:instance, true); name = \"$USERNAME\"; case Bonfire.Me.Users.by_username(name) do {:ok, user} -> Bonfire.Federate.ActivityPub.set_federating(user, true); IO.puts(\"AP_INTEROP_USER_READY\"); _ -> case Bonfire.Me.make_account_and_user(name, name <> \"@bonfire.test\", System.fetch_env!(\"AP_INTEROP_USER_PASSWORD\")) do {:ok, user} -> Bonfire.Federate.ActivityPub.set_federating(user, true); IO.puts(\"AP_INTEROP_USER_READY\"); _ -> raise \"Bonfire test user creation failed\" end end" \
    >"$rpc_out" 2>"$rpc_err" && grep -qx 'AP_INTEROP_USER_READY' "$rpc_out"; then
    user_ready=true
    break
  fi
  if ! grep -Fq 'Specified cache not running' "$rpc_out" "$rpc_err"; then
    echo 'Bonfire user/instance setup failed for a non-retryable reason' >&2
    exit 1
  fi
  if [ "$attempt" -eq 60 ]; then break; fi
  sleep 2
done
if [ "$user_ready" != true ]; then
  echo 'Bonfire Cachex was not ready within the bounded fixture startup window' >&2
  exit 1
fi

# Public discovery is mandatory; 401/403 or bare HTTP startup is not a pass.
# The BEAM release may have committed migrations and accepted RPCs before
# its HTTP listener is ready. Do not treat curl's exit 7 as a federation
# failure, nor suppress a persistent 401/403: retry the SAME local fixture
# only for a bounded startup window, then require an actual 200.
status=unavailable
webfinger_ready=false
for attempt in $(seq 1 120); do
  status=$(compose exec -T bonfire-app curl --silent --output /dev/null \
    --max-time 5 --write-out '%{http_code}' \
    -H 'Host: bonfire.test' -H 'Accept: application/jrd+json' \
    "http://127.0.0.1:4000/.well-known/webfinger?resource=acct:$USERNAME@bonfire.test" \
    2>/dev/null) || status=unavailable
  if [ "$status" = 200 ]; then
    webfinger_ready=true
    break
  fi
  sleep 2
done
if [ "$webfinger_ready" != true ]; then
  echo "Bonfire fixture WebFinger never became public (last HTTP $status)" >&2
  exit 1
fi
echo 'bonfire_rc8_person_ready'
