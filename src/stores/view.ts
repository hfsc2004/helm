import { writable } from "svelte/store";

export type ViewName = "drive" | "vehicles" | "devices";

export const activeView = writable<ViewName>("drive");
