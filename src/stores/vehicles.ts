// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { writable, type Writable } from "svelte/store";

import type {
  BoardRole,
  DriveFlashConfig,
  DriveTuning,
  Vehicle,
  VideoFlashConfig,
  WifiBoardConfig,
} from "@shared/vehicle-contract";
import type { StateStreamEvent } from "@shared/ipc-channels";

interface FleetState {
  vehicles: Vehicle[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
}

const helm = (): Window["helm"] => {
  if (!window.helm) throw new Error("helm IPC bridge not available");
  return window.helm;
};

function createFleetStore(): Writable<FleetState> & {
  refresh: () => Promise<void>;
  select: (id: string | null) => void;
  add: (input: { name: string; host: string; port?: number }) => Promise<{
    ok: boolean;
    vehicle?: Vehicle;
    error?: string;
  }>;
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
  setCamera: (
    id: string,
    camera: {
      baseUrl: string;
      streamPath?: string;
      snapshotPath?: string;
      flashStatusPath?: string;
    } | null
  ) => Promise<{ ok: boolean; vehicle?: Vehicle; error?: string }>;
  setAudio: (
    id: string,
    audio: { baseUrl: string; streamPath?: string } | null
  ) => Promise<{ ok: boolean; vehicle?: Vehicle; error?: string }>;
  setDrive: (
    id: string,
    drive: Partial<DriveTuning> | null
  ) => Promise<{ ok: boolean; vehicle?: Vehicle; error?: string }>;
  setWifi: (
    id: string,
    board: BoardRole,
    wifi: WifiBoardConfig | null
  ) => Promise<{ ok: boolean; vehicle?: Vehicle; error?: string }>;
  setFlashConfig: (
    id: string,
    board: BoardRole,
    flash: DriveFlashConfig | VideoFlashConfig | null
  ) => Promise<{ ok: boolean; vehicle?: Vehicle; error?: string }>;
} {
  const store = writable<FleetState>({
    vehicles: [],
    selectedId: null,
    loading: false,
    error: null,
  });

  return {
    ...store,
    async refresh() {
      store.update((s) => ({ ...s, loading: true, error: null }));
      try {
        const res = await helm().vehicle.list();
        store.update((s) => ({
          ...s,
          vehicles: res.vehicles,
          selectedId: s.selectedId ?? res.vehicles[0]?.id ?? null,
          loading: false,
        }));
      } catch (err) {
        store.update((s) => ({
          ...s,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        }));
      }
    },
    select(id) {
      store.update((s) => ({ ...s, selectedId: id }));
    },
    async add(input) {
      const res = await helm().vehicle.add(input);
      if (res.ok && res.vehicle) {
        const vehicle = res.vehicle;
        store.update((s) => ({
          ...s,
          vehicles: [...s.vehicles, vehicle],
          selectedId: s.selectedId ?? vehicle.id,
        }));
        return { ok: true, vehicle };
      }
      return { ok: false, error: res.error };
    },
    async remove(id) {
      const res = await helm().vehicle.remove({ vehicleId: id });
      if (res.ok) {
        store.update((s) => ({
          ...s,
          vehicles: s.vehicles.filter((v) => v.id !== id),
          selectedId: s.selectedId === id ? null : s.selectedId,
        }));
        return { ok: true };
      }
      return { ok: false, error: res.error };
    },
    async setCamera(id, camera) {
      const res = await helm().vehicle.setCamera({ vehicleId: id, camera });
      if (res.ok && res.vehicle) {
        const vehicle = res.vehicle;
        store.update((s) => ({
          ...s,
          vehicles: s.vehicles.map((v) => (v.id === id ? vehicle : v)),
        }));
        return { ok: true, vehicle };
      }
      return { ok: false, error: res.error };
    },
    async setAudio(id, audio) {
      const res = await helm().vehicle.setAudio({ vehicleId: id, audio });
      if (res.ok && res.vehicle) {
        const vehicle = res.vehicle;
        store.update((s) => ({
          ...s,
          vehicles: s.vehicles.map((v) => (v.id === id ? vehicle : v)),
        }));
        return { ok: true, vehicle };
      }
      return { ok: false, error: res.error };
    },
    async setDrive(id, drive) {
      const res = await helm().vehicle.setDrive({ vehicleId: id, drive });
      if (res.ok && res.vehicle) {
        const vehicle = res.vehicle;
        store.update((s) => ({
          ...s,
          vehicles: s.vehicles.map((v) => (v.id === id ? vehicle : v)),
        }));
        return { ok: true, vehicle };
      }
      return { ok: false, error: res.error };
    },
    async setWifi(id, board, wifi) {
      const res = await helm().vehicle.setWifi({ vehicleId: id, board, wifi });
      if (res.ok && res.vehicle) {
        const vehicle = res.vehicle;
        store.update((s) => ({
          ...s,
          vehicles: s.vehicles.map((v) => (v.id === id ? vehicle : v)),
        }));
        return { ok: true, vehicle };
      }
      return { ok: false, error: res.error };
    },
    async setFlashConfig(id, board, flash) {
      const res = await helm().vehicle.setFlashConfig({ vehicleId: id, board, flash });
      if (res.ok && res.vehicle) {
        const vehicle = res.vehicle;
        store.update((s) => ({
          ...s,
          vehicles: s.vehicles.map((v) => (v.id === id ? vehicle : v)),
        }));
        return { ok: true, vehicle };
      }
      return { ok: false, error: res.error };
    },
  };
}

export const fleet = createFleetStore();

// ---------------------------------------------------------------------------
// State stream — lives across the lifetime of the selected vehicle.
// ---------------------------------------------------------------------------

interface StateState {
  vehicleId: string | null;
  latest: StateStreamEvent | null;
  reachable: boolean | null;
}

function createStateStore() {
  const store = writable<StateState>({
    vehicleId: null,
    latest: null,
    reachable: null,
  });

  let activeStop: (() => Promise<void>) | null = null;
  // Track what was running before a pause so resume() can restore it
  // without the caller needing to remember the vehicle id.
  let pausedVehicleId: string | null = null;
  let pauseDepth = 0;

  async function start(vehicleId: string) {
    await stop();
    store.set({ vehicleId, latest: null, reachable: null });
    const sub = await helm().vehicle.streamState(
      { vehicleId, intervalMs: 2000 },
      (event) => {
        store.update((s) => ({
          ...s,
          latest: event as StateStreamEvent,
          reachable: event && (event as StateStreamEvent).state !== null ? true : false,
        }));
      }
    );
    activeStop = sub.stop;
  }

  async function stop() {
    if (activeStop) {
      const fn = activeStop;
      activeStop = null;
      await fn();
    }
    store.set({ vehicleId: null, latest: null, reachable: null });
  }

  /**
   * Temporarily stop the upstream telemetry poll while a drive command is
   * active — the drive board is single-threaded HTTP and gets bogged down
   * when /cmd and /telemetry compete. Reference-counted so overlapping
   * holds don't tear each other's pauses apart.
   */
  async function pause() {
    pauseDepth++;
    if (pauseDepth > 1) return;
    if (activeStop) {
      const id = (await new Promise<string | null>((resolve) =>
        store.subscribe((s) => resolve(s.vehicleId))()
      ));
      pausedVehicleId = id;
      const fn = activeStop;
      activeStop = null;
      await fn();
    }
  }

  async function resume() {
    if (pauseDepth > 0) pauseDepth--;
    if (pauseDepth > 0) return;
    if (pausedVehicleId && !activeStop) {
      const id = pausedVehicleId;
      pausedVehicleId = null;
      await start(id);
    } else {
      pausedVehicleId = null;
    }
  }

  return {
    subscribe: store.subscribe,
    start,
    stop,
    pause,
    resume,
  };
}

export const vehicleState = createStateStore();
