// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";

const setAudio: RuntimeCommand = {
  def: {
    name: "vehicle-audio-set",
    summary:
      "Attach a roving-microphone sidecar to a vehicle. Helm plays its PCM stream locally; nothing leaves your LAN.",
    args: [
      {
        name: "id",
        kind: "string",
        required: true,
        description: "Vehicle id (from vehicle-list).",
      },
      {
        name: "baseUrl",
        kind: "string",
        required: true,
        description: 'Audio base URL, e.g. "http://172.20.0.17:82".',
      },
    ],
    flags: [
      {
        name: "stream-path",
        kind: "string",
        default: "/audio",
        description: "Chunked PCM endpoint path.",
      },
    ],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args, flags }) {
    const id = String(args["id"] ?? "").trim();
    const baseUrl = String(args["baseUrl"] ?? "").trim();
    if (!id || !baseUrl) {
      emit({ error: "vehicle-audio-set requires <id> <baseUrl>." });
      return 64;
    }
    const updated = registry.setAudio(id, {
      baseUrl,
      streamPath: String(flags["stream-path"] ?? "/audio"),
    });
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

const clearAudio: RuntimeCommand = {
  def: {
    name: "vehicle-audio-clear",
    summary: "Remove the audio sidecar from a vehicle.",
    args: [
      {
        name: "id",
        kind: "string",
        required: true,
        description: "Vehicle id.",
      },
    ],
    flags: [],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args }) {
    const id = String(args["id"] ?? "").trim();
    if (!id) {
      emit({ error: "vehicle-audio-clear requires <id>." });
      return 64;
    }
    const updated = registry.setAudio(id, null);
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

register(setAudio);
register(clearAudio);
