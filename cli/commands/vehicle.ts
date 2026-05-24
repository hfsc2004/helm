// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";
import * as adapter from "../../core/vehicles/ground-skidsteer.js";

const vehicleList: RuntimeCommand = {
  def: {
    name: "vehicle-list",
    summary: "List registered vehicles.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    emit({ vehicles: registry.list() });
    return 0;
  },
};

const vehicleAdd: RuntimeCommand = {
  def: {
    name: "vehicle-add",
    summary: "Register a new vehicle by host and name.",
    args: [
      {
        name: "host",
        kind: "string",
        required: true,
        description: "IP address or hostname of the vehicle's HTTP control endpoint.",
      },
    ],
    flags: [
      {
        name: "name",
        kind: "string",
        description: "Friendly name. Must be unique. Defaults to the host.",
      },
      {
        name: "port",
        kind: "number",
        default: 8080,
        description: "HTTP port. Defaults to 8080.",
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
    const host = String(args["host"] ?? flags["host"] ?? "").trim();
    if (!host) {
      emit({ error: "vehicle-add requires <host>." });
      return 64;
    }
    const name = String(flags["name"] ?? host).trim();
    const port = Number(flags["port"] ?? 8080);
    try {
      const vehicle = registry.add({ name, host, port });
      emit({ vehicle });
      return 0;
    } catch (err) {
      emit({ error: err instanceof Error ? err.message : String(err) });
      return 1;
    }
  },
};

const vehicleRemove: RuntimeCommand = {
  def: {
    name: "vehicle-remove",
    summary: "Unregister a vehicle by id.",
    args: [
      {
        name: "id",
        kind: "string",
        required: true,
        description: "Vehicle id (from vehicle-list).",
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
      emit({ error: "vehicle-remove requires <id>." });
      return 64;
    }
    const ok = registry.remove(id);
    if (!ok) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ removed: true, id });
    return 0;
  },
};

const vehicleHealth: RuntimeCommand = {
  def: {
    name: "vehicle-health",
    summary: "Check health of a registered vehicle. Hits /health on the firmware.",
    args: [
      {
        name: "id",
        kind: "string",
        required: true,
        description: "Vehicle id (from vehicle-list).",
      },
    ],
    flags: [],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      2: COMMON_EXIT_CODES[2]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args }) {
    const id = String(args["id"] ?? "").trim();
    if (!id) {
      emit({ error: "vehicle-health requires <id>." });
      return 64;
    }
    const vehicle = registry.get(id);
    if (!vehicle) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    try {
      const health = await adapter.health(vehicle);
      if (!health) {
        emit({ ok: false, reachable: false });
        return 2;
      }
      emit({ ok: true, reachable: true, health });
      return 0;
    } catch (err) {
      emit({
        ok: false,
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return 2;
    }
  },
};

const vehicleState: RuntimeCommand = {
  def: {
    name: "state",
    summary:
      "Get current vehicle state (motors, RSSI, deadman age). The vehicle reports about itself; stays local.",
    args: [
      {
        name: "id",
        kind: "string",
        required: true,
        description: "Vehicle id.",
      },
    ],
    flags: [
      {
        name: "follow",
        kind: "boolean",
        default: false,
        description: "Stream state as NDJSON. One line per poll.",
      },
      {
        name: "interval",
        kind: "number",
        default: 500,
        description: "Polling interval in ms when --follow is set.",
      },
    ],
    streams: true,
    events: [{ event: "state", description: "One state reading per emit." }],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      2: COMMON_EXIT_CODES[2]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args, flags }) {
    const id = String(args["id"] ?? "").trim();
    if (!id) {
      emit({ error: "state requires <id>." });
      return 64;
    }
    const vehicle = registry.get(id);
    if (!vehicle) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    const follow = flags["follow"] === true || flags["follow"] === "true";
    const interval = Math.max(100, Number(flags["interval"] ?? 500));

    const pollOnce = async (): Promise<number> => {
      const state = await adapter.getState(vehicle);
      if (!state) {
        emit({ event: "error", reachable: false });
        return 2;
      }
      emit({ event: "state", t: Date.now(), state });
      return 0;
    };

    if (!follow) {
      return pollOnce();
    }

    while (true) {
      const exit = await pollOnce();
      if (exit !== 0) return exit;
      await new Promise((r) => setTimeout(r, interval));
    }
  },
};

const vehicleStop: RuntimeCommand = {
  def: {
    name: "stop",
    summary: "Emergency stop a vehicle. Always safe to call.",
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
      2: COMMON_EXIT_CODES[2]!,
      3: COMMON_EXIT_CODES[3]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args }) {
    const id = String(args["id"] ?? "").trim();
    if (!id) {
      emit({ error: "stop requires <id>." });
      return 64;
    }
    const vehicle = registry.get(id);
    if (!vehicle) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    try {
      const ack = await adapter.emergencyStop(vehicle);
      emit({ stopped: ack.ok, ack });
      return ack.ok ? 0 : 3;
    } catch (err) {
      emit({ error: err instanceof Error ? err.message : String(err) });
      return 2;
    }
  },
};

const vehicleCmd: RuntimeCommand = {
  def: {
    name: "cmd",
    summary:
      "Send a direct (no-LLM) command to a vehicle. action: stop | fwd | rev | turn | tank.",
    args: [
      {
        name: "id",
        kind: "string",
        required: true,
        description: "Vehicle id.",
      },
      {
        name: "action",
        kind: "string",
        required: true,
        description: "One of: stop, fwd, rev, turn, tank.",
      },
    ],
    flags: [
      {
        name: "speed",
        kind: "number",
        description: "For fwd/rev: 0..255. For turn: signed -255..255 (negative = left).",
      },
      {
        name: "left",
        kind: "number",
        description: "For tank: left wheel -255..255.",
      },
      {
        name: "right",
        kind: "number",
        description: "For tank: right wheel -255..255.",
      },
      {
        name: "ms",
        kind: "number",
        description: "Duration in milliseconds (100..5000). Optional.",
      },
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
    const actionName = String(args["action"] ?? "").trim().toLowerCase();
    if (!id || !actionName) {
      emit({ error: "cmd requires <id> <action>." });
      return 64;
    }
    const vehicle = registry.get(id);
    if (!vehicle) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    const ms = flags["ms"] !== undefined ? Number(flags["ms"]) : undefined;
    const speed = flags["speed"] !== undefined ? Number(flags["speed"]) : undefined;

    let action;
    switch (actionName) {
      case "stop":
        action = { kind: "stop" as const };
        break;
      case "fwd":
        if (speed === undefined) {
          emit({ error: "cmd fwd requires --speed." });
          return 64;
        }
        action = { kind: "fwd" as const, speed, durationMs: ms };
        break;
      case "rev":
        if (speed === undefined) {
          emit({ error: "cmd rev requires --speed." });
          return 64;
        }
        action = { kind: "rev" as const, speed, durationMs: ms };
        break;
      case "turn":
        if (speed === undefined) {
          emit({ error: "cmd turn requires --speed (signed; negative = left)." });
          return 64;
        }
        action = { kind: "turn" as const, signed: speed, durationMs: ms };
        break;
      case "tank": {
        const left = flags["left"] !== undefined ? Number(flags["left"]) : undefined;
        const right = flags["right"] !== undefined ? Number(flags["right"]) : undefined;
        if (left === undefined || right === undefined) {
          emit({ error: "cmd tank requires --left and --right." });
          return 64;
        }
        action = { kind: "tank" as const, left, right, durationMs: ms };
        break;
      }
      default:
        emit({ error: `Unknown action: ${actionName}` });
        return 64;
    }

    try {
      const ack = await adapter.sendCommand(vehicle, action);
      emit({ ok: ack.ok, action, ack });
      return ack.ok ? 0 : 2;
    } catch (err) {
      emit({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return 2;
    }
  },
};

register(vehicleList);
register(vehicleAdd);
register(vehicleRemove);
register(vehicleHealth);
register(vehicleState);
register(vehicleStop);
register(vehicleCmd);
