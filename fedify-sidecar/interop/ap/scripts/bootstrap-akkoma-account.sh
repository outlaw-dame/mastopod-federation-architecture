#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"
USERNAME="${AP_INTEROP_AKKOMA_USERNAME:-interop}"
EMAIL="${AP_INTEROP_AKKOMA_EMAIL:-interop@akkoma}"
PASSWORD="${AP_INTEROP_AKKOMA_PASSWORD:-InteropPassword!123}"
RAW_INSTANCE_NAME="${AP_INTEROP_AKKOMA_INSTANCE_NAME:-Akkoma-Interop}"
INSTANCE_NAME=$(printf "%s" "${RAW_INSTANCE_NAME}" | tr ' ' '-')
BOOTSTRAP_ATTEMPTS="${AP_INTEROP_AKKOMA_BOOTSTRAP_ATTEMPTS:-8}"
BOOTSTRAP_INITIAL_DELAY_SECONDS="${AP_INTEROP_AKKOMA_BOOTSTRAP_INITIAL_DELAY_SECONDS:-2}"
BOOTSTRAP_MAX_DELAY_SECONDS="${AP_INTEROP_AKKOMA_BOOTSTRAP_MAX_DELAY_SECONDS:-10}"
CONFIG_PATH="/etc/akkoma/config.exs"
SETUP_SQL_PATH="/etc/akkoma/setup_db.psql"

run_compose() {
  docker compose -f "${COMPOSE_FILE}" --profile akkoma "$@"
}

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

wait_for_akkoma() {
  attempt=1
  delay="${BOOTSTRAP_INITIAL_DELAY_SECONDS}"

  while [ "${attempt}" -le "${BOOTSTRAP_ATTEMPTS}" ]; do
    if run_compose exec -T akkoma-app /bin/sh -lc \
      "wget -qO- http://127.0.0.1:4000/api/v1/instance >/dev/null" >/dev/null 2>&1; then
      return 0
    fi

    if [ "${attempt}" -eq "${BOOTSTRAP_ATTEMPTS}" ]; then
      break
    fi

    echo "Waiting for Akkoma web app to become ready (attempt ${attempt}/${BOOTSTRAP_ATTEMPTS})..." >&2
    sleep "${delay}"
    attempt=$((attempt + 1))
    if [ "${delay}" -lt "${BOOTSTRAP_MAX_DELAY_SECONDS}" ]; then
      delay=$((delay * 2))
      if [ "${delay}" -gt "${BOOTSTRAP_MAX_DELAY_SECONDS}" ]; then
        delay="${BOOTSTRAP_MAX_DELAY_SECONDS}"
      fi
    fi
  done

  echo "Akkoma did not become ready in time." >&2
  exit 1
}

database_exists() {
  result=$(
    run_compose exec -T akkoma-db /bin/sh -lc \
      "PGPASSWORD=postgres psql -U postgres -d postgres -tAc \"select 1 from pg_database where datname = 'akkoma' limit 1;\""
  )
  [ "$(printf "%s" "${result}" | tr -d '[:space:]')" = "1" ]
}

account_exists() {
  nickname_sql=$(printf "%s" "${USERNAME}" | sed "s/'/''/g")
  result=$(
    run_compose exec -T akkoma-db /bin/sh -lc \
      "PGPASSWORD=postgres psql -U postgres -d akkoma -tAc \"select 1 from users where nickname = '${nickname_sql}' limit 1;\""
  )
  [ "$(printf "%s" "${result}" | tr -d '[:space:]')" = "1" ]
}

generate_config_if_needed() {
  if [ -f "${SCRIPT_DIR}/../runtime/akkoma/etc/config.exs" ]; then
    return 0
  fi

  config_path_q=$(shell_quote "${CONFIG_PATH}")
  setup_sql_path_q=$(shell_quote "${SETUP_SQL_PATH}")
  instance_name_q=$(shell_quote "${INSTANCE_NAME}")
  email_q=$(shell_quote "${EMAIL}")

  # PLEROMA_CONFIG_PATH is set by the Dockerfile; do not unset it here or
  # pleroma_ctl will print "Config path is not declared" on every gen run.
  run_compose run --rm akkoma-app /bin/sh -lc "\
    exec /opt/akkoma/bin/pleroma_ctl instance gen \
      --force \
      --output ${config_path_q} \
      --output-psql ${setup_sql_path_q} \
      --domain akkoma \
      --media-url https://akkoma/media \
      --instance-name ${instance_name_q} \
      --admin-email ${email_q} \
      --notify-email ${email_q} \
      --dbhost akkoma-db \
      --dbname akkoma \
      --dbuser akkoma \
      --dbpass akkoma \
      --rum N \
      --indexable N \
      --db-configurable N \
      --uploads-dir /var/lib/akkoma/uploads \
      --static-dir /var/lib/akkoma/static \
      --listen-ip 0.0.0.0 \
      --listen-port 4000 \
      --strip-uploads-metadata N \
      --read-uploads-description N \
      --anonymize-uploads N"

  # tzdata tries to auto-update timezone data and logs repeated permission
  # warnings in the harness environment.  Disable it; the bundled data is fine.
  printf '\n# Harness overrides\nconfig :tzdata, :autoupdate, :disabled\n' \
    >> "${AKKOMA_RUNTIME_DIR}/etc/config.exs"
}

ensure_database() {
  if ! database_exists; then
    run_compose exec -T akkoma-db /bin/sh -lc \
      "PGPASSWORD=postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1" \
      < "${SCRIPT_DIR}/../runtime/akkoma/etc/setup_db.psql"
    return 0
  fi

  run_compose exec -T akkoma-db /bin/sh -lc \
    "PGPASSWORD=postgres psql -U postgres -d akkoma -v ON_ERROR_STOP=1 \
      -c 'CREATE EXTENSION IF NOT EXISTS citext;' \
      -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;' \
      -c 'CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";'"
}

run_migrations() {
  run_compose run --rm akkoma-app /opt/akkoma/bin/pleroma_ctl migrate
}

ensure_account_state() {
  run_compose run --rm akkoma-app /bin/sh -lc \
    "export PLEROMA_CTL_RPC_DISABLED=true; /opt/akkoma/bin/pleroma_ctl user set '${USERNAME}' --confirmed --no-locked" >/dev/null
  run_compose run --rm akkoma-app /bin/sh -lc \
    "export PLEROMA_CTL_RPC_DISABLED=true; /opt/akkoma/bin/pleroma_ctl user activate '${USERNAME}'" >/dev/null 2>&1 || true
}

run_compose up -d akkoma-db
generate_config_if_needed
ensure_database
run_migrations

if account_exists; then
  ensure_account_state
  run_compose up -d akkoma-app
  wait_for_akkoma
  echo "Akkoma account '${USERNAME}' already exists; reusing it."
  exit 0
fi

run_compose run --rm akkoma-app /bin/sh -lc \
  "export PLEROMA_CTL_RPC_DISABLED=true; /opt/akkoma/bin/pleroma_ctl user new '${USERNAME}' '${EMAIL}' \
    --password '${PASSWORD}' \
    --name '${USERNAME}' \
    --admin \
    -y" >/dev/null
ensure_account_state
run_compose up -d akkoma-app
wait_for_akkoma
echo "Created Akkoma account '${USERNAME}'."
