// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
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
  llm: {
    backend: string;
    inference_location: "local";
    prompts_transmitted: false;
    note: string;
  };
  audio: {
    location: "local-lan";
    transmitted_off_lan: false;
    persisted_to_disk: false;
    note: string;
  };
  /** Loopback servers Helm binds locally so its own surfaces can talk to each other. */
  local_listeners: Array<{
    host: string;
    purpose: string;
    bound_to: "127.0.0.1";
    auth: string;
  }>;
}

export function buildPrivacyPosture(opts: {
  version: string;
  dataPath: string;
}): PrivacyPosture {
  return {
    canary: {
      statement:
        "PSF Helm makes zero outbound network connections except to vehicles on the local network. Four opt-in exceptions: github.com (one-time, only if the user installs voice), ollama.com (one-time, only if the user installs Helm's private Ollama), huggingface.co (per-model, only when the user explicitly downloads a model), and downloads.arduino.cc (one-time, only when the user installs the arduino-cli toolchain). The HF token, if configured, is sent only to huggingface.co and only as Bearer auth.",
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
      {
        host: "ollama.com",
        purpose: "Helm's private Ollama binary install",
        opt_in: true,
        triggered_by: "helm ollama-install (or the UI equivalent)",
      },
      {
        host: "huggingface.co",
        purpose: "Model download (LLM .gguf files). HF token sent only here, only as Bearer auth.",
        opt_in: true,
        triggered_by: "helm model-download <url> (or the UI equivalent)",
      },
      {
        host: "downloads.arduino.cc",
        purpose: "arduino-cli toolchain install (for ESP32/ESP32-S3 firmware compile + upload).",
        opt_in: true,
        triggered_by: "helm toolchain-install --target arduino-cli --confirm (or the UI equivalent)",
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
    llm: {
      backend: "Helm's private Ollama (loopback only)",
      inference_location: "local",
      prompts_transmitted: false,
      note: "Natural-language intents (helm drive ...) are sent only to Helm's private Ollama on 127.0.0.1. Prompts never leave your machine.",
    },
    audio: {
      location: "local-lan",
      transmitted_off_lan: false,
      persisted_to_disk: false,
      note: "When a vehicle has a roving microphone configured, Helm pulls the audio stream over your LAN and plays it locally in the UI. The audio is not transcribed, recorded, or transmitted off your network. Stop listening at any time by clicking pause.",
    },
    local_listeners: [
      {
        host: "127.0.0.1",
        purpose:
          "Helm-UI control plane. Lets the standalone `helm` CLI talk to a running Helm-UI so cross-process consumers (CLI snapshot, future planner) share one upstream connection to the camera firmware. Bound to loopback only — never the LAN.",
        bound_to: "127.0.0.1",
        auth: "Bearer token written to <dataDir>/control-plane.json (mode 0600).",
      },
    ],
  };
}
