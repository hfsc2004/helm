// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import type { Vehicle } from "../../shared/vehicle-contract.js";
import type { SensorBoardWideRange } from "../../shared/ipc-channels.js";
import { isWideTofProfile, WIDE_TOF_PROFILES, type WideTofProfile } from "../../shared/wide-tof.js";

export async function configureWideTof(
  vehicle: Vehicle, profile?: WideTofProfile, baseUrl?: string, hz?: number,
): Promise<SensorBoardWideRange> {
  if (vehicle.sensorBoardRevision !== "1.3") {
    return { ok: false, ready: false, error: "A v1.3 sensor-board vehicle is required." };
  }
  if (profile !== undefined && !isWideTofProfile(profile)) {
    return { ok: false, ready: false, error: "Unknown SR Front ToF profile." };
  }
  if (hz !== undefined && (profile === undefined || !Number.isInteger(hz) ||
      hz < WIDE_TOF_PROFILES[profile].minHz || hz > WIDE_TOF_PROFILES[profile].maxHz)) {
    return { ok: false, ready: false, error: "Frequency is outside the profile range." };
  }
  if (!baseUrl && !vehicle.camera) {
    return { ok: false, ready: false, error: "No sensor-board camera address is configured." };
  }
  const base = new URL(baseUrl ?? vehicle.camera!.baseUrl);
  if (base.protocol !== "http:") throw new Error("HTTP is required");
  if (!baseUrl) base.port = "82";
  const endpoint = new URL("/wide-tof-config", base);
  if (profile !== undefined) endpoint.searchParams.set("profile", profile);
  if (hz !== undefined) endpoint.searchParams.set("hz", String(hz));
  const response = await fetch(endpoint, {
    method: profile === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) {
    return { ok: false, ready: false, error: "Update the sensor-board firmware to enable SR Front profiles." };
  }
  const body = await response.json() as SensorBoardWideRange;
  if (!response.ok) return { ...body, ok: false, error: body.error ?? "Wide ToF request failed." };
  if (!body.ok || (body.resolution !== 16 && body.resolution !== 64)) {
    return { ok: false, ready: false, error: body.error ?? "Invalid wide ToF resolution response." };
  }
  if (!isWideTofProfile(body.profile) || body.profileControlVersion !== 1 ||
      (profile !== undefined && body.profile !== profile) ||
      (hz !== undefined && body.frequencyHz !== hz)) {
    return { ok: false, ready: false, error: "Sensor board did not confirm the requested SR Front profile." };
  }
  return body;
}

export async function readWideTof(vehicle: Vehicle, baseUrl?: string): Promise<SensorBoardWideRange> {
  if (vehicle.sensorBoardRevision !== "1.3" || (!baseUrl && !vehicle.camera)) {
    return { ok: false, ready: false, error: "No v1.3 sensor-board camera is configured." };
  }
  const base = new URL(baseUrl ?? vehicle.camera!.baseUrl);
  if (base.protocol !== "http:") throw new Error("HTTP is required");
  if (!baseUrl) base.port = "82";
  const response = await fetch(new URL("/wide-range", base), { signal: AbortSignal.timeout(1500) });
  const body = await response.json() as SensorBoardWideRange;
  if (!response.ok) return { ...body, ok: false, error: body.error ?? "SR Front unavailable." };
  if (body.ready) {
    const resolution = body.resolution ?? body.rawDistanceMm?.length;
    if ((resolution !== 16 && resolution !== 64) || body.rawDistanceMm?.length !== resolution ||
        body.targetStatus?.length !== resolution) {
      return { ok: false, ready: false, error: "SR Front frame dimensions do not match its resolution." };
    }
  }
  return body;
}
