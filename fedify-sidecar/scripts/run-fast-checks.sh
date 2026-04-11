#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SIDECAR_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)

cd "${SIDECAR_ROOT}"

npm exec -- tsc -p tsconfig.json --noEmit
npm exec -- vitest run \
  src/queue/tests/RedisStreamsQueue.test.ts \
  src/federation/tests/FedifyFastifyBridge.test.ts \
  src/delivery/tests/FederationRuntimeAdapterParity.test.ts \
  src/signing/tests/ActivityPubHttpSignatureGoldenVectors.test.ts
