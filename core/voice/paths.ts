// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { join } from "node:path";

import { paths } from "../paths.js";

/**
 * Every voice-related file in PSF Helm lives under one directory.
 *
 * Uninstall is therefore "stop processes + delete this directory." Nothing
 * voice-related leaks elsewhere. This is the architectural rule that makes
 * voice removal clean and reversible.
 */
export const voicePaths = {
  root: () => join(paths.data, "voice"),
  binaries: () => join(paths.data, "voice", "bin"),
  models: () => join(paths.data, "voice", "models"),
  stateFile: () => join(paths.data, "voice", "state.json"),
};
