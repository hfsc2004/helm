// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
export const WIDE_TOF_PROFILES = {
  fast: { label: "Extended Reach", observedFeet: 6, resolution: 16, hz: 30, minHz: 30, maxHz: 60 },
  inspect: { label: "Far Detail", observedFeet: 5, resolution: 64, hz: 5, minHz: 5, maxHz: 10 },
  detail: { label: "Balanced Detail", observedFeet: 4, resolution: 64, hz: 10, minHz: 10, maxHz: 10 },
  navigation: { label: "Close Detail", observedFeet: 3, resolution: 64, hz: 15, minHz: 10, maxHz: 15 },
  idle: { label: "Low Power", observedFeet: 3, resolution: 16, hz: 2, minHz: 1, maxHz: 2 },
} as const;
export type WideTofProfile = keyof typeof WIDE_TOF_PROFILES;

export function isWideTofProfile(value: unknown): value is WideTofProfile {
  return typeof value === "string" && Object.hasOwn(WIDE_TOF_PROFILES, value);
}
