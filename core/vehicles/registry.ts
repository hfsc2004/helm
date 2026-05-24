// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  BoardRole,
  DriveFlashConfig,
  DriveTuning,
  Vehicle,
  VideoFlashConfig,
  WifiBoardConfig,
} from "../../shared/vehicle-contract.js";
import { paths } from "../paths.js";
import { STORAGE_LIMITS } from "../storage/limits.js";

/**
 * Persistent vehicle registry.
 *
 * One JSON file under the OS-appropriate data dir. Capped at
 * STORAGE_LIMITS.registryVehicles entries (default 64). Add past the cap is
 * rejected with a clear error — registry never grows unbounded.
 */

interface RegistryFile {
  schemaVersion: 1;
  vehicles: Vehicle[];
}

function registryPath(): string {
  return paths.registry();
}

function load(): RegistryFile {
  const path = registryPath();
  if (!existsSync(path)) {
    return { schemaVersion: 1, vehicles: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RegistryFile;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.vehicles)) {
      return { schemaVersion: 1, vehicles: [] };
    }
    return parsed;
  } catch {
    // Corrupt file — preserve nothing, return empty registry. The user can
    // reinspect the file on disk if they care to.
    return { schemaVersion: 1, vehicles: [] };
  }
}

function save(file: RegistryFile): void {
  const path = registryPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), "utf8");
}

function mutate(id: string, fn: (vehicle: Vehicle) => void): Vehicle | null {
  const file = load();
  const idx = file.vehicles.findIndex((v) => v.id === id);
  if (idx < 0) return null;
  const vehicle = file.vehicles[idx]!;
  fn(vehicle);
  file.vehicles[idx] = vehicle;
  save(file);
  return vehicle;
}

export function list(): Vehicle[] {
  return load().vehicles;
}

export function get(id: string): Vehicle | null {
  return load().vehicles.find((v) => v.id === id) ?? null;
}

export function findByName(name: string): Vehicle | null {
  return load().vehicles.find((v) => v.name === name) ?? null;
}

export interface AddVehicleInput {
  name: string;
  host: string;
  port?: number;
  kind?: "ground" | "air";
}

export function add(input: AddVehicleInput): Vehicle {
  const file = load();
  if (file.vehicles.length >= STORAGE_LIMITS.registryVehicles) {
    throw new Error(
      `Registry full: ${STORAGE_LIMITS.registryVehicles} vehicles maximum. Remove one first.`
    );
  }
  if (file.vehicles.some((v) => v.name === input.name)) {
    throw new Error(`A vehicle named "${input.name}" already exists.`);
  }
  const vehicle: Vehicle = {
    id: `veh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name,
    kind: input.kind ?? "ground",
    capabilities: ["drive.skidsteer", "state.basic"],
    transport: {
      host: input.host,
      port: input.port ?? 8080,
    },
    coordinateFrame: "raw",
    lossOfCommsBehavior: "stop",
    addedAt: Date.now(),
  };
  file.vehicles.push(vehicle);
  save(file);
  return vehicle;
}

export function remove(id: string): boolean {
  const file = load();
  const before = file.vehicles.length;
  file.vehicles = file.vehicles.filter((v) => v.id !== id);
  if (file.vehicles.length === before) return false;
  save(file);
  return true;
}

export interface SetCameraInput {
  baseUrl: string;
  streamPath?: string;
  snapshotPath?: string;
  flashStatusPath?: string;
}

export function setCamera(id: string, input: SetCameraInput | null): Vehicle | null {
  return mutate(id, (vehicle) => {
    if (input === null) {
      delete vehicle.camera;
      vehicle.capabilities = vehicle.capabilities.filter((c) => c !== "camera.mjpeg");
      return;
    }
    vehicle.camera = {
      baseUrl: input.baseUrl,
      streamPath: input.streamPath ?? "/stream",
      snapshotPath: input.snapshotPath ?? "/capture",
      flashStatusPath: input.flashStatusPath ?? "/health",
    };
    if (!vehicle.capabilities.includes("camera.mjpeg")) {
      vehicle.capabilities = [...vehicle.capabilities, "camera.mjpeg"];
    }
  });
}

export interface SetAudioInput {
  baseUrl: string;
  streamPath?: string;
}

export function setAudio(id: string, input: SetAudioInput | null): Vehicle | null {
  return mutate(id, (vehicle) => {
    if (input === null) {
      delete vehicle.audio;
      vehicle.capabilities = vehicle.capabilities.filter((c) => c !== "audio.pcm");
      return;
    }
    vehicle.audio = {
      baseUrl: input.baseUrl,
      streamPath: input.streamPath ?? "/audio",
    };
    if (!vehicle.capabilities.includes("audio.pcm")) {
      vehicle.capabilities = [...vehicle.capabilities, "audio.pcm"];
    }
  });
}

// ---------------------------------------------------------------------------
// Dual-board mutators
// ---------------------------------------------------------------------------

export function setDrive(
  id: string,
  drive: Partial<DriveTuning> | null
): Vehicle | null {
  return mutate(id, (vehicle) => {
    if (drive === null) {
      delete vehicle.drive;
      return;
    }
    const prev = vehicle.drive;
    vehicle.drive = {
      speed: drive.speed ?? prev?.speed ?? 170,
      swapSides: drive.swapSides ?? prev?.swapSides ?? false,
      invertLeft: drive.invertLeft ?? prev?.invertLeft ?? false,
      invertRight: drive.invertRight ?? prev?.invertRight ?? false,
      map: {
        forward: drive.map?.forward ?? prev?.map.forward ?? "fwd",
        reverse: drive.map?.reverse ?? prev?.map.reverse ?? "rev",
        left: drive.map?.left ?? prev?.map.left ?? "turn_left",
        right: drive.map?.right ?? prev?.map.right ?? "turn_right",
      },
      numControlsEnabled:
        drive.numControlsEnabled ?? prev?.numControlsEnabled ?? true,
      obstacleFrontThreshold:
        drive.obstacleFrontThreshold ?? prev?.obstacleFrontThreshold ?? 0,
      ...(drive.aiDrive || prev?.aiDrive
        ? {
            aiDrive: {
              enabled: drive.aiDrive?.enabled ?? prev?.aiDrive?.enabled ?? false,
              agentId: drive.aiDrive?.agentId ?? prev?.aiDrive?.agentId ?? "",
              objective:
                drive.aiDrive?.objective ??
                prev?.aiDrive?.objective ??
                "Explore safely and avoid obstacles.",
              tickMs: drive.aiDrive?.tickMs ?? prev?.aiDrive?.tickMs ?? 420,
            },
          }
        : {}),
    };
  });
}

export function setWifi(
  id: string,
  board: BoardRole,
  wifi: WifiBoardConfig | null
): Vehicle | null {
  return mutate(id, (vehicle) => {
    const current = vehicle.wifi ?? {};
    if (wifi === null) {
      delete current[board];
    } else {
      current[board] = wifi;
    }
    if (current.drive || current.video) {
      vehicle.wifi = current;
    } else {
      delete vehicle.wifi;
    }
  });
}

export function setFlash(
  id: string,
  board: "drive",
  flash: DriveFlashConfig | null
): Vehicle | null;
export function setFlash(
  id: string,
  board: "video",
  flash: VideoFlashConfig | null
): Vehicle | null;
export function setFlash(
  id: string,
  board: BoardRole,
  flash: DriveFlashConfig | VideoFlashConfig | null
): Vehicle | null {
  return mutate(id, (vehicle) => {
    const current = vehicle.flash ?? {};
    if (flash === null) {
      delete current[board];
    } else if (board === "drive") {
      current.drive = flash as DriveFlashConfig;
    } else {
      current.video = flash as VideoFlashConfig;
    }
    if (current.drive || current.video) {
      vehicle.flash = current;
    } else {
      delete vehicle.flash;
    }
  });
}
