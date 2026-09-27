// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";

register({
  def: {
    name: "vehicle-tof-mode",
    summary: "Read or change v1.3 single-zone ToF distance modes at runtime. Auto retries another mode after persistent invalid returns.",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id or name." },
      { name: "mode", kind: "string", required: true, description: "status | auto | short | medium | long" },
    ],
    flags: [
      { name: "sensor", kind: "string", default: "both", description: "front | rear | both (for mode changes)." },
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
    const mode = String(args["mode"] ?? "").trim().toLowerCase();
    const sensor = String(flags["sensor"] ?? "both").trim().toLowerCase();
    if (!id || !["status", "auto", "short", "medium", "long"].includes(mode) ||
        !["front", "rear", "both"].includes(sensor)) {
      emit({ error: "vehicle-tof-mode requires <id> <status|auto|short|medium|long> [--sensor front|rear|both]." });
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
      endpoint = new URL("/tof-mode", base);
      if (mode !== "status") {
        endpoint.searchParams.set("sensor", sensor);
        endpoint.searchParams.set("mode", mode);
      }
    } catch (error) {
      emit({ error: error instanceof Error ? error.message : String(error) });
      return 1;
    }
    try {
      const response = await fetch(endpoint, {
        method: mode === "status" ? "GET" : "POST",
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json() as Record<string, unknown>;
      emit(body);
      return response.ok && body.ok === true ? 0 : 1;
    } catch (error) {
      emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return 2;
    }
  },
} satisfies RuntimeCommand);
