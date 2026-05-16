import { writable, type Writable } from "svelte/store";

import type { Vehicle } from "@shared/vehicle-contract";
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
    camera: { baseUrl: string; streamPath?: string; snapshotPath?: string } | null
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

  async function start(vehicleId: string) {
    await stop();
    store.set({ vehicleId, latest: null, reachable: null });
    const sub = await helm().vehicle.streamState(
      { vehicleId, intervalMs: 500 },
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

  return {
    subscribe: store.subscribe,
    start,
    stop,
  };
}

export const vehicleState = createStateStore();
