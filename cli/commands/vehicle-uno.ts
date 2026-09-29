// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";

const actions = ["status", "ultrasonic", "line", "servo", "motor", "stop", "rgb-off", "baud", "pins"] as const;

register({
  def: {
    name: "vehicle-uno",
    summary: "Probe or test the ELEGOO Uno UART behind a v1.3 sensor board.",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id or name." },
      { name: "action", kind: "string", required: true, description: actions.join(" | ") },
    ],
    flags: [
      { name: "direction", kind: "string", description: "motor: left | right | forward | reverse." },
      { name: "speed", kind: "number", description: "motor: 0..160 PWM." },
      { name: "ms", kind: "number", description: "motor: bounded pulse, 100..800 ms." },
      { name: "angle", kind: "number", description: "servo: D10 10..170 or D11 30..110 degrees." },
      { name: "channel", kind: "number", description: "servo: channel 1 (D10) or 2 (D11); default 1." },
      { name: "baud", kind: "number", description: "baud: 9600 | 19200 | 38400 | 57600 | 115200." },
      { name: "rx", kind: "number", description: "pins: ESP32 receive pin, 43 or 44." },
      { name: "tx", kind: "number", description: "pins: ESP32 transmit pin, the other of 43 or 44." },
      { name: "base-url", kind: "string", description: "Diagnostics URL; defaults to the registered camera host on port 82." },
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
    const id = String(args.id ?? "").trim();
    const action = String(args.action ?? "").trim().toLowerCase();
    if (!id || !actions.includes(action as typeof actions[number])) {
      emit({ error: `vehicle-uno requires <id> <${actions.join("|")}>.` });
      return 64;
    }
    const vehicle = registry.get(id) ?? registry.findByName(id);
    if (!vehicle || vehicle.sensorBoardRevision !== "1.3") {
      emit({ error: "A registered v1.3 sensor-board vehicle is required." });
      return 1;
    }
    if (!vehicle.camera && !flags["base-url"]) {
      emit({ error: "No sensor-board address: configure the camera or pass --base-url." });
      return 1;
    }
    const pathByAction: Record<string, string> = {
      status: "/uno/status", ultrasonic: "/uno/ultrasonic", line: "/uno/line",
      servo: "/uno/servo", motor: "/uno/motor-pulse", stop: "/uno/stop",
      "rgb-off": "/uno/rgb-off", baud: "/uno/baud", pins: "/uno/pins",
    };
    let url: URL;
    try {
      const base = new URL(String(flags["base-url"] ?? vehicle.camera!.baseUrl));
      if (base.protocol !== "http:") throw new Error("HTTP is required");
      if (!flags["base-url"]) base.port = "82";
      url = new URL(pathByAction[action]!, base);
    } catch (error) {
      emit({ error: error instanceof Error ? error.message : String(error) });
      return 1;
    }
    if (action === "motor") {
      const direction = String(flags.direction ?? "");
      const speed = Number(flags.speed);
      const ms = Number(flags.ms);
      if (!["left", "right", "forward", "reverse"].includes(direction) ||
          !Number.isInteger(speed) || speed < 0 || speed > 160 ||
          !Number.isInteger(ms) || ms < 100 || ms > 800) {
        emit({ error: "motor requires --direction left|right|forward|reverse --speed 0..160 --ms 100..800." });
        return 64;
      }
      url.searchParams.set("direction", direction);
      url.searchParams.set("speed", String(speed));
      url.searchParams.set("ms", String(ms));
    } else if (action === "servo") {
      const angle = Number(flags.angle);
      const channel = flags.channel === undefined ? 1 : Number(flags.channel);
      const minimum = channel === 2 ? 30 : 10;
      const maximum = channel === 2 ? 110 : 170;
      if (![1, 2].includes(channel) || !Number.isInteger(angle) || angle < minimum || angle > maximum) {
        emit({ error: "servo requires --channel 1 --angle 10..170 or --channel 2 --angle 30..110." });
        return 64;
      }
      url.searchParams.set("angle", String(angle));
      url.searchParams.set("channel", String(channel));
    } else if (action === "baud") {
      const baud = Number(flags.baud);
      if (![9600, 19200, 38400, 57600, 115200].includes(baud)) {
        emit({ error: "baud requires --baud 9600|19200|38400|57600|115200." });
        return 64;
      }
      url.searchParams.set("baud", String(baud));
    } else if (action === "pins") {
      const rx = Number(flags.rx);
      const tx = Number(flags.tx);
      if (!((rx === 43 && tx === 44) || (rx === 44 && tx === 43))) {
        emit({ error: "pins requires --rx 43 --tx 44 or --rx 44 --tx 43." });
        return 64;
      }
      url.searchParams.set("rx", String(rx));
      url.searchParams.set("tx", String(tx));
    }
    try {
      if (action === "servo") {
        const status = await fetch(new URL("/uno/status", url), { signal: AbortSignal.timeout(2500) });
        const statusBody = await status.json() as Record<string, unknown>;
        if (!status.ok || statusBody.servoCommandVersion !== 2) {
          emit({ ok: false, action, error: "servo command requires updated ESP32-S3 firmware" });
          return 1;
        }
      }
      const method = ["status", "ultrasonic", "line"].includes(action) ? "GET" : "POST";
      const ms = action === "motor" ? Number(flags.ms) : 0;
      const response = await fetch(url, { method, signal: AbortSignal.timeout(ms + 2500) });
      const body = await response.json() as Record<string, unknown>;
      emit({ action, ...body });
      return response.ok && body.ok === true ? 0 : 1;
    } catch (error) {
      emit({ ok: false, action, error: error instanceof Error ? error.message : String(error) });
      return 2;
    }
  },
} satisfies RuntimeCommand);
