import { writable } from "svelte/store";

export type ViewName = "drive" | "devices";

export const activeView = writable<ViewName>("drive");
