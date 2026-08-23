#!/usr/bin/env bash
set -euo pipefail

IMAGE=${PIXELFED_IMAGE:?PIXELFED_IMAGE is required}
CONTEXT=${AP_INTEROP_PIXELFED_CONTEXT:-pixelfed}
MAX_ATTEMPTS=${AP_INTEROP_BUILD_MAX_ATTEMPTS:-3}

if [[ ! "${MAX_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]] || (( MAX_ATTEMPTS > 5 )); then
  echo "AP_INTEROP_BUILD_MAX_ATTEMPTS must be an integer from 1 through 5" >&2
  exit 2
fi
if [[ ! -d "${CONTEXT}" ]] || [[ ! -f "${CONTEXT}/Dockerfile" ]]; then
  echo "Pixelfed build context does not contain a Dockerfile: ${CONTEXT}" >&2
  exit 2
fi

attempt=1
while ! docker build --tag "${IMAGE}" "${CONTEXT}"; do
  if (( attempt >= MAX_ATTEMPTS )); then
    echo "Pixelfed fixture image build failed after ${attempt} attempts" >&2
    exit 1
  fi

  # Pixelfed's upstream image downloads PECL archives during its extension
  # layer. Failed layers are not cached, so retrying re-downloads the archive.
  delay=$((5 * (2 ** (attempt - 1))))
  echo "Pixelfed fixture image build attempt ${attempt} failed; retrying in ${delay}s" >&2
  sleep "${delay}"
  attempt=$((attempt + 1))
done

docker image inspect "${IMAGE}" >/dev/null
