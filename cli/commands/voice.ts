// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import { readVoiceState } from "../../core/voice/state.js";
import { uninstallVoice } from "../../core/voice/uninstall.js";
import { installVoice } from "../../core/voice/install.js";

const status: RuntimeCommand = {
  def: {
    name: "voice-status",
    summary: "Report whether voice (STT/TTS) is installed and how much space it uses.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    emit({ ...readVoiceState() });
    return 0;
  },
};

const install: RuntimeCommand = {
  def: {
    name: "voice-install",
    summary: "Download whisper.cpp + piper and the default voice model set.",
    args: [],
    flags: [
      {
        name: "confirm",
        kind: "boolean",
        default: false,
        description: "Required. Downloads ~300 MB the first time.",
      },
    ],
    streams: true,
    events: [
      { event: "plan", description: "Asset list and total size to download." },
      { event: "download", description: "Per-asset download progress." },
      { event: "verify", description: "Per-asset checksum verification." },
      { event: "complete", description: "Final installed state." },
    ],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ flags }) {
    if (flags["confirm"] !== true) {
      emit({
        error: "voice-install is a network operation. Re-run with --confirm.",
      });
      return 64;
    }
    try {
      const state = await installVoice();
      emit({ event: "complete", state });
      return 0;
    } catch (err) {
      emit({
        event: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return 1;
    }
  },
};

const uninstall: RuntimeCommand = {
  def: {
    name: "voice-uninstall",
    summary: "Remove all voice binaries and models. Safe; reinstallable.",
    args: [],
    flags: [
      {
        name: "confirm",
        kind: "boolean",
        default: false,
        description: "Required. Deletes ~/.local/share/psf-helm/voice/.",
      },
    ],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ flags }) {
    if (flags["confirm"] !== true) {
      const state = readVoiceState();
      emit({
        error: "voice-uninstall removes files. Re-run with --confirm.",
        wouldFreeBytes: state.bytesUsed,
      });
      return 64;
    }
    const result = await uninstallVoice();
    emit(result);
    return 0;
  },
};

register(status);
register(install);
register(uninstall);
