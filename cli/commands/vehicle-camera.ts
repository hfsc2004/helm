// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";

const setCamera: RuntimeCommand = {
  def: {
    name: "vehicle-camera-set",
    summary:
      "Attach a camera sidecar to a vehicle. The UI will show its MJPEG stream.",
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
        description: 'Camera base URL, e.g. "http://172.20.0.16:81".',
      },
    ],
    flags: [
      {
        name: "stream-path",
        kind: "string",
        default: "/stream",
        description: "MJPEG endpoint path.",
      },
      {
        name: "snapshot-path",
        kind: "string",
        default: "/capture",
        description: "JPEG snapshot endpoint path.",
      },
      {
        name: "flash-status-path",
        kind: "string",
        default: "/health",
        description: "Camera-board health probe path.",
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
      emit({ error: "vehicle-camera-set requires <id> <baseUrl>." });
      return 64;
    }
    const updated = registry.setCamera(id, {
      baseUrl,
      streamPath: String(flags["stream-path"] ?? "/stream"),
      snapshotPath: String(flags["snapshot-path"] ?? "/capture"),
      flashStatusPath: String(flags["flash-status-path"] ?? "/health"),
    });
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

const clearCamera: RuntimeCommand = {
  def: {
    name: "vehicle-camera-clear",
    summary: "Remove the camera sidecar from a vehicle.",
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
      emit({ error: "vehicle-camera-clear requires <id>." });
      return 64;
    }
    const updated = registry.setCamera(id, null);
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

register(setCamera);
register(clearCamera);
