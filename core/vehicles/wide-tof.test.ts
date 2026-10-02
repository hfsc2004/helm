// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Vehicle } from "../../shared/vehicle-contract.js";
import { configureWideTof, readWideTof } from "./wide-tof.js";

const vehicle = {
  sensorBoardRevision: "1.3", camera: { baseUrl: "http://sensor.local:81" },
} as Vehicle;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Fast requests 4×4 profile at 60 Hz through the diagnostic port", async () => {
  globalThis.fetch = async (input, options) => {
    assert.equal(String(input), "http://sensor.local:82/wide-tof-config?profile=fast&hz=60");
    assert.equal(options?.method, "POST");
    return Response.json({ ok: true, ready: false, profile: "fast", profileControlVersion: 1, resolution: 16, frequencyHz: 60 });
  };
  const result = await configureWideTof(vehicle, "fast", undefined, 60);
  assert.equal(result.ok, true);
  assert.equal(result.resolution, 16);
  assert.equal(result.ready, false);
});

test("profile frequency bounds reject incompatible rates before any request", async () => {
  globalThis.fetch = async () => { throw new Error("must not contact board"); };
  for (const [profile, hz] of [["fast", 61], ["fast", 29], ["navigation", 16], ["idle", 3], ["detail", 5], ["inspect", 4], ["fast", 30.5]] as const) {
    const result = await configureWideTof(vehicle, profile, undefined, hz);
    assert.equal(result.ok, false);
    assert.match(result.error!, /profile range/);
  }
});

test("status uses GET and preserves autonomous idle metadata", async () => {
  globalThis.fetch = async (input, options) => {
    assert.equal(String(input), "http://sensor.local:82/wide-tof-config");
    assert.equal(options?.method, "GET");
    return Response.json({ ok: true, ready: true, profile: "idle", profileControlVersion: 1,
      resolution: 16, frequencyHz: 2, rangingMode: "autonomous", integrationMs: 5 });
  };
  const result = await configureWideTof(vehicle);
  assert.equal(result.rangingMode, "autonomous");
  assert.equal(result.integrationMs, 5);
});

test("old firmware returns an actionable upgrade message even for plain-text 404", async () => {
  globalThis.fetch = async () => new Response("Not found", { status: 404 });
  assert.match((await configureWideTof(vehicle, "detail")).error!, /Update.*firmware/);
});

test("a failed switch does not become an acknowledged profile", async () => {
  globalThis.fetch = async () => Response.json({ ok: false, error: "profile change failed" }, { status: 503 });
  assert.equal((await configureWideTof(vehicle, "fast")).ok, false);
  globalThis.fetch = async () => Response.json({ ok: true, ready: true, resolution: 64,
    profile: "detail", profileControlVersion: 1, frequencyHz: 10 });
  assert.equal((await configureWideTof(vehicle, "fast")).ok, false);
});

test("frame size must match advertised resolution", async () => {
  globalThis.fetch = async () => Response.json({ ok: true, ready: true, resolution: 16,
    rawDistanceMm: Array(64).fill(250), targetStatus: Array(64).fill(5) });
  assert.equal((await readWideTof(vehicle)).ok, false);
});

test("16-zone and legacy 64-zone frames retain their actual dimensions", async () => {
  for (const resolution of [16, 64]) {
    globalThis.fetch = async () => Response.json({ ok: true, ready: true,
      ...(resolution === 16 ? { resolution } : {}),
      ageMs: 120, rawDistanceMm: Array(resolution).fill(500), targetStatus: Array(resolution).fill(5) });
    const result = await readWideTof(vehicle);
    assert.equal(result.ok, true);
    assert.equal(result.rawDistanceMm!.length, resolution);
  }
});

test("a waiting frame after switching is accepted without old distance arrays", async () => {
  globalThis.fetch = async () => Response.json({ ok: true, ready: false, resolution: 16, profile: "fast" }, { status: 202 });
  const result = await readWideTof(vehicle);
  assert.equal(result.ok, true);
  assert.equal(result.rawDistanceMm, undefined);
});

test("Inspect frames expose diagnostic arrays and use an explicit base URL", async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://bench.local:8082/wide-range");
    return Response.json({ ok: true, ready: true, resolution: 64, profile: "inspect",
      rawDistanceMm: Array(64).fill(300), targetStatus: Array(64).fill(9),
      signalKcpsPerSpad: Array(64).fill(42), ambientKcpsPerSpad: Array(64).fill(7), targetCount: Array(64).fill(1) });
  };
  const result = await readWideTof(vehicle, "http://bench.local:8082");
  assert.equal(result.signalKcpsPerSpad![0], 42);
  assert.equal(result.ambientKcpsPerSpad![0], 7);
});
