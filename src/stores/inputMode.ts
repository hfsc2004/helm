import { writable } from "svelte/store";

/**
 * Which input device drives the truck in the Driver view.
 *
 * Persisted to localStorage so the choice survives app restart. App-wide
 * (not per-vehicle) — all vehicles use whatever the user picked last.
 */

export type InputMode = "wasd" | "numpad" | "gamepad";

export const INPUT_MODE_LABELS: Record<InputMode, string> = {
  wasd: "Keyboard WASD",
  numpad: "Keyboard NumPad",
  gamepad: "Game Controller",
};

const STORAGE_KEY = "psf-helm:input-mode";

function load(): InputMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "wasd" || raw === "numpad" || raw === "gamepad") return raw;
  } catch {
    // localStorage unavailable (SSR, file:// in some browsers) — fall through.
  }
  return "wasd";
}

function createInputMode() {
  const store = writable<InputMode>(load());
  return {
    subscribe: store.subscribe,
    set(value: InputMode) {
      store.set(value);
      try {
        localStorage.setItem(STORAGE_KEY, value);
      } catch {
        // ignore quota / disabled localStorage
      }
    },
  };
}

export const inputMode = createInputMode();
