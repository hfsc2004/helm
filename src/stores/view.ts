// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { writable } from "svelte/store";

export type ViewName = "drive" | "vehicles" | "devices";

export const activeView = writable<ViewName>("drive");
