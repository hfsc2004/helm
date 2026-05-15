import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Vehicle } from "../../shared/vehicle-contract.js";
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
