<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { fleet } from "../stores/vehicles";
  import { activity } from "../stores/activity";
  import { driveSpeed } from "../stores/driveSpeed";
  import type { SkidSteerAction } from "@shared/vehicle-contract";

  /**
   * Game-controller driver.
   *
   * Polls navigator.getGamepads() via requestAnimationFrame. Left-stick
   * X/Y → tank-mix. South button (button 0; A on Xbox, X on PS) = stop.
   * North button (button 3; Y on Xbox, Triangle on PS) = CW 180.
   *
   * Send-rate is throttled to ~150ms so the firmware deadman stays alive
   * but we don't spam Wi-Fi with a packet per frame. A "stop" packet goes
   * out as soon as the stick re-enters the deadzone.
   */

  const DEADZONE = 0.18;
  const SEND_INTERVAL_MS = 150;
  const CW_180_MS = 820;

  let connected: { index: number; id: string } | null = null;
  let lastError: string | null = null;
  let busy = false;
  let frame: number | null = null;
  let lastSentAt = 0;
  let lastDrove = false;
  let stopped = true;

  // Debounce face buttons so a single press doesn't fire on every frame.
  let prevSouth = false;
  let prevNorth = false;

  function snapshot(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (p && p.connected) return p;
    }
    return null;
  }

  async function send(action: SkidSteerAction, log: boolean): Promise<void> {
    if (!$fleet.selectedId) return;
    if (log) {
      activity.push({
        who: "human",
        kind: action.kind === "stop" ? "stop" : "cmd",
        message:
          action.kind === "tank"
            ? `tank L${action.left} R${action.right}`
            : action.kind === "turn"
              ? `turn ${action.signed}${action.durationMs ? ` ${action.durationMs}ms` : ""}`
              : action.kind,
      });
    }
    try {
      busy = true;
      const res = await window.helm.vehicle.cmd({
        vehicleId: $fleet.selectedId,
        action,
      });
      if (!res.ok) {
        lastError = res.error ?? "command rejected";
      } else {
        lastError = null;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function clampAxis(v: number): number {
    if (Math.abs(v) < DEADZONE) return 0;
    // Re-scale post-deadzone so a tiny movement past the threshold isn't
    // immediately full-throttle.
    const sign = v < 0 ? -1 : 1;
    const mag = (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
    return sign * Math.min(1, mag);
  }

  function tankMix(stickX: number, stickY: number): { left: number; right: number } {
    // y up = forward (browser gamepads report y-down positive, so invert).
    const fwd = -stickY;
    const turn = stickX;
    // Classic differential mix; clamp so combined magnitudes don't exceed range.
    let left = fwd + turn;
    let right = fwd - turn;
    const max = Math.max(Math.abs(left), Math.abs(right), 1);
    left /= max;
    right /= max;
    const cap = get(driveSpeed); // slider sets the ceiling for stick output
    return {
      left: Math.round(left * cap),
      right: Math.round(right * cap),
    };
  }

  function poll() {
    const pad = snapshot();
    if (!pad) {
      if (connected) {
        connected = null;
        if (!stopped) {
          stopped = true;
          void send({ kind: "stop" }, false);
        }
      }
      frame = requestAnimationFrame(poll);
      return;
    }
    if (!connected || connected.index !== pad.index) {
      connected = { index: pad.index, id: pad.id };
    }

    const axX = clampAxis(pad.axes[0] ?? 0);
    const axY = clampAxis(pad.axes[1] ?? 0);

    // Face buttons (edge-triggered).
    const south = pad.buttons[0]?.pressed ?? false;
    const north = pad.buttons[3]?.pressed ?? false;
    if (south && !prevSouth) {
      // STOP button — kill any active drive and tell the truck to halt.
      stopped = true;
      void send({ kind: "stop" }, true);
    }
    if (north && !prevNorth) {
      // CW 180 — fire-and-forget timed turn using the slider's speed.
      void send(
        { kind: "turn", signed: get(driveSpeed), durationMs: CW_180_MS },
        true
      );
    }
    prevSouth = south;
    prevNorth = north;

    const driving = axX !== 0 || axY !== 0;
    const now = performance.now();

    if (driving) {
      if (now - lastSentAt >= SEND_INTERVAL_MS) {
        const { left, right } = tankMix(axX, axY);
        void send({ kind: "tank", left, right }, false);
        lastSentAt = now;
        stopped = false;
        lastDrove = true;
      }
    } else if (lastDrove && !stopped) {
      // Stick just returned to neutral — send one stop.
      stopped = true;
      void send({ kind: "stop" }, false);
      lastSentAt = now;
      lastDrove = false;
    }

    frame = requestAnimationFrame(poll);
  }

  function onConnect(e: GamepadEvent) {
    connected = { index: e.gamepad.index, id: e.gamepad.id };
  }
  function onDisconnect(e: GamepadEvent) {
    if (connected?.index === e.gamepad.index) {
      connected = null;
      if (!stopped) {
        stopped = true;
        void send({ kind: "stop" }, false);
      }
    }
  }

  onMount(() => {
    window.addEventListener("gamepadconnected", onConnect);
    window.addEventListener("gamepaddisconnected", onDisconnect);
    // Some browsers don't fire gamepadconnected until the first input —
    // start polling immediately so we pick it up either way.
    frame = requestAnimationFrame(poll);
  });
  onDestroy(() => {
    window.removeEventListener("gamepadconnected", onConnect);
    window.removeEventListener("gamepaddisconnected", onDisconnect);
    if (frame !== null) cancelAnimationFrame(frame);
    if (!stopped) {
      stopped = true;
      void send({ kind: "stop" }, false);
    }
  });
</script>

<section>
  <h3>
    Game Controller
    <span class="aux">stick = drive · A/X = stop · Y/△ = CW 180</span>
  </h3>

  {#if connected}
    <p class="ok">
      <span class="dot ok"></span>
      Connected — <code>{connected.id}</code>
    </p>
  {:else}
    <p class="muted">
      <span class="dot"></span>
      No controller detected. Plug in and press any button to wake it.
    </p>
  {/if}

  {#if lastError}
    <p class="error">{lastError}</p>
  {/if}

  {#if busy}<span class="busy-hint">…</span>{/if}
</section>

<style>
  section {
    padding: 1rem;
    border-bottom: 1px solid var(--border, #30363d);
  }
  h3 {
    margin: 0 0 0.6rem 0;
    font-size: 0.7rem;
    color: var(--muted, #8b949e);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .aux {
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.7rem;
  }
  p {
    margin: 0.25rem 0 0 0;
    font-size: 0.8rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .muted { color: var(--muted, #8b949e); }
  .ok { color: var(--good, #3fb950); }
  .error { color: var(--danger, #f85149); }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted, #8b949e);
  }
  .dot.ok { background: var(--good, #3fb950); }
  code {
    background: var(--surface-2, #1c232c);
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
  }
  .busy-hint {
    color: var(--muted, #8b949e);
    font-size: 0.7rem;
  }
</style>
