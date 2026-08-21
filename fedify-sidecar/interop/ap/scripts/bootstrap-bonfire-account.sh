#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
BONFIRE_OVERLAY="${AP_INTEROP_BONFIRE_OVERLAY:-${SCRIPT_DIR}/../docker-compose.bonfire.yml}"
USERNAME="${AP_INTEROP_BONFIRE_USERNAME:-interop}"

compose() {
  docker compose -f "${COMPOSE_FILE}" -f "${BONFIRE_OVERLAY}" "$@"
}

compose up -d bonfire-db bonfire-app

ready=false
for attempt in $(seq 1 150); do
  # The release VM accepts RPCs before its background auto-migrator has
  # created the identity tables. Probe the actual account read used below so
  # a live BEAM alone cannot be mistaken for a ready Bonfire database.
  if compose exec -T bonfire-app bin/bonfire rpc \
    "case Bonfire.Me.Users.by_username(\"${USERNAME}\") do _ -> IO.puts(\"AP_INTEROP_SCHEMA_READY\") end" \
    2>/dev/null | grep -q '^AP_INTEROP_SCHEMA_READY$'; then
    ready=true
    break
  fi
  sleep 2
done
if [ "${ready}" != true ]; then
  compose logs --no-color bonfire-app >&2 || true
  exit 1
fi

# Bonfire v1.0.6 configures its outbound Erlang TLS client with certifi's
# bundled CA file. Add only the ephemeral harness CA to that container-local
# bundle so actor/key dereferencing uses normal certificate verification.
certifi_path=$(compose exec -T bonfire-app bin/bonfire rpc ':certifi.cacertfile() |> IO.puts()' \
  | awk '/^\//{value=$0} END{print value}')
case "${certifi_path}" in
  /opt/app/*|/opt/bonfire/*) ;;
  *) echo "Unexpected Bonfire certifi CA path: ${certifi_path}" >&2; exit 1 ;;
esac
compose exec -T -u 0 bonfire-app /bin/sh -c \
  'cat /interop/runtime/certs/rootCA.crt >> "$1"' sh "${certifi_path}"

exists=$(compose exec -T bonfire-app bin/bonfire rpc \
  "case Bonfire.Me.Users.by_username(\"${USERNAME}\") do {:ok, _} -> IO.puts(\"1\"); _ -> IO.puts(\"0\") end" \
  | awk '/^[01]$/{value=$0} END{print value}')
if [ "${exists}" != "1" ]; then
  compose exec -T bonfire-app bin/bonfire rpc \
    "case Bonfire.Me.make_account_and_user(\"${USERNAME}\", \"${USERNAME}@bonfire.test\", \"Interop-Proof-Only-2026\") do {:ok, _} -> IO.puts(\"AP_INTEROP_USER_CREATED\"); other -> raise inspect(other) end" \
    | grep -q '^AP_INTEROP_USER_CREATED$'
fi
