import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { VoiceAsset, VoiceInstallState } from "../../shared/voice.js";
import { STORAGE_LIMITS } from "../storage/limits.js";
import { voicePaths } from "./paths.js";

/**
 * Read the current voice install state from disk.
 *
 * "Not installed" returns a well-formed state object with installed=false.
 * Never throws on missing files — absence is a valid state.
 */
export function readVoiceState(): VoiceInstallState {
  const root = voicePaths.root();
  const stateFile = voicePaths.stateFile();

  if (!existsSync(stateFile)) {
    return {
      installed: false,
      declined: false,
      root,
      bytesUsed: 0,
      bytesCap: STORAGE_LIMITS.voiceAssetsBytes,
      assets: [],
    };
  }

  let parsed: { declined?: boolean; assets?: VoiceAsset[] } = {};
  try {
    parsed = JSON.parse(readFileSync(stateFile, "utf8")) as typeof parsed;
  } catch {
    // Treat corrupt state as "not installed" — safer than crashing.
    return {
      installed: false,
      declined: false,
      root,
      bytesUsed: 0,
      bytesCap: STORAGE_LIMITS.voiceAssetsBytes,
      assets: [],
    };
  }

  const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
  const installed = existsSync(voicePaths.binaries()) && assets.length > 0;

  return {
    installed,
    declined: parsed.declined === true,
    root,
    bytesUsed: measureDir(root),
    bytesCap: STORAGE_LIMITS.voiceAssetsBytes,
    assets,
  };
}

function measureDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += measureDir(full);
    } else if (entry.isFile()) {
      total += statSync(full).size;
    }
  }
  return total;
}
