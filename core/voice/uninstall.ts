// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { existsSync, rmSync } from "node:fs";

import type { VoiceInstallState } from "../../shared/voice.js";
import { STORAGE_LIMITS } from "../storage/limits.js";
import { voicePaths } from "./paths.js";
import { readVoiceState } from "./state.js";

export interface UninstallResult {
  removed: boolean;
  freedBytes: number;
  state: VoiceInstallState;
}

/**
 * Remove voice entirely.
 *
 * Stops nothing for v0.1 (no engines spawn yet); the real implementation will
 * terminate child processes first. For now this is a clean directory delete.
 */
export async function uninstallVoice(): Promise<UninstallResult> {
  const before = readVoiceState();
  const root = voicePaths.root();

  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
  }

  const state: VoiceInstallState = {
    installed: false,
    declined: before.declined,
    root,
    bytesUsed: 0,
    bytesCap: STORAGE_LIMITS.voiceAssetsBytes,
    assets: [],
  };

  return {
    removed: before.installed,
    freedBytes: before.bytesUsed,
    state,
  };
}
