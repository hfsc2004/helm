// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";
import type { DriveMapTarget, DriveTuning } from "../../shared/vehicle-contract.js";

const VALID_MAP_TARGETS: DriveMapTarget[] = [
  "fwd",
  "rev",
  "turn_left",
  "turn_right",
  "stop",
];

function asMapTarget(value: unknown, flag: string): DriveMapTarget | { error: string } {
  const s = String(value ?? "").trim();
  if (!VALID_MAP_TARGETS.includes(s as DriveMapTarget)) {
    return {
      error: `--${flag} must be one of: ${VALID_MAP_TARGETS.join(", ")}`,
    };
  }
  return s as DriveMapTarget;
}

type FlagsMap = Record<string, string | number | boolean>;

function flagBool(flags: FlagsMap, name: string): boolean | undefined {
  if (!(name in flags)) return undefined;
  const v = flags[name];
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return undefined;
}

function flagNumber(flags: FlagsMap, name: string): number | undefined {
  if (!(name in flags)) return undefined;
  const v = flags[name];
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const driveSet: RuntimeCommand = {
  def: {
    name: "vehicle-drive-set",
    summary:
      "Set drive-side tuning (speed, swap/invert sides, action map, obstacle threshold, AI drive).",
    args: [
      {
        name: "id",
        kind: "string",
        required: true,
        description: "Vehicle id (from vehicle-list).",
      },
    ],
    flags: [
      { name: "speed", kind: "number", description: "Default drive speed 0..255." },
      { name: "swap-sides", kind: "boolean", description: "Swap left/right motor outputs." },
      { name: "invert-left", kind: "boolean", description: "Invert left motor direction." },
      { name: "invert-right", kind: "boolean", description: "Invert right motor direction." },
      {
        name: "map-forward",
        kind: "string",
        description: `Map the "forward" intent to one of: ${VALID_MAP_TARGETS.join(", ")}.`,
      },
      { name: "map-reverse", kind: "string", description: 'Map "reverse" intent.' },
      { name: "map-left", kind: "string", description: 'Map "left" intent.' },
      { name: "map-right", kind: "string", description: 'Map "right" intent.' },
      {
        name: "num-controls",
        kind: "boolean",
        description: "Show on-screen numeric speed controls in the driver view.",
      },
      {
        name: "obstacle-front",
        kind: "number",
        description: "Front ultrasonic stop threshold (mm). 0 disables.",
      },
      { name: "ai-drive", kind: "boolean", description: "Enable autonomous drive loop." },
      { name: "ai-agent-id", kind: "string", description: "Agent id for AI drive." },
      { name: "ai-objective", kind: "string", description: "Plain-English objective for AI drive." },
      { name: "ai-tick-ms", kind: "number", description: "AI drive tick interval (ms)." },
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
      emit({ error: "vehicle-drive-set requires <id>." });
      return 64;
    }

    const tuning: Partial<DriveTuning> = {};
    const speed = flagNumber(flags, "speed");
    if (speed !== undefined) tuning.speed = speed;
    const swapSides = flagBool(flags, "swap-sides");
    if (swapSides !== undefined) tuning.swapSides = swapSides;
    const invertLeft = flagBool(flags, "invert-left");
    if (invertLeft !== undefined) tuning.invertLeft = invertLeft;
    const invertRight = flagBool(flags, "invert-right");
    if (invertRight !== undefined) tuning.invertRight = invertRight;

    const mapPartial: Partial<DriveTuning["map"]> = {};
    for (const [flag, key] of [
      ["map-forward", "forward"],
      ["map-reverse", "reverse"],
      ["map-left", "left"],
      ["map-right", "right"],
    ] as const) {
      if (flag in flags) {
        const m = asMapTarget(flags[flag], flag);
        if (typeof m !== "string") {
          emit({ error: m.error });
          return 64;
        }
        mapPartial[key] = m;
      }
    }
    if (Object.keys(mapPartial).length) tuning.map = mapPartial as DriveTuning["map"];

    const numControls = flagBool(flags, "num-controls");
    if (numControls !== undefined) tuning.numControlsEnabled = numControls;
    const obstacleFront = flagNumber(flags, "obstacle-front");
    if (obstacleFront !== undefined) tuning.obstacleFrontThreshold = obstacleFront;

    const aiEnabled = flagBool(flags, "ai-drive");
    const aiAgentId = "ai-agent-id" in flags ? String(flags["ai-agent-id"]) : undefined;
    const aiObjective = "ai-objective" in flags ? String(flags["ai-objective"]) : undefined;
    const aiTickMs = flagNumber(flags, "ai-tick-ms");
    if (
      aiEnabled !== undefined ||
      aiAgentId !== undefined ||
      aiObjective !== undefined ||
      aiTickMs !== undefined
    ) {
      tuning.aiDrive = {
        enabled: aiEnabled ?? false,
        agentId: aiAgentId ?? "",
        objective: aiObjective ?? "Explore safely and avoid obstacles.",
        tickMs: aiTickMs ?? 420,
      };
    }

    if (Object.keys(tuning).length === 0) {
      emit({ error: "vehicle-drive-set requires at least one tuning flag." });
      return 64;
    }

    const updated = registry.setDrive(id, tuning);
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

const driveClear: RuntimeCommand = {
  def: {
    name: "vehicle-drive-clear",
    summary: "Remove drive-side tuning (revert to defaults).",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id." },
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
      emit({ error: "vehicle-drive-clear requires <id>." });
      return 64;
    }
    const updated = registry.setDrive(id, null);
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

register(driveSet);
register(driveClear);
