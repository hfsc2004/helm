<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { fleet } from "../stores/vehicles";
  import { activity } from "../stores/activity";
  import { driveSpeed } from "../stores/driveSpeed";
  import type { SkidSteerAction } from "@shared/vehicle-contract";

  // Layout & semantics mirror core-ce's Gateway Card Numpad.
  //
  // Two keyboard-input modes (selected from the Devices tab):
  //
  //   mode = "numpad"
  //     Numpad 8 / Digit 8           = hold forward
  //     Numpad 2 / Digit 2           = hold reverse
  //     Numpad 4 / 7 / 1 / Digit 4-7-1 = hold left
  //     Numpad 6 / 9 / 3 / Digit 6-9-3 = hold right
  //     Numpad 5 / Digit 5           = press → CW 180°
  //     Numpad 0 / Digit 0           = stop
  //
  //   mode = "wasd"
  //     W       = hold forward
  //     S       = hold reverse
  //     A / Q / Z = hold left
  //     D / E / C = hold right
  //     R       = press → CW 180°
  //     X       = stop
  //
  // Pointer buttons in the grid work in both modes (touch / click fallback).

  export let mode: "wasd" | "numpad" = "wasd";

  const HOLD_PULSE_MS = 180;       // matches core-ce; keeps the firmware deadman alive
  const CW_180_MS = 820;           // core-ce ESP32_NUMPAD_CW_180_MS

  type Direction = "forward" | "reverse" | "left" | "right";

  let busy = false;
  let lastError: string | null = null;
  let activeDirection: Direction | null = null;
  let pulseTimer: ReturnType<typeof setInterval> | null = null;

  // Track which keys are currently held so OS auto-repeat (keydown spam)
  // doesn't re-trigger startDrive on every event.
  const held = new Set<string>();

  function actionFor(direction: Direction): SkidSteerAction {
    // Read the slider value at command time (not on subscribe) so adjusting
    // the slider mid-hold takes effect on the next pulse.
    const speed = get(driveSpeed);
    switch (direction) {
      case "forward":
        return { kind: "fwd", speed };
      case "reverse":
        return { kind: "rev", speed };
      case "left":
        return { kind: "turn", signed: -speed };
      case "right":
        return { kind: "turn", signed: speed };
    }
  }

  function summary(action: SkidSteerAction): string {
    switch (action.kind) {
      case "stop":
        return "stop";
      case "fwd":
        return `fwd ${action.speed}${action.durationMs ? ` ${action.durationMs}ms` : ""}`;
      case "rev":
        return `rev ${action.speed}${action.durationMs ? ` ${action.durationMs}ms` : ""}`;
      case "turn":
        return `turn ${action.signed}${action.durationMs ? ` ${action.durationMs}ms` : ""}`;
      case "tank":
        return `tank L${action.left} R${action.right}`;
    }
  }

  async function send(action: SkidSteerAction, log: boolean = true): Promise<void> {
    if (!$fleet.selectedId) return;
    if (log) {
      activity.push({
        who: "human",
        kind: action.kind === "stop" ? "stop" : "cmd",
        message: summary(action),
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
        activity.push({ who: "local", kind: "error", message: lastError });
      } else {
        lastError = null;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      activity.push({ who: "local", kind: "error", message: lastError });
    } finally {
      busy = false;
    }
  }

  function startDrive(direction: Direction): void {
    if (!$fleet.selectedId) return;
    if (activeDirection === direction) return;
    if (activeDirection && activeDirection !== direction) {
      // Switching directions mid-hold: drop the old pulse and start fresh.
      stopPulse();
    }
    activeDirection = direction;
    activity.push({
      who: "human",
      kind: "cmd",
      message: `hold ${direction}`,
    });
    // First pulse goes out immediately; subsequent pulses keep the deadman alive.
    void send(actionFor(direction), false);
    pulseTimer = setInterval(() => {
      if (!activeDirection) {
        stopPulse();
        return;
      }
      void send(actionFor(activeDirection), false);
    }, HOLD_PULSE_MS);
  }

  function stopPulse(): void {
    if (pulseTimer) {
      clearInterval(pulseTimer);
      pulseTimer = null;
    }
    activeDirection = null;
  }

  function releaseDrive(): void {
    if (!activeDirection) return;
    stopPulse();
    void send({ kind: "stop" });
  }

  function pressStop(): void {
    stopPulse();
    void send({ kind: "stop" });
  }

  async function cw180(): Promise<void> {
    if (!$fleet.selectedId) return;
    // Make sure no hold is active first.
    stopPulse();
    await send(
      { kind: "turn", signed: get(driveSpeed), durationMs: CW_180_MS },
      true
    );
  }

  // ---------------- keyboard ----------------

  /** Canonicalize a KeyboardEvent.code into a "Numpad<N>" code, but only
   *  for keys belonging to the active input mode. Keys outside the active
   *  family return null so they don't drive the truck. */
  function toNumpadCode(e: KeyboardEvent): string | null {
    const c = e.code;
    if (mode === "numpad") {
      if (/^Numpad[0-9]$/.test(c)) return c;
      if (/^Digit[0-9]$/.test(c)) return "Numpad" + c.replace("Digit", "");
      return null;
    }
    // mode === "wasd"
    switch (c) {
      case "KeyW": return "Numpad8";
      case "KeyA": return "Numpad4";
      case "KeyS": return "Numpad2";
      case "KeyD": return "Numpad6";
      case "KeyQ": return "Numpad7";
      case "KeyE": return "Numpad9";
      case "KeyZ": return "Numpad1";
      case "KeyC": return "Numpad3";
      case "KeyR": return "Numpad5";
      case "KeyX": return "Numpad0";
      default: return null;
    }
  }

  function dirForCode(code: string): Direction | null {
    if (code === "Numpad8") return "forward";
    if (code === "Numpad2") return "reverse";
    if (code === "Numpad4" || code === "Numpad7" || code === "Numpad1") return "left";
    if (code === "Numpad6" || code === "Numpad9" || code === "Numpad3") return "right";
    return null;
  }

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    const code = toNumpadCode(e);
    if (!code) return;
    e.preventDefault();
    if (held.has(code)) return; // OS auto-repeat
    held.add(code);

    if (code === "Numpad0") {
      pressStop();
      return;
    }
    if (code === "Numpad5") {
      void cw180();
      return;
    }
    const dir = dirForCode(code);
    if (dir) startDrive(dir);
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    const code = toNumpadCode(e);
    if (!code) return;
    e.preventDefault();
    held.delete(code);

    if (code === "Numpad0" || code === "Numpad5") return;
    const dir = dirForCode(code);
    if (!dir) return;
    // Only release if this key actually drove the current direction.
    if (activeDirection === dir) releaseDrive();
  }

  // If user alt-tabs / switches workspaces mid-hold, send a stop so the
  // robot doesn't keep rolling.
  function onBlur(): void {
    held.clear();
    if (activeDirection) releaseDrive();
  }

  // ---------------- pointer (touch / mouse) ----------------

  function holdStart(direction: Direction): void {
    startDrive(direction);
  }
  function holdEnd(): void {
    if (activeDirection) releaseDrive();
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
  });
  onDestroy(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    if (activeDirection) {
      stopPulse();
      void send({ kind: "stop" }, false);
    }
  });
</script>

<section>
  <h3>
    {mode === "wasd" ? "Keyboard WASD" : "Keyboard NumPad"}
    <span class="aux">
      {#if mode === "wasd"}
        WASD/QEZC · R = CW 180 · X = stop
      {:else}
        Numpad 8/2/4/6 (& 7/9/1/3) · 5 = CW 180 · 0 = stop
      {/if}
    </span>
  </h3>

  <div class="grid" class:busy>
    <button
      class="accent"
      class:active={activeDirection === "forward"}
      on:pointerdown={() => holdStart("forward")}
      on:pointerup={holdEnd}
      on:pointercancel={holdEnd}
      on:pointerleave={holdEnd}
    >
      <span class="kc">7</span><span class="lbl">LEFT</span>
    </button>
    <button
      class="accent"
      class:active={activeDirection === "forward"}
      on:pointerdown={() => holdStart("forward")}
      on:pointerup={holdEnd}
      on:pointercancel={holdEnd}
      on:pointerleave={holdEnd}
    >
      <span class="kc">8</span><span class="lbl">FWD</span>
    </button>
    <button
      class="accent"
      class:active={activeDirection === "right"}
      on:pointerdown={() => holdStart("right")}
      on:pointerup={holdEnd}
      on:pointercancel={holdEnd}
      on:pointerleave={holdEnd}
    >
      <span class="kc">9</span><span class="lbl">RIGHT</span>
    </button>

    <button
      class="accent"
      class:active={activeDirection === "left"}
      on:pointerdown={() => holdStart("left")}
      on:pointerup={holdEnd}
      on:pointercancel={holdEnd}
      on:pointerleave={holdEnd}
    >
      <span class="kc">4</span><span class="lbl">LEFT</span>
    </button>
    <button class="warn" on:click={cw180}>
      <span class="kc">5</span><span class="lbl">CW 180</span>
    </button>
    <button
      class="accent"
      class:active={activeDirection === "right"}
      on:pointerdown={() => holdStart("right")}
      on:pointerup={holdEnd}
      on:pointercancel={holdEnd}
      on:pointerleave={holdEnd}
    >
      <span class="kc">6</span><span class="lbl">RIGHT</span>
    </button>

    <button
      class="accent"
      class:active={activeDirection === "left"}
      on:pointerdown={() => holdStart("left")}
      on:pointerup={holdEnd}
      on:pointercancel={holdEnd}
      on:pointerleave={holdEnd}
    >
      <span class="kc">1</span><span class="lbl">LEFT</span>
    </button>
    <button
      class="accent"
      class:active={activeDirection === "reverse"}
      on:pointerdown={() => holdStart("reverse")}
      on:pointerup={holdEnd}
      on:pointercancel={holdEnd}
      on:pointerleave={holdEnd}
    >
      <span class="kc">2</span><span class="lbl">REV</span>
    </button>
    <button
      class="accent"
      class:active={activeDirection === "right"}
      on:pointerdown={() => holdStart("right")}
      on:pointerup={holdEnd}
      on:pointercancel={holdEnd}
      on:pointerleave={holdEnd}
    >
      <span class="kc">3</span><span class="lbl">RIGHT</span>
    </button>

    <button class="warn stop wide" on:click={pressStop}>
      <span class="kc">0</span><span class="lbl">STOP</span>
    </button>
  </div>

  {#if lastError}
    <p class="error">{lastError}</p>
  {/if}
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
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.35rem;
    max-width: 260px;
    margin: 0 auto;
  }
  .grid button {
    background: var(--surface-2, #1c232c);
    border: 1px solid var(--border, #30363d);
    color: var(--fg, #e6edf3);
    border-radius: 6px;
    padding: 0.5rem 0.25rem;
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
    line-height: 1.15;
    transition: transform 60ms ease, border-color 120ms ease;
    user-select: none;
    touch-action: none;
  }
  .grid button.accent {
    border-color: #38bdf8;
    background: rgba(56, 189, 248, 0.08);
  }
  .grid button.warn {
    border-color: var(--danger, #f85149);
    background: rgba(248, 81, 73, 0.08);
    color: #ffd6d3;
  }
  .grid button.wide {
    grid-column: 1 / -1;
  }
  .grid button.active {
    background: rgba(56, 189, 248, 0.25);
    border-color: #58a6ff;
    transform: scale(0.97);
  }
  .grid.busy button {
    opacity: 0.9;
  }
  .kc {
    font-family: ui-monospace, monospace;
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--accent, #58a6ff);
  }
  .grid button.warn .kc {
    color: var(--danger, #f85149);
  }
  .lbl {
    font-size: 0.65rem;
    color: var(--muted, #8b949e);
    letter-spacing: 0.05em;
  }
  .error {
    margin: 0.5rem 0 0 0;
    font-size: 0.75rem;
    color: var(--danger, #f85149);
    text-align: center;
  }
</style>
