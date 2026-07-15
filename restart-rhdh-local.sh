#!/usr/bin/env bash
# restart-rhdh-local.sh — Export plugins and restart rhdh-local without the
# hot-reload race condition.
#
# The race condition:
#   If RHDH is running when install-dynamic-plugins writes to the volume,
#   RHDH's file watcher fires a hot-reload that corrupts the frontend plugin
#   registration (the Metering tab disappears, etc.).
#
# The fix:
#   1. Export updated plugins to local-plugins/ (build only, no RHDH touch)
#   2. podman compose down  → stops ALL services cleanly, no more file watchers
#   3. podman volume rm     → clears the dynamic-plugins-root volume so the
#                             next install-dynamic-plugins starts from scratch
#   4. podman compose up -d → compose honours the service_completed_successfully
#                             dependency: install-dynamic-plugins runs first,
#                             finishes, THEN rhdh starts — no race condition
#
# Usage:
#   ./plugins/restart-rhdh-local.sh            # export + full restart
#   ./plugins/restart-rhdh-local.sh --no-export  # skip export, just restart

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RHDH_LOCAL="${SCRIPT_DIR}/../rhdh-local"
EXPORT=true

for arg in "$@"; do
  [[ "$arg" == "--no-export" ]] && EXPORT=false
done

if $EXPORT; then
  echo "==> Exporting plugins to rhdh-local..."
  "${SCRIPT_DIR}/export-dev.sh"
  echo ""
fi

echo "==> Stopping all rhdh-local services..."
(cd "${RHDH_LOCAL}" && podman compose down 2>/dev/null || true)

echo "==> Clearing dynamic-plugins-root volume..."
podman volume rm rhdh-local_dynamic-plugins-root 2>/dev/null || true

echo "==> Starting rhdh-local (install-dynamic-plugins will run before rhdh)..."
(cd "${RHDH_LOCAL}" && podman compose up -d)

echo ""
echo "==> Done. RHDH is starting up."
echo "    Watch logs: podman logs rhdh -f"
