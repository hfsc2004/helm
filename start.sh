#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Pseudo Science Fiction
# PSF Helm — launch the desktop app (helm-ui).
#
# For the CLI surface, run `npm run helm -- <args>` instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d node_modules ]; then
  echo "node_modules not found. Run ./install/RUN_ONCE_MAC_LINUX.sh first."
  exit 1
fi

exec npm run helm-ui
