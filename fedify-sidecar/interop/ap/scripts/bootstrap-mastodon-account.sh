#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"
ENV_FILE="${AP_INTEROP_MASTODON_ENV_FILE:-${SCRIPT_DIR}/../runtime/mastodon.env}"
USERNAME="${AP_INTEROP_MASTODON_USERNAME:-interop}"
EMAIL="${AP_INTEROP_MASTODON_EMAIL:-interop@mastodon}"
BOOTSTRAP_ATTEMPTS="${AP_INTEROP_MASTODON_BOOTSTRAP_ATTEMPTS:-8}"
BOOTSTRAP_INITIAL_DELAY_SECONDS="${AP_INTEROP_MASTODON_BOOTSTRAP_INITIAL_DELAY_SECONDS:-2}"
BOOTSTRAP_MAX_DELAY_SECONDS="${AP_INTEROP_MASTODON_BOOTSTRAP_MAX_DELAY_SECONDS:-10}"

set -a
. "${ENV_FILE}"
set +a

wait_for_mastodon() {
  attempt=1
  delay="${BOOTSTRAP_INITIAL_DELAY_SECONDS}"

  while [ "${attempt}" -le "${BOOTSTRAP_ATTEMPTS}" ]; do
    if docker compose -f "${COMPOSE_FILE}" exec -T mastodon-web-app \
      /bin/sh -lc "wget -qO- http://127.0.0.1:3000/health >/dev/null" >/dev/null 2>&1; then
      return 0
    fi

    if [ "${attempt}" -eq "${BOOTSTRAP_ATTEMPTS}" ]; then
      break
    fi

    echo "Waiting for Mastodon web app to become ready (attempt ${attempt}/${BOOTSTRAP_ATTEMPTS})..." >&2
    sleep "${delay}"
    attempt=$((attempt + 1))
    if [ "${delay}" -lt "${BOOTSTRAP_MAX_DELAY_SECONDS}" ]; then
      delay=$((delay * 2))
      if [ "${delay}" -gt "${BOOTSTRAP_MAX_DELAY_SECONDS}" ]; then
        delay="${BOOTSTRAP_MAX_DELAY_SECONDS}"
      fi
    fi
  done

  echo "Mastodon did not become ready in time." >&2
  exit 1
}

account_exists() {
  username_sql=$(printf "%s" "${USERNAME}" | sed "s/'/''/g")
  result=$(
    docker compose -f "${COMPOSE_FILE}" exec -T mastodon-db \
      /bin/sh -lc "PGPASSWORD=postgres psql -U postgres -d mastodon_production -tAc \"select 1 from accounts where username = '${username_sql}' and domain is null limit 1;\""
  )
  [ "$(printf "%s" "${result}" | tr -d '[:space:]')" = "1" ]
}

schema_ready() {
  result=$(
    docker compose -f "${COMPOSE_FILE}" exec -T mastodon-db \
      /bin/sh -lc "PGPASSWORD=postgres psql -U postgres -d mastodon_production -tAc \"select to_regclass('public.users') is not null;\"" \
      2>/dev/null || true
  )
  [ "$(printf "%s" "${result}" | tr -d '[:space:]')" = "t" ]
}

ensure_account_approved() {
  docker compose -f "${COMPOSE_FILE}" exec -T mastodon-web-app \
    bin/tootctl accounts modify "${USERNAME}" --approve >/dev/null
}

if ! schema_ready; then
  docker compose -f "${COMPOSE_FILE}" run --rm mastodon-web-app bundle exec rails db:prepare
fi

docker compose -f "${COMPOSE_FILE}" up -d mastodon-web-app mastodon-sidekiq
wait_for_mastodon

if account_exists; then
  ensure_account_approved
  echo "Mastodon account '${USERNAME}' already exists; reusing it."
  exit 0
fi

docker compose -f "${COMPOSE_FILE}" exec -T mastodon-web-app \
  bin/tootctl accounts create "${USERNAME}" \
  --email "${EMAIL}" \
  --confirmed
ensure_account_approved
echo "Created Mastodon account '${USERNAME}'."
