#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_DIR="${SCRIPT_DIR}/../runtime/misskey"
: "${MISSKEY_DB_PASSWORD:?MISSKEY_DB_PASSWORD is required}"
: "${MISSKEY_SETUP_PASSWORD:?MISSKEY_SETUP_PASSWORD is required}"

is_hex_secret() {
  [ "${#1}" -eq 64 ] && printf '%s' "$1" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$'
}
is_hex_secret "${MISSKEY_DB_PASSWORD}" || { echo "MISSKEY_DB_PASSWORD must be 64 lowercase hex characters" >&2; exit 2; }
is_hex_secret "${MISSKEY_SETUP_PASSWORD}" || { echo "MISSKEY_SETUP_PASSWORD must be 64 lowercase hex characters" >&2; exit 2; }

mkdir -p "${RUNTIME_DIR}"
umask 077
config_tmp=$(mktemp "${RUNTIME_DIR}/default.yml.XXXXXX")
trap 'rm -f "${config_tmp}"' EXIT HUP INT TERM
cat >"${config_tmp}" <<EOF
url: https://misskey.test/
port: 3000
setupPassword: ${MISSKEY_SETUP_PASSWORD}
db:
  host: misskey-db
  port: 5432
  db: misskey
  user: misskey
  pass: ${MISSKEY_DB_PASSWORD}
redis:
  host: misskey-redis
  port: 6379
id: aidx
allowedPrivateNetworks:
  - 172.31.240.0/24
EOF
mv "${config_tmp}" "${RUNTIME_DIR}/default.yml"
trap - EXIT HUP INT TERM
