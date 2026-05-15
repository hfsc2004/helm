import type {
  SkidSteerAction,
  Vehicle,
} from "../../shared/vehicle-contract.js";
import { COMMAND_LIMITS } from "../../shared/vehicle-contract.js";

/**
 * Adapter for the ESP32 skid-steer firmware in firmware/ground-skidsteer/.
 *
 * The firmware exposes:
 *   GET /             — help text
 *   GET /health       — JSON {ok, ip, gateway, ...}
 *   GET /telemetry    — JSON {left, right, deadmanMs, lastCmdAgeMs, wifiRssi, ...}
 *   GET /cmd?...      — drive commands; firmware deadman (800ms) auto-stops
 *
 * This adapter is a thin, typed wrapper. It does not interpret natural
 * language — that's the planner's job. It accepts structured commands only.
 */

interface RequestOptions {
  timeoutMs?: number;
}

export interface HealthResponse {
  ok: boolean;
  mode?: string;
  ip?: string;
  gateway?: string;
  subnet?: string;
  port?: number;
  [key: string]: unknown;
}

export interface StateResponse {
  left: number;
  right: number;
  deadmanMs: number;
  lastCmdAgeMs: number;
  wifiRssi: number;
  ip: string;
  gateway: string;
  subnet: string;
  [key: string]: unknown;
}

export interface CommandAck {
  ok: boolean;
  left?: number;
  right?: number;
  error?: string;
}

function baseUrl(vehicle: Vehicle): string {
  return `http://${vehicle.transport.host}:${vehicle.transport.port}`;
}

function clampSpeed(v: number): number {
  return Math.max(
    COMMAND_LIMITS.speedMin,
    Math.min(COMMAND_LIMITS.speedMax, Math.trunc(v))
  );
}

function clampDuration(ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined;
  return Math.max(
    COMMAND_LIMITS.durationMinMs,
    Math.min(COMMAND_LIMITS.durationMaxMs, Math.trunc(ms))
  );
}

function buildPath(action: SkidSteerAction): string {
  const dur = clampDuration("durationMs" in action ? action.durationMs : undefined);
  const durSuffix = dur === undefined ? "" : `&ms=${dur}`;

  switch (action.kind) {
    case "stop":
      return "/cmd?stop=1";
    case "fwd":
      return `/cmd?fwd=${Math.abs(clampSpeed(action.speed))}${durSuffix}`;
    case "rev":
      return `/cmd?rev=${Math.abs(clampSpeed(action.speed))}${durSuffix}`;
    case "turn":
      return `/cmd?turn=${clampSpeed(action.signed)}${durSuffix}`;
    case "tank":
      return `/cmd?left=${clampSpeed(action.left)}&right=${clampSpeed(action.right)}${durSuffix}`;
  }
}

async function httpGet(
  url: string,
  opts: RequestOptions = {}
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function health(
  vehicle: Vehicle,
  opts: RequestOptions = {}
): Promise<HealthResponse | null> {
  const url = `${baseUrl(vehicle)}/health`;
  const { status, body } = await httpGet(url, opts);
  if (status < 200 || status >= 300) return null;
  return parseJson<HealthResponse>(body);
}

export async function getState(
  vehicle: Vehicle,
  opts: RequestOptions = {}
): Promise<StateResponse | null> {
  const url = `${baseUrl(vehicle)}/telemetry`;
  const { status, body } = await httpGet(url, opts);
  if (status < 200 || status >= 300) return null;
  return parseJson<StateResponse>(body);
}

export async function sendCommand(
  vehicle: Vehicle,
  action: SkidSteerAction,
  opts: RequestOptions = {}
): Promise<CommandAck> {
  const url = `${baseUrl(vehicle)}${buildPath(action)}`;
  const { status, body } = await httpGet(url, opts);
  if (status < 200 || status >= 300) {
    return { ok: false, error: `HTTP ${status}` };
  }
  const parsed = parseJson<CommandAck>(body);
  return parsed ?? { ok: true };
}

export async function emergencyStop(
  vehicle: Vehicle,
  opts: RequestOptions = {}
): Promise<CommandAck> {
  return sendCommand(vehicle, { kind: "stop" }, opts);
}
