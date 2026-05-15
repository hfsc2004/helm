<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fleet } from "../stores/vehicles";
  import { activity } from "../stores/activity";
  import type { SkidSteerAction } from "@shared/vehicle-contract";

  const SPEED = 160;
  const TURN = 140;
  const PULSE_MS = 350;

  let busy = false;
  let lastError: string | null = null;

  function summary(action: SkidSteerAction): string {
    switch (action.kind) {
      case "stop": return "stop";
      case "fwd": return `fwd ${action.speed}${action.durationMs ? ` ${action.durationMs}ms` : ""}`;
      case "rev": return `rev ${action.speed}${action.durationMs ? ` ${action.durationMs}ms` : ""}`;
      case "turn": return `turn ${action.signed}${action.durationMs ? ` ${action.durationMs}ms` : ""}`;
      case "tank": return `tank L${action.left} R${action.right}${action.durationMs ? ` ${action.durationMs}ms` : ""}`;
    }
  }

  async function send(action: SkidSteerAction) {
    if (!$fleet.selectedId) return;
    busy = true;
    lastError = null;
    activity.push({ who: "human", kind: action.kind === "stop" ? "stop" : "cmd", message: summary(action) });
    try {
      const res = await window.helm.vehicle.cmd({
        vehicleId: $fleet.selectedId,
        action,
      });
      if (!res.ok) {
        lastError = res.error ?? "command rejected";
        activity.push({ who: "local", kind: "error", message: lastError });
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      activity.push({ who: "local", kind: "error", message: lastError });
    } finally {
      busy = false;
    }
  }

  function fwd() {
    void send({ kind: "fwd", speed: SPEED, durationMs: PULSE_MS });
  }
  function rev() {
    void send({ kind: "rev", speed: SPEED, durationMs: PULSE_MS });
  }
  function left() {
    void send({ kind: "turn", signed: -TURN, durationMs: PULSE_MS });
  }
  function right() {
    void send({ kind: "turn", signed: TURN, durationMs: PULSE_MS });
  }
  function stop() {
    void send({ kind: "stop" });
  }

  // Keyboard bindings: arrow keys + space for stop.
  function onKey(e: KeyboardEvent) {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (e.repeat) return;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        fwd();
        break;
      case "ArrowDown":
        e.preventDefault();
        rev();
        break;
      case "ArrowLeft":
        e.preventDefault();
        left();
        break;
      case "ArrowRight":
        e.preventDefault();
        right();
        break;
      case " ":
        e.preventDefault();
        stop();
        break;
    }
  }

  onMount(() => window.addEventListener("keydown", onKey));
  onDestroy(() => window.removeEventListener("keydown", onKey));
</script>

<section>
  <h3>Manual <span class="aux">arrow keys · space = stop</span></h3>
  <div class="dpad" class:busy>
    <button class="spacer" aria-hidden="true"></button>
    <button on:click={fwd} title="Forward (↑)">▲</button>
    <button class="spacer" aria-hidden="true"></button>

    <button on:click={left} title="Left (←)">◀</button>
    <button class="stop-mini" on:click={stop} title="Stop (space)">STOP</button>
    <button on:click={right} title="Right (→)">▶</button>

    <button class="spacer" aria-hidden="true"></button>
    <button on:click={rev} title="Reverse (↓)">▼</button>
    <button class="spacer" aria-hidden="true"></button>
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
  .dpad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.4rem;
    max-width: 220px;
    margin: 0 auto;
  }
  .dpad button {
    background: var(--surface-2, #1c232c);
    border: 1px solid var(--border, #30363d);
    color: var(--fg, #e6edf3);
    padding: 0.85rem 0;
    border-radius: 6px;
    font-size: 1rem;
    cursor: pointer;
  }
  .dpad button:hover {
    border-color: var(--accent, #1f6feb);
    color: var(--accent-soft, #2d7bf0);
  }
  .dpad.busy button {
    opacity: 0.6;
    pointer-events: none;
  }
  .dpad button.spacer {
    visibility: hidden;
  }
  .dpad .stop-mini {
    background: var(--danger-dark, #b62324);
    color: white;
    border-color: var(--danger, #f85149);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
  .error {
    margin: 0.5rem 0 0 0;
    font-size: 0.75rem;
    color: var(--danger, #f85149);
    text-align: center;
  }
</style>
