// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";
import * as adapter from "../../core/vehicles/ground-skidsteer.js";
import { plan, DEFAULT_PLANNER_MODEL } from "../../core/llm/planner.js";
import * as ollamaManager from "../../core/llm/ollama/manager.js";
import { STORAGE_LIMITS } from "../../core/storage/limits.js";

const drive: RuntimeCommand = {
  def: {
    name: "drive",
    summary:
      "Drive a vehicle by natural-language intent. Helm plans, validates, then sends a single command.",
    args: [
      {
        name: "id",
        kind: "string",
        required: true,
        description: "Vehicle id (from helm vehicle-list).",
      },
      {
        name: "intent",
        kind: "string",
        required: true,
        description: 'Quoted natural-language intent, e.g. "go forward 2 seconds".',
      },
    ],
    flags: [
      {
        name: "model",
        kind: "string",
        default: DEFAULT_PLANNER_MODEL,
        description: "Model to plan with. Must be registered in Helm's private Ollama.",
      },
      {
        name: "dry-run",
        kind: "boolean",
        default: false,
        description: "Plan and validate; do not actually send the command.",
      },
      {
        name: "no-retry",
        kind: "boolean",
        default: false,
        description: "Fail on first invalid model output; do not retry.",
      },
      {
        name: "temperature",
        kind: "number",
        default: 0.0,
        description: "Sampling temperature. 0.0 = deterministic.",
      },
    ],
    streams: true,
    events: [
      { event: "plan", description: "The proposed command after planner validation." },
      { event: "validate", description: "Planner validation result (ok or reason)." },
      { event: "execute", description: "Command being sent to the vehicle." },
      { event: "complete", description: "Final result." },
    ],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      2: COMMON_EXIT_CODES[2]!,
      3: COMMON_EXIT_CODES[3]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args, flags }) {
    const id = String(args["id"] ?? "").trim();
    const intent = String(args["intent"] ?? "").trim();
    if (!id || !intent) {
      emit({ error: "drive requires <id> <intent>." });
      return 64;
    }
    if (intent.length > STORAGE_LIMITS.intentMaxBytes) {
      emit({
        error: `intent exceeds ${STORAGE_LIMITS.intentMaxBytes}-byte limit`,
      });
      return 64;
    }
    const vehicle = registry.get(id);
    if (!vehicle) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    if (!ollamaManager.isRunning()) {
      emit({
        error: "Helm's private Ollama is not running.",
        hint: "Run `helm ollama-start` first.",
      });
      return 1;
    }

    const model = String(flags["model"] ?? DEFAULT_PLANNER_MODEL);
    const dryRun = flags["dry-run"] === true || flags["dry-run"] === "true";
    const noRetry = flags["no-retry"] === true || flags["no-retry"] === "true";
    const temperature = Number(flags["temperature"] ?? 0.0);

    // 1. Plan.
    let result;
    try {
      result = await plan({
        vehicle,
        intent,
        model,
        temperature,
        retryOnInvalid: !noRetry,
      });
    } catch (err) {
      emit({
        event: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return 1;
    }

    if (!result.ok) {
      emit({
        event: "validate",
        ok: false,
        reason: result.reason,
        modelUsed: result.modelUsed,
        attempts: result.attempts,
        raw: result.raw.slice(0, 500),
      });
      emit({ event: "complete", ok: false, reason: result.reason });
      return 1;
    }

    emit({
      event: "plan",
      command: result.command,
      modelUsed: result.modelUsed,
      attempts: result.attempts,
    });
    emit({ event: "validate", ok: true });

    if (dryRun) {
      emit({ event: "complete", ok: true, dryRun: true });
      return 0;
    }

    // 2. Execute.
    emit({ event: "execute", command: result.command });
    try {
      const ack = await adapter.sendCommand(vehicle, result.command);
      if (!ack.ok) {
        emit({ event: "complete", ok: false, ack });
        return 3;
      }
      emit({ event: "complete", ok: true, ack });
      return 0;
    } catch (err) {
      emit({
        event: "complete",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return 2;
    }
  },
};

register(drive);
