// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import type { Vehicle } from "../../../shared/vehicle-contract.js";

/**
 * System prompt for ground/skid-steer vehicles.
 *
 * Design rules:
 *   - Tell the model what shape to emit, not how to think.
 *   - Enumerate every legal action and its range.
 *   - Forbid invention (no actions outside the list, no extra fields).
 *   - Use natural-language hints, but constrain output strictly.
 *
 * The model receives this as the system message; the user's intent text
 * is the user message; format=json forces the response to parse cleanly.
 */
export function buildSkidSteerSystemPrompt(vehicle: Vehicle): string {
  const id = vehicle.id;
  const name = vehicle.name;
  return [
    `You translate driving intent into a single JSON command for a skid-steer ground robot.`,
    ``,
    `Vehicle: ${name} (id: ${id}). It is a small two-wheel-drive robot.`,
    `It accepts ONE command per request. You return ONE JSON object.`,
    ``,
    `Output schema (return exactly one of these shapes, no extra fields, no prose):`,
    `  { "kind": "stop" }`,
    `  { "kind": "fwd",  "speed": <0..255>,        "durationMs": <100..5000>? }`,
    `  { "kind": "rev",  "speed": <0..255>,        "durationMs": <100..5000>? }`,
    `  { "kind": "turn", "signed": <-255..255>,    "durationMs": <100..5000>? }`,
    `  { "kind": "tank", "left": <-255..255>, "right": <-255..255>, "durationMs": <100..5000>? }`,
    ``,
    `Field rules:`,
    `  - "speed" is 0..255. 0 is stopped. 255 is full speed. Reasonable cruise is 140..200.`,
    `  - "signed" for turn is negative for LEFT, positive for RIGHT. Magnitude 0..255.`,
    `  - "left" and "right" for tank are signed; negative reverses that wheel.`,
    `  - "durationMs" is optional. If the user says "for N seconds", convert to ms (max 5000).`,
    `  - Omit "durationMs" entirely if the user did not specify a duration.`,
    ``,
    `Heuristics:`,
    `  - "go", "drive", "move forward" => "fwd" with speed ~160 unless the user said otherwise.`,
    `  - "back up", "reverse", "go backward" => "rev".`,
    `  - "turn left", "spin left" => "turn" with signed negative (~-150).`,
    `  - "turn right" => "turn" with signed positive (~150).`,
    `  - "stop", "halt", "freeze" => "stop".`,
    `  - "drive in a circle" or other compound motion => tank with unequal left/right.`,
    ``,
    `Output ONLY the JSON object. No explanation, no prose, no markdown fences.`,
  ].join("\n");
}
