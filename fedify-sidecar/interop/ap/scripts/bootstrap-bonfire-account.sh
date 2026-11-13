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

# Actual account schema read, bounded to six minutes (not mere BEAM health).
ready=false
for attempt in $(seq 1 180); do
  if compose exec -T bonfire-app bin/bonfire rpc \
    'case Bonfire.Me.Users.by_username("interop") do _ -> IO.puts("AP_INTEROP_SCHEMA_READY") end' \
    2>/dev/null | grep -qx 'AP_INTEROP_SCHEMA_READY'; then
    ready=true; break
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  echo 'Bonfire Community RC8 database schema failed readiness' >&2; exit 1
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

# Password is available only to this disposable server through its startup
# environment. It is never interpolated into the Elixir RPC or printed.
compose exec -T bonfire-app bin/bonfire rpc \
  "Bonfire.Federate.ActivityPub.set_federating(:instance, true); name = \"$USERNAME\"; case Bonfire.Me.Users.by_username(name) do {:ok, user} -> Bonfire.Federate.ActivityPub.set_federating(user, true); IO.puts(\"AP_INTEROP_USER_READY\"); _ -> case Bonfire.Me.make_account_and_user(name, name <> \"@bonfire.test\", System.fetch_env!(\"AP_INTEROP_USER_PASSWORD\")) do {:ok, user} -> Bonfire.Federate.ActivityPub.set_federating(user, true); IO.puts(\"AP_INTEROP_USER_READY\"); _ -> raise \"Bonfire test user creation failed\" end end" \
  | grep -qx 'AP_INTEROP_USER_READY'

# Public discovery is mandatory; 401/403 or bare HTTP startup is not a pass.
status=$(compose exec -T bonfire-app curl --silent --output /dev/null \
  --max-time 10 --write-out '%{http_code}' \
  -H 'Host: bonfire.test' -H 'Accept: application/jrd+json' \
  "http://127.0.0.1:4000/.well-known/webfinger?resource=acct:$USERNAME@bonfire.test")
[ "$status" = 200 ] ||
  { echo "Bonfire fixture WebFinger HTTP $status" >&2; exit 1; }
echo 'bonfire_rc8_person_ready'
