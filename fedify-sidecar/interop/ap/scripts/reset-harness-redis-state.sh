#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"

docker compose -f "${COMPOSE_FILE}" exec -T redis sh -lc '
set -eu
keys="$(redis-cli --scan --pattern "ap:*")"
if [ -z "$keys" ]; then
  exit 0
fi
printf "%s\n" "$keys" | while IFS= read -r key; do
  [ -n "$key" ] || continue
  redis-cli DEL "$key" >/dev/null
done
'
