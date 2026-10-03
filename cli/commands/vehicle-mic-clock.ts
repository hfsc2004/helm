// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";

register({
  def: {
    name: "vehicle-mic-clock",
    summary: "Microphone Data/Clock line Test: hold CLK or weak-pull DATA high/low, read status, or restore capture.",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id or name." },
      { name: "action", kind: "string", required: true, description: "low | high | edges | restore | data-high | data-low | data-float | data-clock | gpio | compare-start | compare-status | trace-start | trace-status | trace-next | trace-abort | activity-start | activity-status | activity-stop | status" },
    ],
    flags: [
      { name: "step", kind: "number", description: "Current trace checkpoint index; required for trace-next." },
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
    const action = String(args["action"] ?? "").trim().toLowerCase();
    if (!id || (!["low", "high", "edges", "restore", "data-high", "data-low", "data-float", "data-clock", "gpio", "compare-start", "compare-status", "trace-start", "trace-status", "trace-next", "trace-abort", "activity-start", "activity-status", "activity-stop", "status"].includes(action))) {
      emit({ error: "vehicle-mic-clock requires <id> <low|high|edges|restore|data-high|data-low|data-float|data-clock|gpio|compare-start|compare-status|trace-start|trace-status|trace-next|trace-abort|activity-start|activity-status|activity-stop|status>." });
      return 64;
    }
    if (action === "trace-next" && (!Number.isInteger(Number(flags["step"])) || Number(flags["step"]) < 0)) {
      emit({ error: "trace-next requires --step with the current checkpoint index." });
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
      endpoint = new URL(action === "restore" ? "/mic-clock-restore" : action.startsWith("activity-") ? (action === "activity-stop" ? "/mic-data-activity-stop" : "/mic-data-activity") : action.startsWith("trace-") ? (action === "trace-next" ? "/mic-restore-trace-next" : action === "trace-abort" ? "/mic-restore-trace-abort" : "/mic-restore-trace") : action.startsWith("compare-") ? "/mic-rx-comparison" : action === "gpio" ? "/mic-gpio" : action === "status" ? "/mic-line-hold" : action.startsWith("data-") ? `/mic-${action}` : `/mic-clock-${action}`, base);
      if (action === "trace-next") endpoint.searchParams.set("step", String(flags["step"]));
    } catch (error) {
      emit({ error: error instanceof Error ? error.message : String(error) });
      return 1;
    }
    try {
      const response = await fetch(endpoint, { method: action === "edges" || action === "status" || action === "gpio" || action === "compare-status" || action === "trace-status" || action === "activity-status" ? "GET" : "POST", signal: AbortSignal.timeout(action.startsWith("activity-") ? 20000 : 5000) });
      const body = await response.json() as Record<string, unknown>;
      emit({ action, ...body });
      return response.ok && body.ok === true ? 0 : 1;
    } catch (error) {
      emit({ ok: false, action, error: error instanceof Error ? error.message : String(error) });
      return 2;
    }
  },
} satisfies RuntimeCommand);
