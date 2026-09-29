<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import { onMount } from "svelte";
  import type { SensorBoardUnoRequest, SensorBoardUnoResponse } from "@shared/ipc-channels";

  export let vehicleId: string;

  let busy = false;
  let wheelsClear = false;
  let servoChannel: 1 | 2 = 1;
  let status: SensorBoardUnoResponse | null = null;
  let last: SensorBoardUnoResponse | null = null;
  let lastAction = "";

  async function run(action: SensorBoardUnoRequest["action"], details: Partial<SensorBoardUnoRequest> = {}) {
    if (busy && action !== "stop") return;
    if (action !== "stop") busy = true;
    lastAction = action;
    try {
      const response = await window.helm.vehicle.sensorBoardUno({ vehicleId, action, ...details });
      if (action === "status") status = response;
      last = response;
    } catch (error) {
      last = { ok: false, error: String(error) };
    } finally {
      if (action !== "stop") busy = false;
    }
  }

  function pulse(direction: "left" | "right" | "forward" | "reverse") {
    if (wheelsClear) void run("motor", { direction, speed: 80, ms: 200 });
  }

  onMount(() => { void run("status"); });
</script>

<section class="uno-panel">
  <h2>ELEGOO Uno tests</h2>
  <p class="hint">UART on GPIO43/44, initially 9600 baud. “UART ready” means the ESP port opened—not that the Uno replied.</p>
  <div class="controls">
    <button disabled={busy} on:click={() => run("status")}>UART status</button>
    <button disabled={busy} on:click={() => run("ultrasonic")}>Ultrasonic</button>
    <button disabled={busy} on:click={() => run("line")}>Line tracker</button>
  </div>
  <div class="controls">
    <label>Servo header <select bind:value={servoChannel}><option value={1}>D10</option><option value={2}>D11</option></select></label>
    <button disabled={busy || status?.servoCommandVersion !== 2} on:click={() => run("servo", { channel: servoChannel, angle: 70 })}>Servo 70°</button>
    <button disabled={busy || status?.servoCommandVersion !== 2} on:click={() => run("servo", { channel: servoChannel, angle: 90 })}>90°</button>
    <button disabled={busy || status?.servoCommandVersion !== 2} on:click={() => run("servo", { channel: servoChannel, angle: 110 })}>110°</button>
  </div>
  <p class="hint">Servo controls require updated ESP firmware. Start near 90° and watch rear-cable slack; the stock Uno sketch moves in 10° steps.</p>
  <div class="controls">
    <button disabled={busy} on:click={() => run("rgb-off")}>Shield RGB off</button>
  </div>
  <label class="wheel-check"><input type="checkbox" bind:checked={wheelsClear} /> Wheels clear of the ground for motor tests</label>
  <p class="hint">Four wheels share left and right motor channels. Each test is an 80/255, 200 ms pulse.</p>
  <div class="controls">
    <button disabled={busy || !wheelsClear} on:click={() => pulse("forward")}>Forward</button>
    <button disabled={busy || !wheelsClear} on:click={() => pulse("reverse")}>Reverse</button>
    <button disabled={busy || !wheelsClear} on:click={() => pulse("left")}>Left</button>
    <button disabled={busy || !wheelsClear} on:click={() => pulse("right")}>Right</button>
    <button class="stop" on:click={() => run("stop")}>STOP</button>
  </div>
  {#if status?.ok}
    <p class="hint">ESP UART: {status.uartReady ? "ready" : "unavailable"} · {status.baud} baud · last received: {status.lastRxAgeMs == null ? "never" : `${status.lastRxAgeMs} ms ago`}</p>
  {/if}
  {#if last}
    <p class="result" class:error={!last.ok}>{lastAction}: {last.error ?? JSON.stringify(last)}</p>
  {/if}
</section>

<style>
  .uno-panel { padding: 1rem; border-bottom: 1px solid var(--border); color: var(--text); }
  h2 { font-size: 1rem; margin: 0 0 0.4rem; }
  .hint { color: var(--muted); font-size: 0.75rem; line-height: 1.4; margin: 0.4rem 0; }
  .controls { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.5rem 0; }
  button { padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-2, #20272e); color: var(--text); cursor: pointer; font-size: 0.75rem; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button.stop { border-color: #dc5656; color: #ffb9b9; font-weight: 700; }
  .wheel-check { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.7rem; font-size: 0.75rem; }
  .result { overflow-wrap: anywhere; font-size: 0.73rem; line-height: 1.4; margin: 0.5rem 0 0; }
  .result.error { color: #ff9c9c; }
</style>
