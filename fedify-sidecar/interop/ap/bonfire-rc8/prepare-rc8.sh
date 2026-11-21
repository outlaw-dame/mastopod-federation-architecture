#!/usr/bin/env bash
set -euo pipefail
# GitHub's immutable RC8 release archive is SHA-256 checked before any
# container build. This fixture is isolated from production services.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
URL='https://github.com/bonfire-networks/bonfire-app/releases/download/v1.1.0-rc.8/bonfire-community-amd64-debian-bookworm.tar.gz'
SHA='3b1630f0f59105b378d0bd47e8e096d8ac96dd58a5d758e99003e4ce7dfb5ed5'
mkdir -p "$SCRIPT_DIR/runtime"
archive="$SCRIPT_DIR/runtime/bonfire-community-rc8.tar.gz"
if [ ! -f "$archive" ]; then
  curl --fail --location --silent --show-error \
    --retry 3 --retry-all-errors --connect-timeout 15 --max-time 900 \
    "$URL" -o "$archive.tmp"
  mv "$archive.tmp" "$archive"
fi
if ! printf '%s  %s\n' "$SHA" "$archive" | sha256sum -c -; then
  rm -f "$archive"
  exit 1
fi
mkdir -p "$SCRIPT_DIR/release"
# Always expand a clean build context; a stale previous version could ship
# incompatible files. No user data or secrets exist in this fixture directory.
find "$SCRIPT_DIR/release" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
tar -xzf "$archive" -C "$SCRIPT_DIR/release" --strip-components=1 \
  --no-same-owner --no-same-permissions
test -x "$SCRIPT_DIR/release/bin/bonfire"
echo 'bonfire_community_rc8_release_digest_verified'
