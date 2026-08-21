#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-${SCRIPT_DIR}/../docker-compose.ap-interop.yml}"
REAL_OVERLAY="${AP_INTEROP_REAL_OVERLAY:-${SCRIPT_DIR}/../docker-compose.real-activitypods.yml}"

if [ "$#" -eq 0 ]; then
  echo "usage: configure-proof-router-hosts.sh <fixture-hostname>..." >&2
  exit 2
fi

router_id=$(docker compose -f "${COMPOSE_FILE}" -f "${REAL_OVERLAY}" --profile real-activitypods ps -q ap-proof-router)
if [ -z "${router_id}" ]; then
  echo "ActivityPub proof router container is not running" >&2
  exit 1
fi

router_ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{if .IPAddress}}{{println .IPAddress}}{{end}}{{end}}' "${router_id}" \
  | awk 'NF { print; exit }')

# This route is intentionally limited to a Docker RFC1918 address. Loopback,
# link-local, public, and malformed addresses remain rejected so the production
# egress policy cannot be bypassed by this harness.
if ! ROUTER_IP="${router_ip}" node - <<'NODE'
const ip = process.env.ROUTER_IP || '';
const octets = ip.split('.').map(Number);
const valid = octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255);
const privateAddress = valid && (
  octets[0] === 10 ||
  (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
  (octets[0] === 192 && octets[1] === 168)
);
if (!privateAddress) process.exit(1);
NODE
then
  echo "Proof router did not resolve to an RFC1918 Docker address: ${router_ip:-<empty>}" >&2
  exit 1
fi

for hostname in "$@"; do
  case "${hostname}" in
    ''|*[!a-z0-9.-]*)
      echo "Invalid proof hostname: ${hostname}" >&2
      exit 2
      ;;
  esac
done

{
  printf '%s' "${router_ip}"
  for hostname in "$@"; do printf ' %s' "${hostname}"; done
  printf '\n'
} | sudo tee -a /etc/hosts >/dev/null

for hostname in "$@"; do
  resolved=$(getent ahostsv4 "${hostname}" | awk 'NR == 1 { print $1 }')
  if [ "${resolved}" != "${router_ip}" ]; then
    echo "Proof hostname ${hostname} resolved to ${resolved:-<empty>} instead of ${router_ip}" >&2
    exit 1
  fi
done

printf '{"schema":"ap.interop.proof-router-hosts.v1","routerAddress":"%s","hostnames":[' "${router_ip}"
separator=''
for hostname in "$@"; do
  printf '%s"%s"' "${separator}" "${hostname}"
  separator=','
done
printf ']}\n'
