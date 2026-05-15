/**
 * PSF Helm privacy posture, machine-readable.
 *
 * If this module ever has to change to allow an outbound destination, the
 * canary in README.md changes at the same time. This module is the source
 * of truth for `helm privacy`.
 */

export interface PrivacyPosture {
  canary: {
    statement: string;
    last_affirmed: string;
    version_affirmed: string;
  };
  outbound_destinations: Array<{
    host: string;
    purpose: string;
    opt_in: boolean;
    triggered_by: string;
  }>;
  data_collected: string[];
  user_tracking: false;
  cloud_dependencies: string[];
  data_stored_locally: string[];
  data_storage_path: string;
  voice: {
    stt_engine: string;
    tts_engine: string;
    audio_transmitted: false;
    note: string;
  };
}

export function buildPrivacyPosture(opts: {
  version: string;
  dataPath: string;
}): PrivacyPosture {
  return {
    canary: {
      statement:
        "PSF Helm makes zero outbound network connections except to vehicles on the local network, and — only when the user explicitly opts in to voice — to github.com to fetch whisper.cpp + piper engine binaries during a one-time install.",
      last_affirmed: "2026-05-15",
      version_affirmed: opts.version,
    },
    outbound_destinations: [
      {
        host: "github.com",
        purpose: "voice engine install/upgrade",
        opt_in: true,
        triggered_by: "helm voice install (or the UI equivalent)",
      },
    ],
    data_collected: [],
    user_tracking: false,
    cloud_dependencies: [],
    data_stored_locally: [
      "vehicle-state",
      "command-history",
      "vehicle-registry",
      "traces",
      "errors",
    ],
    data_storage_path: opts.dataPath,
    voice: {
      stt_engine: "whisper.cpp (local)",
      tts_engine: "piper (local)",
      audio_transmitted: false,
      note: "Speech is transcribed on your machine and discarded after the command is executed.",
    },
  };
}
