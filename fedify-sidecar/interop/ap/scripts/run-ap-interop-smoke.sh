#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../../.." && pwd)
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.ap-interop.yml"
TARGETS="${AP_INTEROP_TARGETS:-gotosocial mastodon}"

cd "${REPO_ROOT}"

npm exec --prefix fedify-sidecar -- tsc -p fedify-sidecar/tsconfig.json --noEmit
npm exec --prefix fedify-sidecar -- vitest run src/queue/tests/RedisStreamsQueue.test.ts

needs_akkoma_build=0
for target in ${TARGETS}; do
  case "${target}" in
    gotosocial|mastodon)
      ;;
    akkoma)
      needs_akkoma_build=1
      ;;
    *)
      echo "Unsupported AP interop target: ${target}" >&2
      exit 1
      ;;
  esac
done

docker compose -f "${COMPOSE_FILE}" build \
  mock-activitypods fedify-sidecar ap-interop-proof

if [ "${needs_akkoma_build}" = "1" ]; then
  docker compose -f "${COMPOSE_FILE}" --profile akkoma build akkoma-app
fi

for target in ${TARGETS}; do
  case "${target}" in
    gotosocial)
      AP_INTEROP_SKIP_BUILD=1 "${SCRIPT_DIR}/run-gotosocial-proof.sh"
      ;;
    mastodon)
      AP_INTEROP_SKIP_BUILD=1 "${SCRIPT_DIR}/run-mastodon-proof.sh"
      ;;
    akkoma)
      AP_INTEROP_SKIP_BUILD=1 "${SCRIPT_DIR}/run-akkoma-proof.sh"
      ;;
  esac
done
