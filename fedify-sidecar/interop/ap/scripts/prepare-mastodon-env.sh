#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_DIR="${SCRIPT_DIR}/../runtime"
ENV_FILE="${RUNTIME_DIR}/mastodon.env"

mkdir -p "${RUNTIME_DIR}"

random_hex() {
  openssl rand -hex "$1"
}

random_alnum_32() {
  openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32
}

generate_vapid_keys() {
  node <<'EOF'
const { generateKeyPairSync } = require("node:crypto");

function decodeBase64Url(value) {
  const padding = (4 - (value.length % 4)) % 4;
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding), "base64");
}

function encodeBase64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  publicKeyEncoding: { format: "jwk" },
  privateKeyEncoding: { format: "jwk" },
});

const publicPoint = Buffer.concat([
  Buffer.from([0x04]),
  decodeBase64Url(publicKey.x),
  decodeBase64Url(publicKey.y),
]);

process.stdout.write(`${privateKey.d}\n${encodeBase64Url(publicPoint)}\n`);
EOF
}

VAPID_KEYS=$(generate_vapid_keys)
MASTODON_VAPID_PRIVATE_KEY=$(printf "%s" "${VAPID_KEYS}" | sed -n '1p')
MASTODON_VAPID_PUBLIC_KEY=$(printf "%s" "${VAPID_KEYS}" | sed -n '2p')
ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=$(random_alnum_32)
ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=$(random_alnum_32)
ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=$(random_alnum_32)

cat > "${ENV_FILE}" <<EOF
MASTODON_SECRET_KEY_BASE=$(random_hex 64)
MASTODON_OTP_SECRET=$(random_hex 32)
MASTODON_VAPID_PRIVATE_KEY=${MASTODON_VAPID_PRIVATE_KEY}
MASTODON_VAPID_PUBLIC_KEY=${MASTODON_VAPID_PUBLIC_KEY}
ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=${ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY}
ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=${ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT}
ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=${ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY}
EOF

echo "Wrote ${ENV_FILE}"
echo "Use it with:"
echo "  set -a; . ${ENV_FILE}; set +a"
echo "  docker compose -f ${SCRIPT_DIR}/../docker-compose.ap-interop.yml --profile mastodon up -d"
