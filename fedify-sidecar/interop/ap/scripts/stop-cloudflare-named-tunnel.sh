#!/usr/bin/env bash
set -uo pipefail

# Tears down a named Cloudflare Tunnel started by
# start-cloudflare-named-tunnel.sh for the given AP_INTEROP_TUNNEL_CONTAINER
# value: removes the cloudflared container, deletes the DNS record, then
# deletes the Tunnel itself via the Cloudflare API, so nothing accumulates
# in the caller's Cloudflare account across CI runs. Best-effort and
# idempotent: safe to call even if the corresponding start call never ran
# or already failed, and always run under `if: always()`. A plain
# `docker rm -f` of the container is not sufficient on its own — that only
# cleans up the local container, not the Tunnel/DNS record in Cloudflare.

container="${1:-${AP_INTEROP_TUNNEL_CONTAINER:-}}"
if [[ -z "${container}" ]]; then
  echo "Usage: stop-cloudflare-named-tunnel.sh <AP_INTEROP_TUNNEL_CONTAINER>" >&2
  exit 0
fi

docker rm -f "${container}" >/dev/null 2>&1 || true

state_dir="${RUNNER_TEMP:-/tmp}/cf-named-tunnels/${container}"
if [[ ! -d "${state_dir}" ]]; then
  exit 0
fi

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  # See start-cloudflare-named-tunnel.sh: pasted-in secrets can carry an
  # invisible trailing CR/newline or surrounding whitespace.
  strip_ws() { printf '%s' "$1" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
  CLOUDFLARE_API_TOKEN="$(strip_ws "${CLOUDFLARE_API_TOKEN}")"
  CLOUDFLARE_ACCOUNT_ID="$(strip_ws "${CLOUDFLARE_ACCOUNT_ID:-}")"
  CLOUDFLARE_ZONE_ID="$(strip_ws "${CLOUDFLARE_ZONE_ID:-}")"

  api="https://api.cloudflare.com/client/v4"
  auth=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

  if [[ -f "${state_dir}/dns_record_id" && -n "${CLOUDFLARE_ZONE_ID:-}" ]]; then
    dns_record_id="$(cat "${state_dir}/dns_record_id" 2>/dev/null || true)"
    if [[ -n "${dns_record_id}" ]]; then
      curl -sS -X DELETE "${api}/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${dns_record_id}" \
        "${auth[@]}" >/dev/null || echo "Warning: failed to delete DNS record ${dns_record_id}" >&2
    fi
  fi

  if [[ -f "${state_dir}/tunnel_id" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    tunnel_id="$(cat "${state_dir}/tunnel_id" 2>/dev/null || true)"
    if [[ -n "${tunnel_id}" ]]; then
      # Connections can take a few seconds to fully drop after removing the
      # cloudflared container; retry the delete briefly rather than leaking
      # the tunnel.
      deleted=false
      for _ in $(seq 1 10); do
        response="$(curl -sS -X DELETE "${api}/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnel_id}" "${auth[@]}")"
        if [[ "$(printf '%s' "${response}" | jq -r '.success' 2>/dev/null)" == "true" ]]; then
          deleted=true
          break
        fi
        sleep 2
      done
      if [[ "${deleted}" != true ]]; then
        echo "Warning: failed to delete Cloudflare Tunnel ${tunnel_id} after retries" >&2
      fi
    fi
  fi
fi

rm -rf "${state_dir}"
exit 0
