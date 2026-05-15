#!/usr/bin/env bash
# PSF Helm — one-time dependency installer (Linux / macOS)
#
# Run this once after cloning the repo, or any time package.json changes.
# Re-running is safe; npm will reconcile.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "=============================================="
echo "  PSF Helm — one-time setup (Linux / macOS)"
echo "=============================================="
echo ""

# ---- Node check ----
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed or not on PATH."
  echo "  Install Node.js LTS from https://nodejs.org/ and re-run this script."
  exit 1
fi

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')"
echo "Node.js: $NODE_VERSION"

if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "WARNING: Node $NODE_VERSION detected; PSF Helm targets Node 20 LTS or newer."
  echo "         The install may succeed, but please upgrade when possible."
  echo ""
fi

# ---- npm check ----
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not installed or not on PATH."
  echo "  npm normally ships with Node.js; check your Node.js install."
  exit 1
fi

echo "npm:     $(npm --version)"
echo "Repo:    $REPO_ROOT"
echo ""

# ---- Install ----
cd "$REPO_ROOT"

echo "Installing dependencies (this may take several minutes on the first run)..."
echo ""
npm install

echo ""
echo "=============================================="
echo "  Setup complete."
echo ""
echo "  Start the app in dev mode with:"
echo "    npm run dev"
echo "=============================================="
echo ""
