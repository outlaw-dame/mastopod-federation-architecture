#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_DIR="${SCRIPT_DIR}/../runtime/certs"
CA_KEY="${RUNTIME_DIR}/rootCA.key"
CA_CERT="${RUNTIME_DIR}/rootCA.crt"

mkdir -p "${RUNTIME_DIR}"

if [ ! -f "${CA_KEY}" ] || [ ! -f "${CA_CERT}" ]; then
  openssl genrsa -out "${CA_KEY}" 4096 >/dev/null 2>&1
  openssl req -x509 -new -nodes -key "${CA_KEY}" -sha256 -days 3650 \
    -subj "/CN=AP Interop Harness Root CA" \
    -out "${CA_CERT}" >/dev/null 2>&1
fi

for host in sidecar gotosocial mastodon akkoma; do
  key_path="${RUNTIME_DIR}/${host}.key"
  csr_path="${RUNTIME_DIR}/${host}.csr"
  crt_path="${RUNTIME_DIR}/${host}.crt"
  ext_path="${RUNTIME_DIR}/${host}.ext"

  if [ ! -f "${key_path}" ] || [ ! -f "${crt_path}" ]; then
    openssl genrsa -out "${key_path}" 2048 >/dev/null 2>&1
    openssl req -new -key "${key_path}" \
      -subj "/CN=${host}" \
      -out "${csr_path}" >/dev/null 2>&1
    cat > "${ext_path}" <<EOF
subjectAltName = DNS:${host}
extendedKeyUsage = serverAuth
keyUsage = digitalSignature, keyEncipherment
EOF
    openssl x509 -req -in "${csr_path}" \
      -CA "${CA_CERT}" -CAkey "${CA_KEY}" -CAcreateserial \
      -out "${crt_path}" -days 825 -sha256 -extfile "${ext_path}" >/dev/null 2>&1
  fi
done

echo "Generated AP interop harness certificates in ${RUNTIME_DIR}"
