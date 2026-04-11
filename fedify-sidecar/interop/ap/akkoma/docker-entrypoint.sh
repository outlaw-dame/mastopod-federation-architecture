#!/bin/sh
set -eu

mkdir -p /var/lib/akkoma/uploads /var/lib/akkoma/static /var/lib/akkoma/modules /etc/akkoma
chown -R akkoma:akkoma /opt/akkoma /etc/akkoma /var/lib/akkoma

if [ -f /interop/runtime/certs/rootCA.crt ]; then
  install -m 0644 /interop/runtime/certs/rootCA.crt /usr/local/share/ca-certificates/ap-interop-rootCA.crt
  update-ca-certificates >/dev/null 2>&1 || true
fi

if [ "${AKKOMA_WAIT_FOR_DB:-1}" = "1" ] && [ -n "${DB_HOST:-}" ]; then
  echo "-- Waiting for database..."
  until pg_isready -h "${DB_HOST}" -U "${DB_ADMIN_USER:-postgres}" -d "${DB_ADMIN_NAME:-postgres}" -t 1 >/dev/null 2>&1; do
    sleep 1
  done
fi

exec su-exec akkoma "$@"
