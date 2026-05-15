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

export interface HelmAPI {
  app: {
    getVersion(): Promise<string>;
  };
  vehicle: {
    list(): Promise<VehicleListResponse>;
    cmd(req: VehicleCmdRequest): Promise<VehicleCmdResponse>;
    stop(req: VehicleStopRequest): Promise<VehicleCmdResponse>;
    streamState(req: StateStreamRequest, onEvent: (e: StateStreamEvent) => void): Promise<{
      handle: StreamHandle;
      stop: () => Promise<void>;
    }>;
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
    cmd: "vehicle:cmd",
    stop: "vehicle:stop",
    streamStateOpen: "vehicle:stream-state-open",
    streamStateClose: "vehicle:stream-state-close",
    /** Per-stream event channel template; actual channel = streamEventPrefix + streamId */
    streamEventPrefix: "vehicle:stream-event:",
  },
  ollama: {
    status: "ollama:status",
  },
} as const;
