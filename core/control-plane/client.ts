// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
/**
 * Client-side bindings for the loopback control plane (see ./server.ts).
 *
 * The standalone `helm` CLI uses this to ask a running Helm-UI for a frame
 * out of its shared camera-stream cache, so the CLI and the live UI don't
 * fight over the camera firmware's single HTTP slot.
 *
 * Liveness check: even if control-plane.json exists, the Helm-UI may have
 * died ungracefully. We always probe /v1/health (short timeout) before
 * relying on the descriptor.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";

import { paths } from "../paths.js";

export interface ControlPlaneDescriptor {
  host: string;
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  version: 1;
}

export function readDescriptor(): ControlPlaneDescriptor | null {
  const path = paths.controlPlane();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ControlPlaneDescriptor;
    if (
      parsed.version !== 1 ||
      typeof parsed.port !== "number" ||
      typeof parsed.token !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearDescriptor(): void {
  try {
    rmSync(paths.controlPlane(), { force: true });
  } catch {
    // best-effort
  }
}

function baseUrl(desc: ControlPlaneDescriptor): string {
  return `http://${desc.host}:${desc.port}`;
}

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the descriptor if a running Helm-UI's control plane answers
 * /v1/health within `timeoutMs`. Returns null on any failure (file
 * missing, port stale, wrong token, network error). Stale descriptor
 * files are removed so future invocations skip the probe entirely.
 */
export async function probe(timeoutMs = 500): Promise<ControlPlaneDescriptor | null> {
  const desc = readDescriptor();
  if (!desc) return null;
  try {
    const res = await timedFetch(
      `${baseUrl(desc)}/v1/health`,
      { headers: { authorization: `Bearer ${desc.token}` } },
      timeoutMs
    );
    if (!res.ok) {
      clearDescriptor();
      return null;
    }
    return desc;
  } catch {
    clearDescriptor();
    return null;
  }
}

export interface RemoteSnapshot {
  bytes: Buffer;
  contentType: string;
  source: "cache" | "direct";
  capturedAt: number;
  vehicleId?: string;
  vehicleName?: string;
}

export async function snapshot(
  desc: ControlPlaneDescriptor,
  vehicleIdOrName: string,
  timeoutMs: number
): Promise<RemoteSnapshot> {
  const url = `${baseUrl(desc)}/v1/vehicles/${encodeURIComponent(vehicleIdOrName)}/snapshot?timeoutMs=${timeoutMs}`;
  const res = await timedFetch(
    url,
    { headers: { authorization: `Bearer ${desc.token}` } },
    timeoutMs + 2000 // give the server its own timeout budget plus a little
  );
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ? `: ${body.error}` : "";
    } catch {
      // body wasn't JSON
    }
    throw new Error(`control plane returned HTTP ${res.status}${detail}`);
  }
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const source = (res.headers.get("x-helm-snapshot-source") as "cache" | "direct") ?? "direct";
  const capturedAt = Number(res.headers.get("x-helm-captured-at") ?? Date.now());
  const vehicleId = res.headers.get("x-helm-vehicle-id") ?? undefined;
  const vehicleName = res.headers.get("x-helm-vehicle-name") ?? undefined;
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType, source, capturedAt, vehicleId, vehicleName };
}
