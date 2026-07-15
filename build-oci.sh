#!/usr/bin/env bash
# build-oci.sh — Package and push both metering plugins as OCI images.
#
# Uses the official RHDH CLI workflow:
#   plugin package --tag <image>
#
# This single command handles export (dist-dynamic/) + OCI image build
# using FROM scratch internally, with the correct structure and metadata
# required by RHDH's install-dynamic-plugins init container.
#
# Usage:
#   ./plugins/build-oci.sh [--registry quay.io/myorg] [--tag 0.1.0]
#
# Defaults:
#   --registry  quay.io/edubois10
#   --tag       value of "version" in metering-backend/package.json
#
# Prerequisites:
#   - podman logged in to the target registry (podman login quay.io)
#   - corepack enabled (corepack enable)
#   - The quay.io repositories must be set to PUBLIC so RHDH can pull
#     without cluster-level image pull secrets.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── defaults ─────────────────────────────────────────────────────────────────
REGISTRY="quay.io/edubois10"
TAG=$(node -p "require('${SCRIPT_DIR}/metering-backend/package.json').version")

# ── argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="$2"; shift 2 ;;
    --tag)      TAG="$2";      shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

BACKEND_IMAGE="${REGISTRY}/rhdh-plugin-metering-backend:${TAG}"
FRONTEND_IMAGE="${REGISTRY}/rhdh-plugin-metering:${TAG}"

echo "Registry : ${REGISTRY}"
echo "Tag      : ${TAG}"
echo "Backend  : ${BACKEND_IMAGE}"
echo "Frontend : ${FRONTEND_IMAGE}"
echo ""

# ── Stories 5.1 + 5.3 — package backend (export + build OCI in one step) ─────
echo "==> [5.1/5.3] Packaging metering-backend..."
(
  cd "${SCRIPT_DIR}/metering-backend"
  npx @red-hat-developer-hub/cli@1.10 plugin package \
    --force-export \
    --tag "${BACKEND_IMAGE}"
)
echo ""

# ── Stories 5.2 + 5.3 — package frontend (export + build OCI in one step) ────
echo "==> [5.2/5.3] Packaging metering (frontend)..."
(
  cd "${SCRIPT_DIR}/metering"
  npx @red-hat-developer-hub/cli@1.10 plugin package \
    --force-export \
    --tag "${FRONTEND_IMAGE}"
)
echo ""

# ── Story 5.3 — push OCI images ──────────────────────────────────────────────
echo "==> [5.3] Pushing backend image..."
podman push "${BACKEND_IMAGE}"
echo ""

echo "==> [5.3] Pushing frontend image..."
podman push "${FRONTEND_IMAGE}"
echo ""

echo "==> Done."
echo "    Backend  → ${BACKEND_IMAGE}"
echo "    Frontend → ${FRONTEND_IMAGE}"
echo ""
echo "Ensure both quay.io repositories are set to PUBLIC, then ArgoCD"
echo "will sync dynamic-plugins.yaml and RHDH will pull the images on"
echo "the next pod restart."
