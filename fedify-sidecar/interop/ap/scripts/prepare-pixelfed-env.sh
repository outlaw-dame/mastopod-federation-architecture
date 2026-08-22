#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="${SCRIPT_DIR}/../runtime/pixelfed.env"

: "${PIXELFED_DB_PASSWORD:?PIXELFED_DB_PASSWORD is required}"
: "${PIXELFED_DB_ROOT_PASSWORD:?PIXELFED_DB_ROOT_PASSWORD is required}"
: "${PIXELFED_APP_KEY:?PIXELFED_APP_KEY is required}"

umask 077
cat > "${ENV_FILE}" <<EOF
APP_NAME=Pixelfed
APP_ENV=production
APP_KEY=${PIXELFED_APP_KEY}
APP_DEBUG=false
APP_URL=https://pixelfed.test
APP_DOMAIN=pixelfed.test
ADMIN_DOMAIN=pixelfed.test
SESSION_DOMAIN=pixelfed.test
TRUST_PROXIES=*
OPEN_REGISTRATION=false
ENFORCE_EMAIL_VERIFICATION=false
DB_CONNECTION=mysql
DB_HOST=pixelfed-db
DB_PORT=3306
DB_DATABASE=pixelfed
DB_USERNAME=pixelfed
DB_PASSWORD=${PIXELFED_DB_PASSWORD}
REDIS_CLIENT=phpredis
REDIS_SCHEME=tcp
REDIS_HOST=pixelfed-redis
REDIS_PASSWORD=null
REDIS_PORT=6379
SESSION_DRIVER=database
CACHE_DRIVER=redis
QUEUE_DRIVER=redis
BROADCAST_DRIVER=log
LOG_CHANNEL=stderr
ACTIVITY_PUB=true
AP_REMOTE_FOLLOW=true
AP_INBOX=true
AP_OUTBOX=true
AP_SHAREDINBOX=true
PF_SECURITY_URL_VERIFY_DNS=false
MAIL_DRIVER=log
MAIL_FROM_ADDRESS=interop@pixelfed.test
MAIL_FROM_NAME=Pixelfed
EOF

chmod 600 "${ENV_FILE}"
printf '%s\n' "Prepared ephemeral Pixelfed environment at ${ENV_FILE}"
