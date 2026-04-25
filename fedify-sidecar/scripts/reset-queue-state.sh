#!/usr/bin/env bash
set -euo pipefail

# Reset queue state for clean benchmark runs.
# Deletes queue streams, DLQ streams (typed + legacy), and outbox-intent state keys.

REDIS_CLI="${REDIS_CLI:-redis-cli}"

QUEUE_KEYS=(
  "ap:queue:inbound:v1"
  "ap:queue:outbound:v1"
  "ap:queue:outbox-intent:v1"
  "ap:queue:dlq:inbound:v1"
  "ap:queue:dlq:outbound:v1"
  "ap:queue:dlq:outbox-intent:v1"
  "ap:queue:dlq:v1"
)

echo "[queue-reset] deleting queue keys"
"$REDIS_CLI" del "${QUEUE_KEYS[@]}" >/dev/null || true

echo "[queue-reset] deleting outbox intent state keys"
"$REDIS_CLI" --scan --pattern 'ap:outbox-intent:state:*' \
  | xargs -r -I {} "$REDIS_CLI" del '{}' >/dev/null

echo "[queue-reset] verification"
for key in "${QUEUE_KEYS[@]}"; do
  len=$("$REDIS_CLI" xlen "$key" 2>/dev/null || echo 0)
  # xlen prints '(integer) 0' in human mode; sanitize numeric token.
  sanitized=$(printf '%s' "$len" | tr -cd '0-9')
  if [ -z "$sanitized" ]; then
    sanitized="0"
  fi
  echo "[queue-reset] $key length=$sanitized"
done

echo "[queue-reset] done"
