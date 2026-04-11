#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"
RUNTIME_DIR="${SCRIPT_DIR}/../runtime/gotosocial"
DB_FILE="${RUNTIME_DIR}/sqlite.db"
USERNAME="${AP_INTEROP_GOTOSOCIAL_USERNAME:-interop}"
EMAIL="${AP_INTEROP_GOTOSOCIAL_EMAIL:-interop@gotosocial}"
PASSWORD="${AP_INTEROP_GOTOSOCIAL_PASSWORD:-InteropPassword!123}"
BOOTSTRAP_ATTEMPTS="${AP_INTEROP_GOTOSOCIAL_BOOTSTRAP_ATTEMPTS:-8}"
BOOTSTRAP_INITIAL_DELAY_SECONDS="${AP_INTEROP_GOTOSOCIAL_BOOTSTRAP_INITIAL_DELAY_SECONDS:-1}"
BOOTSTRAP_MAX_DELAY_SECONDS="${AP_INTEROP_GOTOSOCIAL_BOOTSTRAP_MAX_DELAY_SECONDS:-8}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "bootstrap-gotosocial-account.sh requires '$1' to be installed." >&2
    exit 1
  fi
}

run_gotosocial_admin() {
  docker compose -f "${COMPOSE_FILE}" exec -T gotosocial-app \
    /gotosocial/gotosocial \
    --config-path /gotosocial/config.yaml \
    "$@"
}

run_gotosocial_healthcheck() {
  docker compose -f "${COMPOSE_FILE}" exec -T gotosocial-app \
    /bin/sh -lc "wget -qO- http://127.0.0.1:8080/api/v1/instance >/dev/null"
}

escape_sql_string() {
  printf "%s" "$1" | sed "s/'/''/g"
}

wait_for_gotosocial() {
  attempt=1
  delay="${BOOTSTRAP_INITIAL_DELAY_SECONDS}"

  while [ "${attempt}" -le "${BOOTSTRAP_ATTEMPTS}" ]; do
    if run_gotosocial_healthcheck >/dev/null 2>&1 && [ -f "${DB_FILE}" ]; then
      return 0
    fi

    if [ "${attempt}" -eq "${BOOTSTRAP_ATTEMPTS}" ]; then
      break
    fi

    echo "Waiting for GoToSocial admin surface to become ready (attempt ${attempt}/${BOOTSTRAP_ATTEMPTS})..." >&2
    sleep "${delay}"
    attempt=$((attempt + 1))
    if [ "${delay}" -lt "${BOOTSTRAP_MAX_DELAY_SECONDS}" ]; then
      delay=$((delay * 2))
      if [ "${delay}" -gt "${BOOTSTRAP_MAX_DELAY_SECONDS}" ]; then
        delay="${BOOTSTRAP_MAX_DELAY_SECONDS}"
      fi
    fi
  done

  echo "GoToSocial did not become ready in time." >&2
  exit 1
}

account_exists() {
  username_sql=$(escape_sql_string "${USERNAME}")
  result=$(sqlite3 "${DB_FILE}" "select 1 from accounts where username = '${username_sql}' and domain is null limit 1;")
  [ "${result}" = "1" ]
}

ensure_account_created() {
  if account_exists; then
    echo "GoToSocial account '${USERNAME}' already exists; reusing it."
    return 0
  fi

  attempt=1
  delay="${BOOTSTRAP_INITIAL_DELAY_SECONDS}"

  while [ "${attempt}" -le "${BOOTSTRAP_ATTEMPTS}" ]; do
    if run_gotosocial_admin admin account create \
      --username "${USERNAME}" \
      --email "${EMAIL}" \
      --password "${PASSWORD}"; then
      echo "Created GoToSocial account '${USERNAME}'."
      return 0
    fi

    if account_exists; then
      echo "GoToSocial account '${USERNAME}' appeared during create; continuing."
      return 0
    fi

    if [ "${attempt}" -eq "${BOOTSTRAP_ATTEMPTS}" ]; then
      break
    fi

    echo "Retrying GoToSocial account creation for '${USERNAME}' (attempt ${attempt}/${BOOTSTRAP_ATTEMPTS})..." >&2
    sleep "${delay}"
    attempt=$((attempt + 1))
    if [ "${delay}" -lt "${BOOTSTRAP_MAX_DELAY_SECONDS}" ]; then
      delay=$((delay * 2))
      if [ "${delay}" -gt "${BOOTSTRAP_MAX_DELAY_SECONDS}" ]; then
        delay="${BOOTSTRAP_MAX_DELAY_SECONDS}"
      fi
    fi
  done

  echo "Failed to create GoToSocial account '${USERNAME}'." >&2
  exit 1
}

ensure_account_state() {
  username_sql=$(escape_sql_string "${USERNAME}")

  sqlite3 "${DB_FILE}" <<EOF
PRAGMA busy_timeout = 30000;
BEGIN IMMEDIATE;
UPDATE accounts
SET
  locked = 0,
  discoverable = 1,
  indexable = 1,
  updated_at = CURRENT_TIMESTAMP
WHERE username = '${username_sql}' AND domain IS NULL;
UPDATE users
SET
  approved = 1,
  disabled = 0,
  confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP),
  updated_at = CURRENT_TIMESTAMP
WHERE account_id = (
  SELECT id
  FROM accounts
  WHERE username = '${username_sql}' AND domain IS NULL
);
COMMIT;
EOF

  sqlite3 "${DB_FILE}" "
    select
      a.username,
      a.locked,
      a.discoverable,
      a.indexable,
      u.approved,
      u.disabled,
      u.confirmed_at is not null
    from accounts a
    join users u on u.account_id = a.id
    where a.username = '${username_sql}' and a.domain is null;
  "
}

require_command docker
require_command sqlite3
wait_for_gotosocial
ensure_account_created
ensure_account_state
