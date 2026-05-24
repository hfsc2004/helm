// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
/**
 * Voice subsystem types, shared across processes.
 *
 * Voice in PSF Helm is optional. The user opts in (first-run wizard or
 * settings), Helm downloads engine binaries + a default model set from its
 * own GitHub releases, and stores everything under one local folder.
 *
 * "Not installed" is a fully supported state — UI gates the mic, CLI reports
 * status truthfully, nothing else breaks.
 */

export type VoiceEngine = "whisper.cpp" | "piper";

export interface VoiceAsset {
  engine: VoiceEngine;
  kind: "binary" | "model";
  name: string;
  /** Bytes on disk after install. */
  size: number;
  /** Where it lives, relative to the voice root. */
  path: string;
}

export interface VoiceInstallState {
  installed: boolean;
  /** Set when the user has explicitly declined; suppresses re-prompts. */
  declined: boolean;
  /** Absolute path to the voice root (~/.local/share/psf-helm/voice). */
  root: string;
  /** Total bytes currently used under the voice root. */
  bytesUsed: number;
  /** Hard cap from STORAGE_LIMITS.voiceAssetsBytes. */
  bytesCap: number;
  assets: VoiceAsset[];
}
