<script lang="ts">
  import { onMount } from "svelte";
  import { fleet } from "../stores/vehicles";
  import VehicleCard from "../components/VehicleCard.svelte";
  import AddVehicleDialog from "../components/AddVehicleDialog.svelte";

  let dialogOpen = false;

  onMount(async () => {
    await fleet.refresh();
  });
</script>

<div class="page">
  <header class="page-header">
    <h2>Vehicles</h2>
    <button class="add-btn" on:click={() => (dialogOpen = true)}>+ Add vehicle</button>
  </header>

  {#if $fleet.loading}
    <p class="muted">Loading…</p>
  {:else if $fleet.vehicles.length === 0}
    <div class="empty">
      <p class="muted">No vehicles registered.</p>
      <p class="muted small">
        Click <strong>+ Add vehicle</strong> above to register one. You can also do
        it from the CLI: <code>npm run helm -- vehicle-add &lt;host&gt; --name &lt;name&gt;</code>
      </p>
    </div>
  {:else}
    <div class="cards">
      {#each $fleet.vehicles as v (v.id)}
        <VehicleCard vehicle={v} />
      {/each}
    </div>
  {/if}
</div>

<AddVehicleDialog bind:open={dialogOpen} on:close={() => (dialogOpen = false)} />

<style>
  .page {
    overflow-y: auto;
    padding: 1rem 1.5rem;
    background: var(--bg);
  }
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 1rem 0;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
  }
  .add-btn {
    background: var(--accent);
    color: white;
    border: 1px solid var(--accent);
    padding: 0.4rem 0.95rem;
    border-radius: 6px;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .add-btn:hover {
    background: var(--accent-soft, #2d7bf0);
  }
  .cards {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    max-width: 720px;
  }
  .empty {
    padding: 2rem 0;
  }
  .muted {
    color: var(--muted);
    margin: 0 0 0.4rem 0;
    font-size: 0.9rem;
  }
  .small {
    font-size: 0.8rem;
    line-height: 1.5;
  }
  code {
    background: var(--surface-2, #1c232c);
    padding: 0.15rem 0.35rem;
    border-radius: 3px;
    font-size: 0.75rem;
    display: inline-block;
    margin-top: 0.2rem;
  }
</style>
