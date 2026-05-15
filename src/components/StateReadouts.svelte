<script lang="ts">
  import { vehicleState } from "../stores/vehicles";

  $: state = $vehicleState.latest?.state ?? null;
  $: reachable = $vehicleState.reachable;

  function fmt(v: unknown): string {
    if (v === null || v === undefined) return "—";
    return String(v);
  }
</script>

<section>
  <h3>Vehicle state</h3>
  {#if reachable === false}
    <p class="error">Vehicle unreachable</p>
  {:else if !state}
    <p class="muted">Connecting…</p>
  {:else}
    <div class="grid">
      <div class="readout">
        <span class="label">Left motor</span>
        <span class="val">{fmt(state.left)}</span>
      </div>
      <div class="readout">
        <span class="label">Right motor</span>
        <span class="val">{fmt(state.right)}</span>
      </div>
      <div class="readout">
        <span class="label">Deadman</span>
        <span class="val">{fmt(state.lastCmdAgeMs)} ms ago</span>
      </div>
      <div class="readout">
        <span class="label">RSSI</span>
        <span class="val">{fmt(state.wifiRssi)} dBm</span>
      </div>
    </div>
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
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.4rem 1rem;
  }
  .readout {
    display: flex;
    flex-direction: column;
    font-size: 0.85rem;
  }
  .label {
    color: var(--muted, #8b949e);
    font-size: 0.7rem;
  }
  .val {
    font-variant-numeric: tabular-nums;
  }
  .muted {
    color: var(--muted, #8b949e);
    font-size: 0.85rem;
    margin: 0;
  }
  .error {
    color: var(--danger, #f85149);
    font-size: 0.85rem;
    margin: 0;
  }
</style>
