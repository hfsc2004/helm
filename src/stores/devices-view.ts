import { writable } from "svelte/store";

import type { SerialPortInfo } from "@shared/ipc-channels";

export type DevicesScreen =
  | { kind: "list" }
  | { kind: "configure"; port: SerialPortInfo };

export const devicesScreen = writable<DevicesScreen>({ kind: "list" });

export function openConfigure(port: SerialPortInfo): void {
  devicesScreen.set({ kind: "configure", port });
}

export function backToList(): void {
  devicesScreen.set({ kind: "list" });
}
