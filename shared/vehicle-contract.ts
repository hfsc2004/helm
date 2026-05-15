/**
 * Vehicle contract — the shape of "a thing PSF Helm can control."
 *
 * Design notes:
 * - The data model is fleet-shaped from day one. The simple driver view
 *   renders fleets of size 1 without exposing fleet concepts in the UI.
 * - Vehicles declare their `kind` and `capabilities` so the UI and the
 *   LLM planner can adapt without hardcoding per-vehicle logic.
 * - `lossOfCommsBehavior` is informational at the app layer; firmware
 *   is responsible for actually enforcing it (deadman timer, RTH, etc.).
 * - The command shape is a tagged union per `Action`. Each vehicle's
 *   capabilities determine which actions it accepts.
 */

export type VehicleKind = "ground" | "air";

export type VehicleCapability =
  | "drive.skidsteer"
  | "camera.mjpeg"
  | "state.basic"
  | "fly.quad"; // future

export type CoordinateFrame =
  | "raw"
  | "body-velocity"
  | "local-ned"
  | "global";

export type LossOfCommsBehavior = "stop" | "hover" | "rth" | "land";

export interface Vehicle {
  id: string;
  name: string;
  kind: VehicleKind;
  capabilities: VehicleCapability[];
  transport: {
    host: string;
    port: number;
  };
  /** Optional camera sidecar (MJPEG / JPEG snapshot endpoints). */
  camera?: {
    /** e.g. "http://172.20.0.16:81" — without path. */
    baseUrl: string;
    /** Default "/stream". MJPEG multipart endpoint. */
    streamPath?: string;
    /** Default "/capture". One-shot JPEG endpoint. */
    snapshotPath?: string;
  };
  coordinateFrame: CoordinateFrame;
  lossOfCommsBehavior: LossOfCommsBehavior;
  addedAt: number;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type SkidSteerAction =
  | { kind: "stop" }
  | { kind: "fwd"; speed: number; durationMs?: number }
  | { kind: "rev"; speed: number; durationMs?: number }
  | { kind: "turn"; signed: number; durationMs?: number }
  | { kind: "tank"; left: number; right: number; durationMs?: number };

export type VehicleCommand = SkidSteerAction;

/**
 * Speed/turn values are clamped to [-255, 255] on the wire (matches the
 * firmware's MAX_SPEED guard). Durations clamp to [100, 5000] ms in line
 * with the deadman budget — bigger windows would let the firmware time out
 * mid-action.
 */
export const COMMAND_LIMITS = {
  speedMax: 255,
  speedMin: -255,
  durationMinMs: 100,
  durationMaxMs: 5000,
} as const;
