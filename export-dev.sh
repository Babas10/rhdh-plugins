#!/usr/bin/env bash
# export-dev.sh — rebuild and re-export both metering plugins into rhdh-local/local-plugins/
# Usage: ./export-dev.sh [--rhdh-local-path <path>]
# Default rhdh-local path: ../rhdh-local (sibling of rhdh-plugins)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RHDH_LOCAL="${1:-$(realpath "${SCRIPT_DIR}/../rhdh-local")}"
LOCAL_PLUGINS="${RHDH_LOCAL}/local-plugins"

echo "==> Exporting to: ${LOCAL_PLUGINS}"

for plugin in metering-backend metering; do
  echo ""
  echo "==> Building type declarations for ${plugin}..."
  (cd "${SCRIPT_DIR}/${plugin}" && yarn build:types)

  echo "==> Exporting ${plugin} to ${LOCAL_PLUGINS}..."
  (cd "${SCRIPT_DIR}/${plugin}" && \
    npx @red-hat-developer-hub/cli@1.10 plugin export \
      --dev \
      --dynamic-plugins-root "${LOCAL_PLUGINS}" \
      --clean)
done

echo ""
echo "==> Done. Restart rhdh-local to pick up changes:"
echo "    cd ${RHDH_LOCAL}"
echo "    podman compose run install-dynamic-plugins"
echo "    podman compose up rhdh"
