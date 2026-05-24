<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import { fleet } from "../stores/vehicles";

  let audioEl: HTMLAudioElement | null = null;
  let playing = false;
  let error: string | null = null;
  let cacheBust = 0;

  $: selected = $fleet.vehicles.find((v) => v.id === $fleet.selectedId) ?? null;
  $: streamUrl = (() => {
    if (!selected || !selected.audio) return null;
    cacheBust++;
    const base = selected.audio.baseUrl.replace(/\/$/, "");
    const path = selected.audio.streamPath ?? "/audio";
    return `${base}${path}?t=${cacheBust}`;
  })();

  async function toggle() {
    if (!audioEl || !streamUrl) return;
    error = null;
    if (playing) {
      audioEl.pause();
      audioEl.src = "";
      playing = false;
      return;
    }
    audioEl.src = streamUrl;
    try {
      await audioEl.play();
      playing = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      playing = false;
    }
  }

  function onError() {
    error = "audio stream unreachable";
    playing = false;
  }
  function onEnded() {
    playing = false;
  }
</script>

{#if selected?.audio}
  <div class="bar" class:listening={playing}>
    <button class="play" on:click={toggle} title={playing ? "Stop listening" : "Listen"}>
      {#if playing}
        ⏸
      {:else}
        ⏵
      {/if}
    </button>

    <div class="meta">
      {#if playing}
        <span class="dot"></span>
        <span class="label">LISTENING</span>
        <span class="src">{selected.audio.baseUrl}</span>
      {:else}
        <span class="label muted">Mic available</span>
        <span class="src">{selected.audio.baseUrl}</span>
      {/if}
    </div>

    {#if error}
      <span class="error">{error}</span>
    {/if}

    <!-- The actual audio element. Hidden — we control it via the button. -->
    <audio bind:this={audioEl} on:error={onError} on:ended={onEnded} preload="none"></audio>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0.85rem;
    background: var(--surface);
    border-top: 1px solid var(--border);
    font-size: 0.8rem;
  }
  .bar.listening {
    background: rgba(248, 81, 73, 0.06);
    border-top-color: rgba(248, 81, 73, 0.4);
  }
  .play {
    background: var(--surface-2, #1c232c);
    border: 1px solid var(--border);
    color: var(--fg);
    width: 30px;
    height: 30px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 0.9rem;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .bar.listening .play {
    background: var(--danger-dark, #b62324);
    border-color: var(--danger, #f85149);
    color: white;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1 1 auto;
    min-width: 0;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--danger, #f85149);
    box-shadow: 0 0 8px var(--danger, #f85149);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.5; transform: scale(0.85); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot { animation: none; }
  }
  .label {
    color: var(--danger, #f85149);
    font-weight: 600;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
  }
  .label.muted {
    color: var(--muted);
    font-weight: normal;
    letter-spacing: 0;
    font-size: 0.75rem;
  }
  .src {
    color: var(--muted);
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .error {
    color: var(--danger, #f85149);
    font-size: 0.7rem;
  }
</style>
