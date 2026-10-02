// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";
import { configureWideTof, readWideTof } from "../../core/vehicles/wide-tof.js";
import { isWideTofProfile } from "../../shared/wide-tof.js";

register({
  def: {
    name: "vehicle-wide-tof",
    summary: "Inspect SR Front VL53L5CX data or select detail/navigation/fast/idle/inspect profiles and 4×4/8×8 grids.",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id or name." },
      { name: "mode", kind: "string", required: true, description: "status | frame | detail | navigation | fast | idle | inspect | 4x4 | 8x8" },
    ],
    flags: [
      { name: "base-url", kind: "string", description: "Diagnostics URL; defaults to camera host on port 82." },
      { name: "hz", kind: "number", description: "Requested Hz: detail 10; navigation 10–15; fast 30–60; idle 1–2; inspect 5–10." },
    ],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]!, 1: COMMON_EXIT_CODES[1]!, 2: COMMON_EXIT_CODES[2]!, 64: COMMON_EXIT_CODES[64]! },
  },
  async run({ args, flags }) {
    const id = String(args["id"] ?? "").trim();
    const rawMode = String(args["mode"] ?? "").toLowerCase();
    const mode = rawMode === "4x4" ? "fast" : rawMode === "8x8" ? "detail" : rawMode;
    if (!id || (mode !== "status" && mode !== "frame" && !isWideTofProfile(mode)) ||
        ((mode === "status" || mode === "frame") && flags["hz"] !== undefined)) {
      emit({ error: "Use <id> <status|frame|detail|navigation|fast|idle|inspect|4x4|8x8> [--hz N]." });
      return 64;
    }
    const vehicle = registry.get(id) ?? registry.findByName(id);
    if (!vehicle) { emit({ error: "Vehicle not found." }); return 1; }
    try {
      if (mode === "frame") {
        const result = await readWideTof(vehicle, flags["base-url"] ? String(flags["base-url"]) : undefined);
        emit(result);
        return result.ok ? 0 : 1;
      }
      const result = await configureWideTof(vehicle,
        mode === "status" ? undefined : mode,
        flags["base-url"] ? String(flags["base-url"]) : undefined,
        flags["hz"] === undefined ? undefined : Number(flags["hz"]));
      emit(result);
      return result.ok ? 0 : 1;
    } catch (error) {
      emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return 2;
    }
  },
} satisfies RuntimeCommand);
