<script lang="ts">
  import { onMount } from "svelte";
  import { fleet, vehicleState } from "../stores/vehicles";

  // VehiclePicker lives in the global header — it shouldn't auto-start
  // the telemetry stream just because the app opened. Stream lifecycle
  // belongs to whichever view actually needs state readouts (the
  // Driver view, today). Picking a different vehicle here, while a
  // stream IS already running, swaps it over.

  onMount(async () => {
    await fleet.refresh();
  });

  $: selected = $fleet.vehicles.find((v) => v.id === $fleet.selectedId) ?? null;
  $: reachable = $vehicleState.reachable;

  // Only swap the stream's target vehicle if a stream is already active.
  // Don't open one just because a vehicle is selected.
  $: if (
    selected &&
    $vehicleState.vehicleId !== null &&
    $vehicleState.vehicleId !== selected.id
  ) {
    void vehicleState.start(selected.id);
  }

  function onSelect(event: Event) {
    const target = event.target as HTMLSelectElement;
    fleet.select(target.value || null);
  }
</script>

<div class="pill" class:offline={reachable === false} class:online={reachable === true}>
  <span class="dot"></span>
  {#if $fleet.vehicles.length === 0}
    <span class="muted">No vehicles registered</span>
  {:else}
    <select on:change={onSelect} value={$fleet.selectedId ?? ""}>
      {#each $fleet.vehicles as v (v.id)}
        <option value={v.id}>{v.name}</option>
      {/each}
    </select>
    {#if selected}
      <span class="meta">·</span>
      <span class="meta">{selected.transport.host}:{selected.transport.port}</span>
    {/if}
  {/if}
</div>

<style>
  .pill {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    background: var(--surface-2, #1c232c);
    border: 1px solid var(--border, #30363d);
    border-radius: 999px;
    font-size: 0.85rem;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #6e7681;
  }
  .pill.online .dot {
    background: #3fb950;
    box-shadow: 0 0 6px #3fb950;
  }
  .pill.offline .dot {
    background: #f85149;
    box-shadow: 0 0 6px #f85149;
  }
  select {
    background: transparent;
    border: none;
    color: var(--fg, #e6edf3);
    font: inherit;
    cursor: pointer;
    outline: none;
  }
  select option {
    color: black;
  }
  .meta {
    color: var(--muted, #8b949e);
  }
  .muted {
    color: var(--muted, #8b949e);
  }
</style>
