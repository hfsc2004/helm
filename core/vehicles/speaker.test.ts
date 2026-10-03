// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resolveSpeakerEndpoint } from "./speaker.js";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("updated firmware routes audio to its own server without mutating the diagnostics URL", async () => {
  const endpoint = new URL("http://sensor.test:82/speaker-pcm");
  globalThis.fetch = async input => {
    assert.equal(String(input), "http://sensor.test:83/health");
    return Response.json({ ok: true, service: "psf-speaker" });
  };
  assert.equal(String(await resolveSpeakerEndpoint(endpoint)), "http://sensor.test:83/speaker-pcm");
  assert.equal(endpoint.port, "82");
});

test("older firmware and unrelated services keep legacy playback", async () => {
  const endpoint = new URL("http://sensor.test:82/speaker-pcm");
  globalThis.fetch = async () => new Response("Not found", { status: 404 });
  assert.equal(await resolveSpeakerEndpoint(endpoint), endpoint);
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await resolveSpeakerEndpoint(endpoint), endpoint);
  globalThis.fetch = async () => Response.json({ ok: true, service: "unrelated" });
  assert.equal(await resolveSpeakerEndpoint(endpoint), endpoint);
});

test("explicit custom speaker ports bypass discovery", async () => {
  globalThis.fetch = async () => { throw new Error("Must not probe custom endpoints"); };
  const endpoint = new URL("http://sensor.test:9000/speaker-pcm");
  assert.equal(await resolveSpeakerEndpoint(endpoint), endpoint);
});
