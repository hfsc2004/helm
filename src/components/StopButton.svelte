<script lang="ts">
  import { fleet } from "../stores/vehicles";

  let busy = false;

  async function stop() {
    if (!$fleet.selectedId) return;
    busy = true;
    try {
      await window.helm.vehicle.stop({ vehicleId: $fleet.selectedId });
    } finally {
      busy = false;
    }
  }
</script>

<button
  class="stop"
  class:busy
  on:click={stop}
  title="Emergency stop"
  disabled={!$fleet.selectedId}
>
  STOP
</button>

<style>
  .stop {
    position: absolute;
    bottom: 1.25rem;
    right: 1.25rem;
    width: 96px;
    height: 96px;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, var(--danger, #f85149), var(--danger-dark, #b62324));
    color: white;
    font-weight: 700;
    font-size: 1.1rem;
    letter-spacing: 0.1em;
    border: 3px solid #ff8a82;
    box-shadow: 0 0 16px rgba(248, 81, 73, 0.45), inset 0 -4px 8px rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }
  .stop:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .stop.busy {
    opacity: 0.7;
  }
</style>
