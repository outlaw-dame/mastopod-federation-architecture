#!/usr/bin/env bash
set -euo pipefail

# Starts an authenticated, named Cloudflare Tunnel for an isolated interop
# job, as a drop-in replacement for the free/anonymous Quick Tunnel
# (start-cloudflare-quick-tunnel.sh). Quick Tunnels carry no uptime
# guarantee (Cloudflare's own documented behavior) and were the confirmed
# source of persistent `tlsv1 alert internal error` failures for
# friendica/loops/owncast/peertube's sidecar-mode leg. A named tunnel goes
# through the caller's own Cloudflare account and real edge routing instead.
#
# Same container-based lifecycle as the Quick Tunnel helper (runs the same
# pinned cloudflared image via `docker run -d --name ...`, cleaned up with
# `docker rm -f` by the caller), so it's a drop-in replacement at call
# sites. The origin is deliberately constrained to loopback/RFC1918 HTTP so
# this helper cannot expose an arbitrary host supplied by untrusted input,
# the same invariant the Quick Tunnel helper enforced.
#
# Unlike the Quick Tunnel helper, this also creates real (small, ephemeral)
# resources in the caller's Cloudflare account: a Tunnel and a DNS record.
# Callers MUST invoke stop-cloudflare-named-tunnel.sh for the same
# AP_INTEROP_TUNNEL_CONTAINER value once done, in an `if: always()` step,
# so nothing accumulates across CI runs. `docker rm -f` alone is not
# sufficient to clean this one up.

: "${AP_INTEROP_TUNNEL_CONTAINER:?AP_INTEROP_TUNNEL_CONTAINER is required}"
: "${AP_INTEROP_TUNNEL_ORIGIN:?AP_INTEROP_TUNNEL_ORIGIN is required}"
: "${AP_INTEROP_CLOUDFLARED_IMAGE:?AP_INTEROP_CLOUDFLARED_IMAGE is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID is required}"
: "${CLOUDFLARE_TUNNEL_ZONE:?CLOUDFLARE_TUNNEL_ZONE is required}"

if [[ ! "${AP_INTEROP_TUNNEL_CONTAINER}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]]; then
  echo "Invalid tunnel container name" >&2
  exit 2
fi

if [[ ! "${AP_INTEROP_TUNNEL_ORIGIN}" =~ ^http://(127\.0\.0\.1|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}):([0-9]{1,5})$ ]]; then
  echo "Tunnel origin must be an explicit loopback or RFC1918 HTTP host and port" >&2
  exit 2
fi

port="${BASH_REMATCH[3]}"
if (( port < 1 || port > 65535 )); then
  echo "Tunnel origin port is out of range" >&2
  exit 2
fi

api="https://api.cloudflare.com/client/v4"
auth=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")

state_dir="${RUNNER_TEMP:-/tmp}/cf-named-tunnels/${AP_INTEROP_TUNNEL_CONTAINER}"
rm -rf "${state_dir}"
mkdir -p "${state_dir}"

tunnel_name="ap-ci-${AP_INTEROP_TUNNEL_CONTAINER}-${GITHUB_RUN_ID:-local}-${RANDOM}${RANDOM}"
label="$(printf '%s' "${tunnel_name}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed -E 's/-+/-/g; s/^-|-$//g')"
hostname="${label}.${CLOUDFLARE_TUNNEL_ZONE}"

create_response="$(curl -sS -X POST "${api}/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel" \
  "${auth[@]}" \
  --data "$(jq -nc --arg name "${tunnel_name}" '{name:$name,config_src:"local"}')")"

if [[ "$(printf '%s' "${create_response}" | jq -r '.success')" != "true" ]]; then
  echo "Failed to create Cloudflare Tunnel:" >&2
  printf '%s\n' "${create_response}" >&2
  exit 1
fi

tunnel_id="$(printf '%s' "${create_response}" | jq -r '.result.id')"
printf '%s' "${tunnel_id}" > "${state_dir}/tunnel_id"

token_response="$(curl -sS "${api}/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnel_id}/token" "${auth[@]}")"
if [[ "$(printf '%s' "${token_response}" | jq -r '.success')" != "true" ]]; then
  echo "Failed to fetch Cloudflare Tunnel token:" >&2
  printf '%s\n' "${token_response}" >&2
  exit 1
fi
tunnel_token="$(printf '%s' "${token_response}" | jq -r '.result')"

dns_response="$(curl -sS -X POST "${api}/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
  "${auth[@]}" \
  --data "$(jq -nc --arg name "${hostname}" --arg content "${tunnel_id}.cfargotunnel.com" \
    '{type:"CNAME",name:$name,content:$content,proxied:true,ttl:1}')")"

if [[ "$(printf '%s' "${dns_response}" | jq -r '.success')" != "true" ]]; then
  echo "Failed to create DNS record for ${hostname}:" >&2
  printf '%s\n' "${dns_response}" >&2
  exit 1
fi
dns_record_id="$(printf '%s' "${dns_response}" | jq -r '.result.id')"
printf '%s' "${dns_record_id}" > "${state_dir}/dns_record_id"

docker rm -f "${AP_INTEROP_TUNNEL_CONTAINER}" >/dev/null 2>&1 || true
# `--loglevel` is a tunnel-level option, not a `run` subcommand option — it
# must come before `run`, or cloudflared rejects the whole invocation with
# "flag provided but not defined: -loglevel" before ever attempting a
# connection (confirmed from a real failing run on this exact command).
docker run -d --name "${AP_INTEROP_TUNNEL_CONTAINER}" --network host \
  "${AP_INTEROP_CLOUDFLARED_IMAGE}" tunnel --no-autoupdate --loglevel info run \
  --token "${tunnel_token}" --url "${AP_INTEROP_TUNNEL_ORIGIN}" >/dev/null

connected=false
for attempt in $(seq 1 60); do
  if ! docker inspect "${AP_INTEROP_TUNNEL_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
    docker logs "${AP_INTEROP_TUNNEL_CONTAINER}" >&2 || true
    echo "Cloudflare Tunnel exited before registering a connection" >&2
    exit 1
  fi
  if docker logs "${AP_INTEROP_TUNNEL_CONTAINER}" 2>&1 \
    | grep -qE 'Registered tunnel connection|Connection [0-9a-f-]+ registered'; then
    connected=true
    break
  fi
  sleep 1
done

if [[ "${connected}" != true ]]; then
  docker logs "${AP_INTEROP_TUNNEL_CONTAINER}" >&2 || true
  echo "Cloudflare Tunnel did not report a registered connection in time" >&2
  exit 1
fi

printf '%s\n' "${hostname}"
