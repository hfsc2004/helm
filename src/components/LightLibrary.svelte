<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { onMount } from "svelte";
  import type { LightScript, LightPlayback } from "@shared/light-scripts";
  export let vehicleId: string;
  let scripts: LightScript[] = [];
  let selected = "";
  let query = "";
  let busy = false;
  let error = "";
  let playback: LightPlayback = { running: false, looping: false, scriptId: null, line: 0, error: "" };
  $: filtered = scripts.filter(script => script.name.toLowerCase().includes(query.toLowerCase()));
  async function refresh() {
    try {
      [scripts, playback] = await Promise.all([window.helm.lights.list(), window.helm.lights.status()]);
      if (!scripts.some(script => script.id === selected)) selected = scripts[0]?.id || "";
    } catch (e) { error = String(e); }
  }
  async function act(action: "new" | "edit" | "delete" | "play" | "loop" | "stop") {
    busy = true; error = "";
    try {
      if (action === "new" || action === "edit") await window.helm.lights.editor(action === "edit" ? selected : undefined);
      else if (action === "delete") await window.helm.lights.remove(selected);
      else if (action === "play" || action === "loop") await window.helm.lights.play({ vehicleId, scriptId: selected, loop: action === "loop" });
      else await window.helm.lights.stop();
      await refresh();
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  onMount(() => {
    void refresh();
    let polling = false;
    const poll = () => { if (!polling) { polling = true; void refresh().finally(() => { polling = false; }); } };
    const timer = setInterval(poll, 1000);
    window.addEventListener("focus", poll);
    return () => { clearInterval(timer); window.removeEventListener("focus", poll); };
  });
</script>

<section aria-label="LED script library">
  <div class="heading"><h3>LEDs</h3><span>{scripts.length} scripts</span></div>
  <input type="search" placeholder="Search light shows" bind:value={query} aria-label="Search LED scripts" />
  <select size="4" bind:value={selected} aria-label="LED script library" disabled={busy}>
    {#each filtered as script}<option value={script.id}>{script.name}</option>{/each}
  </select>
  {#if !filtered.length}<p class="muted">{scripts.length ? "No matching scripts." : "Create a script to program a light show."}</p>{/if}
  <div class="controls">
    <button on:click={() => act("new")} disabled={busy}>New…</button>
    <button on:click={() => act("edit")} disabled={busy || !selected}>Edit</button>
    <button on:click={() => act("delete")} disabled={busy || !selected || playback.running}>Delete</button>
    <button on:click={() => act("play")} disabled={busy || playback.running || !filtered.some(script => script.id === selected)}>Play</button>
    <button class="loop" on:click={() => act("loop")} disabled={busy || playback.running || !filtered.some(script => script.id === selected)} aria-label="Play Loop" title="Play Loop — repeat until stopped">
      <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M11 9 L11 23 L23 16 Z" fill="currentColor"/><path d="M25 14 C30 14 30 27 22 27 H8 C3 27 3 16 10 16 M7 13 L10 16 L7 19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button on:click={() => act("stop")} disabled={busy || !playback.running}>■ Stop</button>
  </div>
  {#if playback.running}<p role="status">{playback.looping ? "Looping" : "Playing"} {scripts.find(script => script.id === playback.scriptId)?.name || "show"} · line {playback.line}</p>{/if}
  {#if error || playback.error}<p class="error" role="alert">{error || playback.error}</p>{/if}
</section>

<style>
  section { padding: 1rem; border-top: 1px solid var(--border); }
  .heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: .65rem; }
  h3 { margin: 0; font-size: .95rem; }
  .heading span, .muted { color: var(--muted); font-size: .75rem; }
  input, select { width: 100%; padding: .45rem; border: 1px solid var(--border); border-radius: 4px; background: #1c232c; color: var(--fg); }
  input { margin-bottom: .5rem; }
  select { font-size: .8rem; }
  option { padding: .3rem; }
  .controls { display: flex; gap: .3rem; margin-top: .6rem; flex-wrap: wrap; }
  button { padding: .4rem .5rem; font-size: .75rem; cursor: pointer; }
  .loop { display: inline-flex; align-items: center; justify-content: center; padding: .15rem .35rem; }
  .loop svg { width: 28px; height: 28px; }
  button:disabled { opacity: .5; cursor: default; }
  p { margin: .6rem 0 0; font-size: .75rem; overflow-wrap: anywhere; }
  .error { color: #ff9090; }
</style>
