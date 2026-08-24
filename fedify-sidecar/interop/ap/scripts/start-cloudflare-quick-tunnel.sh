#!/usr/bin/env bash
set -euo pipefail

# Starts a credentialless, ephemeral Cloudflare Quick Tunnel for an isolated
# interop job. The origin is deliberately constrained to loopback/RFC1918 HTTP
# so this helper cannot expose an arbitrary host supplied by untrusted input.

: "${AP_INTEROP_TUNNEL_CONTAINER:?AP_INTEROP_TUNNEL_CONTAINER is required}"
: "${AP_INTEROP_TUNNEL_ORIGIN:?AP_INTEROP_TUNNEL_ORIGIN is required}"
: "${AP_INTEROP_CLOUDFLARED_IMAGE:?AP_INTEROP_CLOUDFLARED_IMAGE is required}"

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

docker rm -f "${AP_INTEROP_TUNNEL_CONTAINER}" >/dev/null 2>&1 || true
docker run -d --name "${AP_INTEROP_TUNNEL_CONTAINER}" --network host \
  "${AP_INTEROP_CLOUDFLARED_IMAGE}" tunnel --no-autoupdate \
  --url "${AP_INTEROP_TUNNEL_ORIGIN}" --loglevel info >/dev/null

hostname=''
for attempt in $(seq 1 60); do
  if ! docker inspect "${AP_INTEROP_TUNNEL_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
    docker logs "${AP_INTEROP_TUNNEL_CONTAINER}" >&2 || true
    echo "Cloudflare Quick Tunnel exited before publishing an authority" >&2
    exit 1
  fi
  hostname="$(docker logs "${AP_INTEROP_TUNNEL_CONTAINER}" 2>&1 \
    | sed -nE 's#.*https://([a-z0-9-]+\.trycloudflare\.com).*#\1#p' \
    | sort -u)"
  if [[ -n "${hostname}" ]]; then break; fi
  sleep 1
done

if [[ -z "${hostname}" || "${hostname}" == *$'\n'* || ! "${hostname}" =~ ^[a-z0-9-]+\.trycloudflare\.com$ ]]; then
  docker logs "${AP_INTEROP_TUNNEL_CONTAINER}" >&2 || true
  echo "Cloudflare Quick Tunnel did not publish exactly one valid authority" >&2
  exit 1
fi

printf '%s\n' "${hostname}"
