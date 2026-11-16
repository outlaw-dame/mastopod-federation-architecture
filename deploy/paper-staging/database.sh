#!/bin/sh
set -eu
# Copy to a container-local path: never loosen host private-key permissions.
mkdir -p /run/entryway-tls
cp /staging-certs/server.key /run/entryway-tls/server.key
cp /staging-certs/server.crt /run/entryway-tls/server.crt
cp /run/staging-secrets/admin /run/entryway-tls/admin-password
cp /run/staging-secrets/runtime /run/entryway-tls/runtime-password
chown -R postgres:postgres /run/entryway-tls
chmod 700 /run/entryway-tls
chmod 600 /run/entryway-tls/server.key /run/entryway-tls/*-password
export POSTGRES_PASSWORD_FILE=/run/entryway-tls/admin-password
exec /usr/local/bin/docker-entrypoint.sh postgres \
  -c ssl=on -c ssl_cert_file=/run/entryway-tls/server.crt \
  -c ssl_key_file=/run/entryway-tls/server.key -c hba_file=/staging/pg_hba.conf
