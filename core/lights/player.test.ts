// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { LightPlayer } from "./player.js";
import { lightLineDuration, validateLightScript, type LightAction, type LightScript } from "../../shared/light-scripts.js";

const originalFetch = globalThis.fetch;
const players = new Set<LightPlayer>();
const endpoint = new URL("http://sensor.test:82");
function player(): LightPlayer { const result = new LightPlayer(); players.add(result); return result; }
function light(target: LightAction["target"], extra: Partial<LightAction> = {}): LightAction {
  return { target, mode: "flash", r: 100, g: 0, b: 0, w: 0, flashes: 1, durationMs: 100, ...extra };
}
function show(actions: LightAction[]): LightScript { return { id: "show", name: "show", lines: [{ actions, durationMs: 100 }] }; }
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), "Playback did not reach expected state within three seconds");
}
afterEach(async () => {
  for (const item of players) await item.stop();
  players.clear();
  globalThis.fetch = originalFetch;
});

test("legacy scripts retain colors, flashes and No Action duration", () => {
  const action = light("LED1");
  const old = { id: "old", name: "old", lines: [action, { ...action, target: "No Action", durationMs: 2000 }] };
  const result = validateLightScript(old as unknown as LightScript);
  assert.deepEqual(result.lines[0]!.actions[0], action);
  assert.deepEqual(result.lines[1], { actions: [], durationMs: 2000 });
  assert.throws(() => validateLightScript(show([action, action])), /only once/);
});

test("selected lights start together and retain independent colors and flash counts", async () => {
  const writes: URL[] = [];
  let release!: () => void;
  const startBarrier = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input)); writes.push(url);
    if (Number(url.searchParams.get("r")) > 0 && started < 2) {
      if (++started === 2) release();
      await startBarrier;
    }
    return Response.json({ ok: true });
  };
  const script = show([light("LED1", { flashes: 2, w: 20 }), light("LED2", { r: 50, w: 100, durationMs: 150 })]);
  const p = player(); await p.start(script, endpoint); await until(() => !p.status().running);
  assert.equal(p.status().error, "");
  assert.equal(started, 2);
  assert.ok(writes.slice(0, 2).every(url => Number(url.searchParams.get("r")) > 0));
  assert.equal(writes.filter(url => url.searchParams.get("index") === "0" && url.searchParams.get("r") === "100").length, 2);
  assert.equal(writes.filter(url => url.searchParams.get("index") === "1" && url.searchParams.get("r") === "50").length, 1);
  assert.equal(writes[0]!.searchParams.get("w"), "20");
  assert.equal(writes[1]!.searchParams.get("w"), "100");
  assert.equal(lightLineDuration(script.lines[0]!), 400);
});

test("steady headlights remain on across loop repeats; Stop turns every light off", async () => {
  const writes: URL[] = [];
  globalThis.fetch = async input => { writes.push(new URL(String(input))); return Response.json({ ok: true }); };
  const script = show(["LED1", "LED2", "LED3"].map(target => light(target as LightAction["target"], { mode: "steady", r: 0, w: 255 })));
  const p = player(); await p.start(script, endpoint, true);
  await until(() => writes.length >= 9);
  assert.ok(writes.every(url => url.searchParams.get("w") === "255"));
  assert.equal(p.status().looping, true);
  await p.stop();
  assert.equal(p.status().running, false);
  for (const index of [0, 1, 2]) assert.equal(writes.filter(url => url.searchParams.get("index") === String(index)).at(-1)!.searchParams.get("w"), "0");
  const count = writes.length;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(writes.length, count);
});

test("No Action issues no light command and uses its own pause duration", async () => {
  globalThis.fetch = async () => { throw new Error("No Action must not contact the robot"); };
  const p = player(); const script: LightScript = { id: "pause", name: "pause", lines: [{ actions: [], durationMs: 100 }] };
  const started = Date.now(); await p.start(script, endpoint); await until(() => !p.status().running);
  assert.ok(Date.now() - started >= 90);
  assert.equal(p.status().error, "");
});

test("looping network failure stops the show and attempts off cleanup", async () => {
  let requests = 0;
  globalThis.fetch = async () => Response.json({ ok: ++requests !== 1 }, { status: requests === 1 ? 503 : 200 });
  const p = player(); await p.start(show([light("LED1")]), endpoint, true); await until(() => !p.status().running);
  assert.match(p.status().error, /503/);
  assert.equal(p.status().looping, false);
  assert.equal(requests, 2);
});

test("unknown ESP32 GPIOs and missing IR firmware reject before a show starts", async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response("Not found", { status: 404 }); };
  const p = player();
  await assert.rejects(p.start(show([light("ESP32-LED4")]), endpoint), /GPIO/);
  assert.equal(requests, 0);
  await assert.rejects(p.start(show([light("IR")]), endpoint), /firmware/);
  assert.equal(requests, 1);
  assert.equal(p.status().running, false);
});
