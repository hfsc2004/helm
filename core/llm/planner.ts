// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import type { Vehicle, SkidSteerAction } from "../../shared/vehicle-contract.js";
import { COMMAND_LIMITS } from "../../shared/vehicle-contract.js";
import { chat } from "./ollama/chat.js";
import { buildSkidSteerSystemPrompt } from "./prompts/skidsteer.js";

/**
 * The planner: intent string → validated vehicle command.
 *
 * Architectural rule (mirrors PSF Core's IRG):
 *   The model proposes. The validator gates. Only validated commands reach
 *   the vehicle. There is no fuzzy parsing, no value coercion outside the
 *   validator's explicit clamps. If the model returns nonsense, we say so
 *   honestly and refuse to drive.
 */

export const DEFAULT_PLANNER_MODEL = "qwen2.5-vl-7b";

export interface PlanRequest {
  vehicle: Vehicle;
  intent: string;
  /** Override the model. Defaults to DEFAULT_PLANNER_MODEL. */
  model?: string;
  /** Sampling temperature. Default 0.0 (deterministic). */
  temperature?: number;
  /** One retry on validation failure by default; set false to fail fast. */
  retryOnInvalid?: boolean;
}

export type PlanResult =
  | {
      ok: true;
      command: SkidSteerAction;
      modelUsed: string;
      attempts: number;
      raw: string;
    }
  | {
      ok: false;
      reason: string;
      modelUsed: string;
      attempts: number;
      raw: string;
    };

/**
 * Validate a parsed candidate against the SkidSteerAction shape.
 * Returns the validated command on success, or an error reason on failure.
 */
function validateSkidSteer(
  candidate: unknown
): { ok: true; command: SkidSteerAction } | { ok: false; reason: string } {
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, reason: "response is not a JSON object" };
  }
  const obj = candidate as Record<string, unknown>;
  const kind = obj["kind"];
  if (typeof kind !== "string") {
    return { ok: false, reason: "missing or non-string 'kind' field" };
  }

  const inRange = (v: unknown, min: number, max: number, name: string):
    | { ok: true; value: number }
    | { ok: false; reason: string } => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, reason: `${name} must be a finite number; got ${typeof v}` };
    }
    if (v < min || v > max) {
      return { ok: false, reason: `${name}=${v} out of range [${min}..${max}]` };
    }
    return { ok: true, value: Math.trunc(v) };
  };

  const durationOpt = (v: unknown): { ok: true; value?: number } | { ok: false; reason: string } => {
    if (v === undefined || v === null) return { ok: true };
    const r = inRange(v, COMMAND_LIMITS.durationMinMs, COMMAND_LIMITS.durationMaxMs, "durationMs");
    if (!r.ok) return r;
    return { ok: true, value: r.value };
  };

  switch (kind) {
    case "stop":
      return { ok: true, command: { kind: "stop" } };
    case "fwd":
    case "rev": {
      const speed = inRange(obj["speed"], 0, COMMAND_LIMITS.speedMax, "speed");
      if (!speed.ok) return speed;
      const dur = durationOpt(obj["durationMs"]);
      if (!dur.ok) return dur;
      return {
        ok: true,
        command:
          dur.value !== undefined
            ? { kind, speed: speed.value, durationMs: dur.value }
            : { kind, speed: speed.value },
      };
    }
    case "turn": {
      const signed = inRange(
        obj["signed"],
        COMMAND_LIMITS.speedMin,
        COMMAND_LIMITS.speedMax,
        "signed"
      );
      if (!signed.ok) return signed;
      const dur = durationOpt(obj["durationMs"]);
      if (!dur.ok) return dur;
      return {
        ok: true,
        command:
          dur.value !== undefined
            ? { kind: "turn", signed: signed.value, durationMs: dur.value }
            : { kind: "turn", signed: signed.value },
      };
    }
    case "tank": {
      const left = inRange(
        obj["left"],
        COMMAND_LIMITS.speedMin,
        COMMAND_LIMITS.speedMax,
        "left"
      );
      if (!left.ok) return left;
      const right = inRange(
        obj["right"],
        COMMAND_LIMITS.speedMin,
        COMMAND_LIMITS.speedMax,
        "right"
      );
      if (!right.ok) return right;
      const dur = durationOpt(obj["durationMs"]);
      if (!dur.ok) return dur;
      return {
        ok: true,
        command:
          dur.value !== undefined
            ? { kind: "tank", left: left.value, right: right.value, durationMs: dur.value }
            : { kind: "tank", left: left.value, right: right.value },
      };
    }
    default:
      return { ok: false, reason: `unknown 'kind' value: ${kind}` };
  }
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      reason: `response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function plan(req: PlanRequest): Promise<PlanResult> {
  const model = req.model ?? DEFAULT_PLANNER_MODEL;
  const system = buildSkidSteerSystemPrompt(req.vehicle);
  const retry = req.retryOnInvalid !== false;

  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: req.intent },
  ];

  let attempts = 0;
  let lastRaw = "";

  // First attempt.
  attempts++;
  const first = await chat({
    model,
    messages,
    json: true,
    temperature: req.temperature ?? 0.0,
  });
  lastRaw = first.content;

  let parsed = tryParse(first.content);
  if (parsed.ok) {
    const validated = validateSkidSteer(parsed.value);
    if (validated.ok) {
      return {
        ok: true,
        command: validated.command,
        modelUsed: first.model,
        attempts,
        raw: first.content,
      };
    }
    parsed = { ok: false, reason: validated.reason };
  }

  if (!retry) {
    return {
      ok: false,
      reason: parsed.reason,
      modelUsed: first.model,
      attempts,
      raw: lastRaw,
    };
  }

  // Retry once with the validator error in the context.
  attempts++;
  const retryMessages = [
    ...messages,
    { role: "assistant" as const, content: first.content },
    {
      role: "user" as const,
      content:
        `That response was rejected: ${parsed.reason}. ` +
        `Return exactly one JSON object matching the schema. No prose.`,
    },
  ];

  const second = await chat({
    model,
    messages: retryMessages,
    json: true,
    temperature: req.temperature ?? 0.0,
  });
  lastRaw = second.content;

  const secondParsed = tryParse(second.content);
  if (!secondParsed.ok) {
    return {
      ok: false,
      reason: `retry also invalid: ${secondParsed.reason}`,
      modelUsed: second.model,
      attempts,
      raw: lastRaw,
    };
  }
  const secondValidated = validateSkidSteer(secondParsed.value);
  if (!secondValidated.ok) {
    return {
      ok: false,
      reason: `retry also invalid: ${secondValidated.reason}`,
      modelUsed: second.model,
      attempts,
      raw: lastRaw,
    };
  }
  return {
    ok: true,
    command: secondValidated.command,
    modelUsed: second.model,
    attempts,
    raw: second.content,
  };
}
