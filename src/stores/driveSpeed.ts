import { writable, derived, get } from "svelte/store";

import { fleet } from "./vehicles";
import { COMMAND_LIMITS } from "@shared/vehicle-contract";

/**
 * Session-only drive-speed knob.
 *
 * Initialized from the selected vehicle's `drive.speed` (or a safe default),
 * but edits stay in memory — we don't write to the registry on every tick of
 * a slider. The user can persist their preferred speed via the Vehicles tab
 * "Drive tuning" panel.
 *
 * The store value is the *current* PWM magnitude used for fwd/rev/turn intents
 * (0..255). Tank commands derive from the same number.
 */

/** Slowest meaningfully-driveable speed. Below ~40 most motors don't overcome
 *  static friction; clamping here keeps the slider's left edge useful. */
export const SPEED_MIN = 40;
export const SPEED_MAX = COMMAND_LIMITS.speedMax; // 255
export const SPEED_STEP = 10;
export const SPEED_DEFAULT = 170;

function clamp(n: number): number {
  if (!Number.isFinite(n)) return SPEED_DEFAULT;
  if (n < SPEED_MIN) return SPEED_MIN;
  if (n > SPEED_MAX) return SPEED_MAX;
  return Math.round(n);
}

function createDriveSpeed() {
  const store = writable<number>(SPEED_DEFAULT);

  // Whenever the user selects a different vehicle, re-seed from its saved
  // tuning so each vehicle starts at "its" speed instead of inheriting the
  // last one's slider position.
  fleet.subscribe((state) => {
    const v = state.vehicles.find((veh) => veh.id === state.selectedId);
    const next = clamp(v?.drive?.speed ?? SPEED_DEFAULT);
    if (next !== get(store)) store.set(next);
  });

  return {
    subscribe: store.subscribe,
    set(value: number) {
      store.set(clamp(value));
    },
    bump(delta: number) {
      store.update((v) => clamp(v + delta));
    },
    reset() {
      store.set(SPEED_DEFAULT);
    },
  };
}

export const driveSpeed = createDriveSpeed();

/** 0..1 position of the slider; useful for the track fill in the UI. */
export const driveSpeedFraction = derived(driveSpeed, ($s) =>
  Math.max(0, Math.min(1, ($s - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)))
);
