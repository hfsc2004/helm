// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SensorBoardWideRange } from "@shared/ipc-channels";
import { wideTofCells } from "./wide-tof-display";

const frame = (distance: number, resolution: 16 | 64 = 16): SensorBoardWideRange => ({
  ok: true, ready: true, resolution,
  rawDistanceMm: Array(resolution).fill(distance), targetStatus: Array(resolution).fill(5),
});

test("same cell changes from nearby orange to metre-range blue and purple", () => {
  assert.equal(wideTofCells(frame(300), 4)[0].color, "#f58135");
  assert.equal(wideTofCells(frame(2157), 4)[0].color, "#4d8cf5");
  const distant = wideTofCells(frame(3151), 4)[0];
  assert.equal(distant.color, "#ae7bf4");
  assert.match(distant.title, /3.15 m/);
});

test("color expires when the clock advances even without a new frame", () => {
  const held = frame(300);
  assert.equal(wideTofCells(held, 2000)[0].valid, true);
  const stale = wideTofCells(held, 2001)[0];
  assert.equal(stale.valid, false);
  assert.equal(stale.color, "var(--surface-2, #20272e)");
});

test("an invalid return replaces the previous colored measurement", () => {
  const next = frame(300);
  next.targetStatus![0] = 255;
  assert.equal(wideTofCells(next, 4)[0].valid, false);
  assert.equal(wideTofCells(next, 4)[1].valid, true);
});

test("grid dimensions follow the current frame and no old frame survives a switch", () => {
  assert.equal(wideTofCells(frame(300, 64), 4).length, 64);
  const small = wideTofCells(frame(300, 16), 4);
  assert.equal(small.length, 16);
  assert.match(small[4].title, /Row 2, column 1/);
  assert.deepEqual(wideTofCells({ ok: true, ready: false, resolution: 16 }, 4), []);
});
