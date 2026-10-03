<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import { onMount } from "svelte";
  import type { AudioLibraryEntry } from "@shared/ipc-channels";
  export let vehicleId: string;
  let entries: AudioLibraryEntry[] = [];
  let selected = "";
  let query = "";
  let busy = false;
  let playing = false;
  let error = "";
  let status = "";
  $: filtered = entries.filter(entry => entry.name.toLowerCase().includes(query.toLowerCase()));
  $: selectedEntry = entries.find(entry => entry.id === selected);
  async function manage(action: "list" | "add" | "remove") {
    busy = true; error = ""; status = "";
    try {
      const response = action === "remove" ? await window.helm.audio.remove(selected) : await window.helm.audio[action]();
      entries = response.entries;
      if (!entries.some(entry => entry.id === selected)) selected = entries[0]?.id ?? "";
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function play() {
    if (!selectedEntry) return;
    const name = selectedEntry.name;
    playing = true; error = ""; status = `Playing ${name}…`;
    try { await window.helm.audio.play({ vehicleId, audioId: selected }); status = `Played ${name}`; }
    catch (e) { error = e instanceof Error ? e.message : String(e); status = ""; }
    finally { playing = false; }
  }
  onMount(() => { void manage("list"); });
</script>

<section aria-label="Robot audio library">
  <div class="heading"><h3>Audio</h3><span>{entries.length} files</span></div>
  <input type="search" bind:value={query} placeholder="Search audio library" aria-label="Search audio library" />
  <select size="5" bind:value={selected} disabled={busy || playing} aria-label="Audio library">
    {#each filtered as entry}<option value={entry.id}>{entry.name}</option>{/each}
  </select>
  {#if !filtered.length}<p class="muted">{entries.length ? "No matching audio." : "Add audio files to get started."}</p>{/if}
  <div class="controls">
    <button on:click={() => manage("add")} disabled={busy || playing}>Add…</button>
    <button on:click={() => manage("remove")} disabled={busy || playing || !selectedEntry} title="Remove from library; keep original file">Remove</button>
    <button class="play" on:click={play} disabled={busy || playing || !selectedEntry || !filtered.some(entry => entry.id === selected)}>{playing ? "Playing…" : "Play to robot"}</button>
  </div>
  {#if status}<p role="status">{status}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  section { padding: 1rem; border-top: 1px solid var(--border); }
  .heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: .65rem; }
  h3 { margin: 0; font-size: .95rem; }
  .heading span, .muted { color: var(--muted); font-size: .75rem; }
  input, select { box-sizing: border-box; width: 100%; background: var(--surface-2, #1c232c); color: var(--text, #eee); border: 1px solid var(--border); border-radius: 4px; padding: .45rem; }
  input { margin-bottom: .5rem; }
  select { font-size: .8rem; }
  option { padding: .3rem; }
  .controls { display: flex; gap: .35rem; margin-top: .6rem; }
  button { padding: .4rem .5rem; font-size: .75rem; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .play { margin-left: auto; }
  p { font-size: .75rem; margin: .6rem 0 0; overflow-wrap: anywhere; }
  .error { color: #ff9090; }
</style>
