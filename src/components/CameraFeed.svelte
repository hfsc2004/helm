<script lang="ts">
  import { fleet } from "../stores/vehicles";

  // Re-mount the <img> when the selected vehicle changes by giving each one a
  // unique src + cache-buster so MJPEG doesn't reuse a stale connection.
  let cacheBust = 0;
  $: selected = $fleet.vehicles.find((v) => v.id === $fleet.selectedId) ?? null;
  $: streamUrl = (() => {
    if (!selected || !selected.camera) return null;
    cacheBust++;
    const base = selected.camera.baseUrl.replace(/\/$/, "");
    const path = selected.camera.streamPath ?? "/stream";
    return `${base}${path}?t=${cacheBust}`;
  })();

  let imgError = false;
  function onError() {
    imgError = true;
  }
  function onLoad() {
    imgError = false;
  }
</script>

{#if streamUrl}
  <div class="wrap">
    <img
      src={streamUrl}
      alt="Vehicle camera"
      on:error={onError}
      on:load={onLoad}
    />
    <div class="label">CAM · LIVE</div>
    {#if imgError}
      <div class="error">Camera unreachable at {selected?.camera?.baseUrl}</div>
    {/if}
  </div>
{:else}
  <div class="placeholder">
    <div class="big">▶</div>
    <div class="small">
      {#if selected}
        no camera attached to this vehicle<br />
        <code>npm run helm -- vehicle-camera-set {selected.id} http://&lt;cam-host&gt;:81</code>
      {:else}
        no vehicle selected
      {/if}
    </div>
  </div>
{/if}

<style>
  .wrap {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .label {
    position: absolute;
    top: 0.75rem;
    left: 0.75rem;
    font-size: 0.75rem;
    color: var(--muted);
    background: rgba(0, 0, 0, 0.4);
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    letter-spacing: 0.05em;
  }
  .error {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: var(--danger, #f85149);
    background: rgba(0, 0, 0, 0.6);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.85rem;
  }
  .placeholder {
    text-align: center;
    color: var(--muted);
  }
  .placeholder .big {
    font-size: 3rem;
    opacity: 0.3;
  }
  .placeholder .small {
    font-size: 0.8rem;
    margin-top: 0.5rem;
    line-height: 1.5;
  }
  code {
    background: var(--surface-2, #1c232c);
    padding: 0.15rem 0.35rem;
    border-radius: 3px;
    font-size: 0.7rem;
    display: inline-block;
    margin-top: 0.4rem;
  }
</style>
