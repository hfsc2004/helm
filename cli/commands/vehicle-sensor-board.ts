// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";

const setSensorBoard: RuntimeCommand = {
  def: {
    name: "vehicle-sensor-board-set",
    summary: "Set a vehicle's GSN Robotics / PSF Sensor Board revision.",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id." },
      { name: "revision", kind: "string", required: true, description: "1.1, 1.3, or none." },
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
    const raw = String(args["revision"] ?? "").trim();
    if (!id || (raw !== "1.1" && raw !== "1.3" && raw !== "none")) {
      emit({ error: "vehicle-sensor-board-set requires <id> <1.1|1.3|none>." });
      return 64;
    }
    const updated = registry.setSensorBoardRevision(id, raw === "none" ? null : raw);
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

register(setSensorBoard);
