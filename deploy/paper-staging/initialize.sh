#!/bin/sh
set -eu
# Docker sources non-executable init scripts as postgres. Runtime secret is
# copied by database.sh to a postgres-owned temporary path before startup.
psql -U entryway_admin -d entryway_control_plane -v ON_ERROR_STOP=1 -f /staging/schema.sql
ENTRYWAY_PASSWORD=$(cat /run/entryway-tls/runtime-password)
export ENTRYWAY_PASSWORD
psql -U entryway_admin -d entryway_control_plane -v ON_ERROR_STOP=1 <<'SQL'
\getenv runtime_password ENTRYWAY_PASSWORD
CREATE ROLE entryway_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';
GRANT paper_entryway_runtime TO entryway_runtime;
REVOKE ALL ON DATABASE entryway_control_plane FROM PUBLIC;
GRANT CONNECT ON DATABASE entryway_control_plane TO entryway_runtime;
SQL
unset ENTRYWAY_PASSWORD
