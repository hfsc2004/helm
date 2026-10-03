<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { InputMode } from "../stores/inputMode";

  export let vehicleId: string;
  export let mode: InputMode;

  type Direction = "left" | "right" | "forward" | "reverse";
  const SPEED = 160;
  const PULSE_MS = 600;
  const REPULSE_MS = 300;

  let supported = false;
  let activeCode: string | null = null;
  let activeDirection: Direction | null = null;
  let inFlight = false;
  let stopPending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let statusInFlight = false;
  let bridgeError = "";
  let driveError = "";

  async function checkBridge(): Promise<void> {
    if (disposed || statusInFlight) return;
    statusInFlight = true;
    try {
      const response = await window.helm.vehicle.sensorBoardUno({ vehicleId, action: "status" });
      if (disposed) return;
      supported = response.ok && response.uartReady === true && response.driveCommandVersion === 1;
      bridgeError = supported ? "" : response.error || "Drive bridge is not ready.";
    } catch (error) {
      if (disposed) return;
      supported = false;
      bridgeError = error instanceof Error ? error.message : String(error);
    } finally {
      statusInFlight = false;
      if (!supported && activeDirection) releaseDrive();
    }
  }

  function directionFor(code: string): Direction | null {
    if (mode === "numpad") {
      const key = code.replace(/^Digit/, "Numpad");
      if (key === "Numpad8") return "forward";
      if (key === "Numpad2") return "reverse";
      if (["Numpad4", "Numpad7", "Numpad1"].includes(key)) return "left";
      if (["Numpad6", "Numpad9", "Numpad3"].includes(key)) return "right";
      return null;
    }
    if (mode !== "wasd") return null;
    if (code === "KeyW") return "forward";
    if (code === "KeyS") return "reverse";
    if (["KeyA", "KeyQ", "KeyZ"].includes(code)) return "left";
    if (["KeyD", "KeyE", "KeyC"].includes(code)) return "right";
    return null;
  }

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  async function sendStop(): Promise<void> {
    if (inFlight) return;
    stopPending = false;
    inFlight = true;
    try {
      await window.helm.vehicle.sensorBoardUno({ vehicleId, action: "drive-stop" });
    } catch (error) {
      driveError = `Stop could not be delivered: ${String(error)}`;
    } finally {
      inFlight = false;
      if (activeDirection && !disposed) void sendPulse();
    }
  }

  async function sendPulse(): Promise<void> {
    if (inFlight || !activeDirection || !supported || disposed) return;
    const direction = activeDirection;
    inFlight = true;
    try {
      const response = await window.helm.vehicle.sensorBoardUno({
        vehicleId, action: "drive", direction, speed: SPEED, ms: PULSE_MS,
      });
      if (!response.ok) {
        driveError = response.error || "Drive command was rejected.";
        activeCode = null;
        activeDirection = null;
        stopPending = true;
      }
      else driveError = "";
    } catch (error) {
      driveError = error instanceof Error ? error.message : String(error);
      activeCode = null;
      activeDirection = null;
      stopPending = true;
    } finally {
      inFlight = false;
      if (stopPending) void sendStop();
      else if (activeDirection && !disposed) {
        clearTimer();
        timer = setTimeout(() => void sendPulse(), REPULSE_MS);
      }
    }
  }

  function releaseDrive(): void {
    activeCode = null;
    activeDirection = null;
    clearTimer();
    stopPending = true;
    if (!inFlight) void sendStop();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
    const stopKey = event.code === "Space" ||
      (mode === "numpad" && ["Numpad0", "Digit0"].includes(event.code)) ||
      (mode === "wasd" && event.code === "KeyX");
    if (stopKey) {
      event.preventDefault();
      releaseDrive();
      return;
    }
    const direction = directionFor(event.code);
    if (!direction || !supported) return;
    event.preventDefault();
    if (activeCode === event.code) return;
    activeCode = event.code;
    activeDirection = direction;
    clearTimer();
    if (!inFlight) void sendPulse();
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.code !== activeCode) return;
    event.preventDefault();
    releaseDrive();
  }

  function onBlur(): void {
    if (activeDirection) releaseDrive();
  }

  onMount(() => {
    void checkBridge();
    const statusTimer = setInterval(() => { void checkBridge(); }, 2000);
    const onFocus = () => { void checkBridge(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => { clearInterval(statusTimer); window.removeEventListener("focus", onFocus); };
  });

  onDestroy(() => {
    disposed = true;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    if (activeDirection || stopPending) releaseDrive();
  });
</script>

<section aria-label="Keyboard driving status">
  <div class="heading"><strong>Driving</strong><span class:ready={supported}>{supported ? "Bridge ready" : "Reconnecting…"}</span></div>
  {#if mode === "wasd" || mode === "numpad"}
    <p>{mode === "wasd" ? "WASD" : "NumPad"} controls. Click outside text fields before driving.</p>
  {:else}
    <p>Select Keyboard WASD or Keyboard NumPad in Settings to drive this board.</p>
  {/if}
  {#if bridgeError || driveError}<p class="error" role="status">{driveError || bridgeError}</p>{/if}
</section>

<style>
  section { padding: .8rem 1rem; border-bottom: 1px solid var(--border); }
  .heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; font-size: .85rem; }
  .heading span { color: var(--muted); font-size: .75rem; }
  .heading .ready { color: #80d0a0; }
  p { margin: .4rem 0 0; font-size: .75rem; color: var(--muted); line-height: 1.4; }
  .error { color: #ff9090; overflow-wrap: anywhere; }
</style>
