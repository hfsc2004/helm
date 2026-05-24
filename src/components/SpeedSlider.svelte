<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    driveSpeed,
    SPEED_MIN,
    SPEED_MAX,
    SPEED_STEP,
  } from "../stores/driveSpeed";

  /**
   * Drive-speed knob.
   *
   * Reads/writes the session-only `driveSpeed` store. Numpad + Gamepad
   * both pick it up at command-emit time, so changes apply on the next
   * pulse without needing to re-grab the keys.
   *
   * Slider is a native <input type="range"> for free keyboard handling,
   * accessibility, and click-anywhere-to-jump on the track. The "+" and
   * "-" buttons step by SPEED_STEP. Keyboard "=/+" and "-" also step
   * when the Drive view is focused.
   */

  $: value = $driveSpeed;
  $: pct = ((value - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100;

  function bump(delta: number) {
    driveSpeed.bump(delta);
  }

  function onInput(e: Event) {
    const el = e.currentTarget;
    if (!(el instanceof HTMLInputElement)) return;
    const n = Number(el.value);
    if (Number.isFinite(n)) driveSpeed.set(n);
  }

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function onKey(e: KeyboardEvent) {
    if (isTypingTarget(e.target)) return;
    switch (e.code) {
      case "Equal":           // "=" (and "+" with Shift) on main row
      case "NumpadAdd":
        e.preventDefault();
        bump(SPEED_STEP);
        break;
      case "Minus":
      case "NumpadSubtract":
        e.preventDefault();
        bump(-SPEED_STEP);
        break;
    }
  }

  onMount(() => window.addEventListener("keydown", onKey));
  onDestroy(() => window.removeEventListener("keydown", onKey));
</script>

<section>
  <h3>
    Speed
    <span class="aux">+/- to step · click track to jump</span>
  </h3>

  <div class="row">
    <button
      class="step"
      aria-label="Slow down"
      on:click={() => bump(-SPEED_STEP)}
      disabled={value <= SPEED_MIN}
    >−</button>

    <div class="track-wrap">
      <input
        type="range"
        min={SPEED_MIN}
        max={SPEED_MAX}
        step={1}
        {value}
        on:input={onInput}
        aria-label="Drive speed"
      />
      <div class="fill" style="--pct: {pct}%"></div>
    </div>

    <button
      class="step"
      aria-label="Speed up"
      on:click={() => bump(SPEED_STEP)}
      disabled={value >= SPEED_MAX}
    >+</button>
  </div>

  <div class="legend">
    <span>{SPEED_MIN}</span>
    <span class="val">{value}</span>
    <span>{SPEED_MAX}</span>
  </div>
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

  .row {
    display: grid;
    grid-template-columns: 32px 1fr 32px;
    gap: 0.5rem;
    align-items: center;
  }
  .step {
    background: var(--surface-2, #1c232c);
    border: 1px solid var(--border, #30363d);
    color: var(--fg, #e6edf3);
    border-radius: 6px;
    padding: 0.4rem 0;
    font: inherit;
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    user-select: none;
  }
  .step:hover:not(:disabled) {
    border-color: var(--accent, #58a6ff);
    color: var(--accent-soft, #2d7bf0);
  }
  .step:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .track-wrap {
    position: relative;
    height: 26px;
    display: flex;
    align-items: center;
  }
  .track-wrap .fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--pct, 0%);
    background: linear-gradient(
      to right,
      rgba(56, 189, 248, 0.25),
      rgba(56, 189, 248, 0.55)
    );
    border-radius: 999px;
    height: 6px;
    align-self: center;
    pointer-events: none;
  }
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 26px;
    background: transparent;
    position: relative;
    z-index: 1;
    cursor: pointer;
    margin: 0;
  }
  input[type="range"]::-webkit-slider-runnable-track {
    height: 6px;
    background: var(--surface-2, #1c232c);
    border: 1px solid var(--border, #30363d);
    border-radius: 999px;
  }
  input[type="range"]::-moz-range-track {
    height: 6px;
    background: var(--surface-2, #1c232c);
    border: 1px solid var(--border, #30363d);
    border-radius: 999px;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--accent, #58a6ff);
    border: 2px solid #0d1117;
    margin-top: -7px;
    cursor: grab;
    box-shadow: 0 0 0 1px var(--accent, #58a6ff);
  }
  input[type="range"]::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--accent, #58a6ff);
    border: 2px solid #0d1117;
    cursor: grab;
    box-shadow: 0 0 0 1px var(--accent, #58a6ff);
  }
  input[type="range"]:focus {
    outline: none;
  }
  input[type="range"]:focus::-webkit-slider-thumb {
    box-shadow: 0 0 0 2px var(--accent, #58a6ff);
  }
  input[type="range"]:focus::-moz-range-thumb {
    box-shadow: 0 0 0 2px var(--accent, #58a6ff);
  }

  .legend {
    display: flex;
    justify-content: space-between;
    margin-top: 0.4rem;
    color: var(--muted, #8b949e);
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  .legend .val {
    color: var(--fg, #e6edf3);
    font-weight: 600;
  }
</style>
