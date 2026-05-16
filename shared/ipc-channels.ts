/**
 * Typed IPC contract shared between the Electron main process and the renderer.
 *
 * Keep this file dependency-free — it is imported by both sides.
 *
 * Architectural rule (mirrors BMOC's process-lifecycle rule):
 *   No long-lived IPC subscription opens without BMOC knowing about it.
 *   One-shot request/response calls do not need session tracking; they open
 *   and close within the same call. Streams (state-follow, drive lifecycle)
 *   are sessions and register with BMOC for clean shutdown.
 */

import type { Vehicle, SkidSteerAction } from "./vehicle-contract.js";
import type { OllamaStatus } from "./llm.js";

// ---------------------------------------------------------------------------
// drive (long-lived, BMOC-tracked)
// ---------------------------------------------------------------------------

export interface DriveRequest {
  vehicleId: string;
  intent: string;
  model?: string;
  dryRun?: boolean;
  noRetry?: boolean;
  temperature?: number;
}

export type DriveStreamEvent =
  | { streamId: string; event: "plan"; command: SkidSteerAction; modelUsed: string; attempts: number }
  | { streamId: string; event: "validate"; ok: true }
  | { streamId: string; event: "validate"; ok: false; reason: string; raw: string }
  | { streamId: string; event: "execute"; command: SkidSteerAction }
  | { streamId: string; event: "complete"; ok: boolean; ack?: unknown; reason?: string; dryRun?: boolean }
  | { streamId: string; event: "error"; error: string };

// ---------------------------------------------------------------------------
// One-shot request/response
// ---------------------------------------------------------------------------

export interface VehicleListResponse {
  vehicles: Vehicle[];
}

export interface VehicleCmdRequest {
  vehicleId: string;
  action: SkidSteerAction;
}

export interface VehicleCmdResponse {
  ok: boolean;
  ack?: { ok: boolean; left?: number; right?: number; error?: string };
  error?: string;
}

export interface VehicleStopRequest {
  vehicleId: string;
}

// ---------------------------------------------------------------------------
// Streams (long-lived, BMOC-tracked)
// ---------------------------------------------------------------------------

export interface StateStreamRequest {
  vehicleId: string;
  intervalMs?: number;
}

/** Returned synchronously when a stream is opened; later events arrive over a
 *  channel namespaced by this id. */
export interface StreamHandle {
  streamId: string;
  bmocSessionId: string;
}

export interface StateStreamEvent {
  streamId: string;
  t: number;
  state: {
    left: number;
    right: number;
    deadmanMs: number;
    lastCmdAgeMs: number;
    wifiRssi: number;
    [key: string]: unknown;
  } | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Renderer-facing API surface
// ---------------------------------------------------------------------------

export interface SerialPortInfo {
  path: string;
  label: string;
  kind: "usb" | "virtual" | "serial";
  boardHint: "raspberry-pi-pico" | "esp32" | "";
}

export interface HardwareInfo {
  hardware: {
    ram_gb?: number;
    cpu_count?: number;
    gpu_detected?: boolean;
    gpu_list?: Array<{
      name: string;
      vram?: number;
      uuid?: string;
      index?: number;
    }>;
    platform?: string;
    [key: string]: unknown;
  };
  classification: {
    accelerationType: string;
    name?: string;
    vram?: number;
    uuid?: string;
    index?: number;
    displayText?: string;
  };
  nvidiaSelection: { index: number | null; uuid: string } | null;
}

export interface VehicleAddRequest {
  name: string;
  host: string;
  port?: number;
  kind?: "ground" | "air";
}

export interface VehicleRemoveRequest {
  vehicleId: string;
}

export interface VehicleSetCameraRequest {
  vehicleId: string;
  camera: { baseUrl: string; streamPath?: string; snapshotPath?: string } | null;
}

export interface VehicleSetAudioRequest {
  vehicleId: string;
  audio: { baseUrl: string; streamPath?: string } | null;
}

export interface VehicleMutationResponse {
  ok: boolean;
  vehicle?: import("./vehicle-contract.js").Vehicle | null;
  error?: string;
}

export interface HelmAPI {
  app: {
    getVersion(): Promise<string>;
  };
  vehicle: {
    list(): Promise<VehicleListResponse>;
    add(req: VehicleAddRequest): Promise<VehicleMutationResponse>;
    remove(req: VehicleRemoveRequest): Promise<VehicleMutationResponse>;
    setCamera(req: VehicleSetCameraRequest): Promise<VehicleMutationResponse>;
    setAudio(req: VehicleSetAudioRequest): Promise<VehicleMutationResponse>;
    cmd(req: VehicleCmdRequest): Promise<VehicleCmdResponse>;
    stop(req: VehicleStopRequest): Promise<VehicleCmdResponse>;
    streamState(req: StateStreamRequest, onEvent: (e: StateStreamEvent) => void): Promise<{
      handle: StreamHandle;
      stop: () => Promise<void>;
    }>;
    drive(req: DriveRequest, onEvent: (e: DriveStreamEvent) => void): Promise<{
      handle: StreamHandle;
      stop: () => Promise<void>;
    }>;
  };
  serial: {
    list(): Promise<{ ports: SerialPortInfo[] }>;
  };
  hardware: {
    detect(): Promise<HardwareInfo>;
  };
  ollama: {
    status(): Promise<OllamaStatus>;
  };
}

declare global {
  interface Window {
    helm: HelmAPI;
  }
}

// ---------------------------------------------------------------------------
// Channel name constants — single source of truth for both sides.
// ---------------------------------------------------------------------------

export const IPC = {
  app: {
    getVersion: "app:get-version",
  },
  vehicle: {
    list: "vehicle:list",
    add: "vehicle:add",
    remove: "vehicle:remove",
    setCamera: "vehicle:set-camera",
    setAudio: "vehicle:set-audio",
    cmd: "vehicle:cmd",
    stop: "vehicle:stop",
    streamStateOpen: "vehicle:stream-state-open",
    streamStateClose: "vehicle:stream-state-close",
    /** Per-stream event channel template; actual channel = streamEventPrefix + streamId */
    streamEventPrefix: "vehicle:stream-event:",
    driveOpen: "vehicle:drive-open",
    driveClose: "vehicle:drive-close",
    driveEventPrefix: "vehicle:drive-event:",
  },
  serial: {
    list: "serial:list",
  },
  hardware: {
    detect: "hardware:detect",
  },
  ollama: {
    status: "ollama:status",
  },
} as const;
