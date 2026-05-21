<script lang="ts">
  import { onDestroy } from "svelte";
  import { fleet, vehicleState } from "../stores/vehicles";
  import { inputMode } from "../stores/inputMode";
  import StopButton from "../components/StopButton.svelte";
  import Numpad from "../components/Numpad.svelte";
  import Gamepad from "../components/Gamepad.svelte";
  import SpeedSlider from "../components/SpeedSlider.svelte";
  import StateReadouts from "../components/StateReadouts.svelte";
  import IntentBar from "../components/IntentBar.svelte";
  import CameraFeed from "../components/CameraFeed.svelte";
  import AudioFeed from "../components/AudioFeed.svelte";
  import ActivityLog from "../components/ActivityLog.svelte";

  // Start the telemetry stream only while the Driver view is mounted, and
  // only against the currently-selected vehicle. Closing this tab tears it
  // down so an idle Helm-UI never polls /telemetry on the LAN.
  $: if ($fleet.selectedId && $vehicleState.vehicleId !== $fleet.selectedId) {
    void vehicleState.start($fleet.selectedId);
  }
  onDestroy(() => {
    void vehicleState.stop();
  });
</script>

<div class="layout">
  <div class="stage">
    <div class="camera">
      <CameraFeed />
      <StopButton />
    </div>
    <AudioFeed />
    <IntentBar />
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
      {#if $inputMode === "gamepad"}
        <Gamepad />
      {:else}
        <Numpad mode={$inputMode} />
      {/if}
      <SpeedSlider />
      <StateReadouts />
      <ActivityLog />
    {/if}
  </aside>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 1fr 320px;
    overflow: hidden;
    min-height: 0;
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
    overflow: hidden;
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
