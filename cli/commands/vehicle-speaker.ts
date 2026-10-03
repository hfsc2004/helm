// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { statSync } from "node:fs";
import { playSpeakerFile } from "../../core/vehicles/speaker.js";
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";

register({
  def: {
    name: "vehicle-speaker-play",
    summary: "Decode an audio file locally and stream 16 kHz stereo PCM to a v1.3 sensor board speaker.",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id or name." },
      { name: "file", kind: "string", required: true, description: "Local MP3 or other ffmpeg-supported audio file." },
    ],
    flags: [
      { name: "base-url", kind: "string", description: "Sensor board diagnostics URL; defaults to camera host on port 82." },
    ],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      2: COMMON_EXIT_CODES[2]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args, flags }) {
    const id = String(args["id"] ?? "").trim();
    const file = String(args["file"] ?? "").trim();
    if (!id || !file) {
      emit({ error: "vehicle-speaker-play requires <id> <file>." });
      return 64;
    }
    const vehicle = registry.get(id) ?? registry.findByName(id);
    if (!vehicle || vehicle.sensorBoardRevision !== "1.3") {
      emit({ error: "A registered v1.3 sensor-board vehicle is required." });
      return 1;
    }
    if (!vehicle.camera && !flags["base-url"]) {
      emit({ error: "No sensor-board address: configure the vehicle camera or pass --base-url." });
      return 1;
    }
    let endpoint: URL;
    try {
      const base = new URL(String(flags["base-url"] ?? vehicle.camera!.baseUrl));
      if (base.protocol !== "http:") throw new Error("HTTP is required");
      if (!flags["base-url"]) base.port = "82";
      endpoint = new URL("/speaker-pcm", base);
      statSync(file);
    } catch (error) {
      emit({ error: error instanceof Error ? error.message : String(error) });
      return 1;
    }
    try {
      const result = await playSpeakerFile(endpoint, file);
      emit({ ok: true, file, ...result });
      return 0;
    } catch (error) {
      emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return 2;
    }
  },
} satisfies RuntimeCommand);
