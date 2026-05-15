<script lang="ts">
  import { fleet } from "../stores/vehicles";
  import StopButton from "../components/StopButton.svelte";
  import Dpad from "../components/Dpad.svelte";
  import StateReadouts from "../components/StateReadouts.svelte";
</script>

<div class="layout">
  <div class="stage">
    <div class="camera">
      <div class="camera-placeholder">
        <div class="big">▶</div>
        <div class="small">camera feed (vehicle has no camera capability yet)</div>
      </div>
      <StopButton />
    </div>
  </div>

  <aside class="rail">
    {#if !$fleet.selectedId}
      <section>
        <p class="muted">
          Register a vehicle from the CLI to get started:<br />
          <code>npm run helm -- vehicle-add &lt;host&gt; --name &lt;name&gt;</code>
        </p>
      </section>
    {:else}
      <Dpad />
      <StateReadouts />
    {/if}
  </aside>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 1fr 320px;
    overflow: hidden;
  }
  .stage {
    position: relative;
    display: flex;
    flex-direction: column;
    background: #000;
    min-height: 0;
  }
  .camera {
    position: relative;
    flex: 1 1 auto;
    background:
      radial-gradient(ellipse at 30% 20%, #2a3038 0%, #0a0c10 60%),
      repeating-linear-gradient(45deg, #14181f 0 4px, #0e1218 4px 8px);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .camera-placeholder {
    text-align: center;
    color: var(--muted);
  }
  .camera-placeholder .big {
    font-size: 3rem;
    opacity: 0.3;
  }
  .camera-placeholder .small {
    font-size: 0.8rem;
    margin-top: 0.5rem;
  }
  .rail {
    background: var(--surface);
    border-left: 1px solid var(--border);
    overflow-y: auto;
  }
  section {
    padding: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0;
    line-height: 1.5;
  }
  code {
    background: var(--surface-2, #1c232c);
    padding: 0.15rem 0.35rem;
    border-radius: 3px;
    font-size: 0.75rem;
    display: inline-block;
    margin-top: 0.4rem;
  }
</style>
