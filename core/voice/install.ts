// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import type { VoiceInstallState } from "../../shared/voice.js";

/**
 * Install whisper.cpp + piper binaries and the default model set.
 *
 * Stubbed for v0.1: the real implementation will fetch from Helm's GitHub
 * releases, verify checksums, extract under voicePaths.binaries() and
 * voicePaths.models(), and write a state.json declaring what's installed.
 */
export async function installVoice(): Promise<VoiceInstallState> {
  throw new Error(
    "voice install not implemented yet — v0.1 scaffolds the surface; the fetcher lands in v0.2"
  );
}
