/**
 * Vehicle contract — the shape of "a thing PSF Helm can control."
 *
 * v0.1: skeleton only. The shape will harden as the first real vehicle
 * adapter (ESP32 skid-steer ground robot) is implemented.
 *
 * Design notes:
 * - The data model is fleet-shaped from day one. The simple driver view
 *   renders fleets of size 1 without exposing fleet concepts in the UI.
 * - Vehicles declare their `kind` and `capabilities` so the UI and the
 *   LLM planner can adapt without hardcoding per-vehicle logic.
 * - `lossOfCommsBehavior` is informational at the app layer; firmware
 *   is responsible for actually enforcing it (deadman timer, RTH, etc.).
 */

export type VehicleKind = "ground" | "air";

export type VehicleCapability =
  | "drive.skidsteer"
  | "camera.mjpeg"
  | "telemetry.basic"
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
  coordinateFrame: CoordinateFrame;
  lossOfCommsBehavior: LossOfCommsBehavior;
}
