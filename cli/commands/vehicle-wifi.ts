// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";
import type { BoardRole, WifiBoardConfig } from "../../shared/vehicle-contract.js";

const VALID_BOARDS: BoardRole[] = ["drive", "video"];

function parseBoard(value: unknown): BoardRole | { error: string } {
  const s = String(value ?? "").trim().toLowerCase();
  if (!VALID_BOARDS.includes(s as BoardRole)) {
    return { error: `--board must be one of: ${VALID_BOARDS.join(", ")}` };
  }
  return s as BoardRole;
}

const wifiSet: RuntimeCommand = {
  def: {
    name: "vehicle-wifi-set",
    summary:
      "Set the Wi-Fi credentials (and optional static IP) for one board of a vehicle.",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id." },
    ],
    flags: [
      { name: "board", kind: "string", description: "Which board: drive | video." },
      { name: "ssid", kind: "string", description: "Wi-Fi SSID." },
      { name: "password", kind: "string", description: "Wi-Fi password (secret)." },
      { name: "static-ip", kind: "string", description: "Static IP. Omit for DHCP." },
      { name: "static-cidr", kind: "number", default: 24, description: "Static-IP CIDR prefix." },
      {
        name: "static-gateway",
        kind: "string",
        description: "Gateway IP (only if static).",
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
    if (!id) {
      emit({ error: "vehicle-wifi-set requires <id>." });
      return 64;
    }
    const board = parseBoard(flags["board"]);
    if (typeof board !== "string") {
      emit({ error: board.error });
      return 64;
    }
    const ssid = String(flags["ssid"] ?? "").trim();
    const password = String(flags["password"] ?? "");
    if (!ssid || !password) {
      emit({ error: "vehicle-wifi-set requires --ssid and --password." });
      return 64;
    }

    const cfg: WifiBoardConfig = { ssid, password };
    const staticIp = String(flags["static-ip"] ?? "").trim();
    if (staticIp) {
      const cidrRaw = Number(flags["static-cidr"] ?? 24);
      const cidr = Number.isFinite(cidrRaw) ? cidrRaw : 24;
      const gateway = String(flags["static-gateway"] ?? "").trim();
      cfg.static = {
        ip: staticIp,
        cidr,
        gatewayEnabled: gateway.length > 0,
        gateway,
      };
    }

    const updated = registry.setWifi(id, board, cfg);
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

const wifiClear: RuntimeCommand = {
  def: {
    name: "vehicle-wifi-clear",
    summary: "Remove the Wi-Fi config for one board of a vehicle.",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id." },
    ],
    flags: [
      { name: "board", kind: "string", description: "Which board: drive | video." },
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
    if (!id) {
      emit({ error: "vehicle-wifi-clear requires <id>." });
      return 64;
    }
    const board = parseBoard(flags["board"]);
    if (typeof board !== "string") {
      emit({ error: board.error });
      return 64;
    }
    const updated = registry.setWifi(id, board, null);
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

register(wifiSet);
register(wifiClear);
