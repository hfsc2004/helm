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
        activeCode = null;
        activeDirection = null;
        stopPending = true;
      }
    } catch {
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
    void window.helm.vehicle.sensorBoardUno({ vehicleId, action: "status" })
      .then((response) => { supported = response.ok && response.driveCommandVersion === 1; })
      .catch(() => { supported = false; });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
  });

  onDestroy(() => {
    disposed = true;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    if (activeDirection || stopPending) releaseDrive();
  });
</script>
