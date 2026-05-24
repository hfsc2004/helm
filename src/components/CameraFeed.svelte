<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { fleet } from "../stores/vehicles";

  /**
   * Camera feed.
   *
   * Pulls JPEG frames from the host-side stream cache (one upstream
   * connection per vehicle held by the Electron main process), polling at
   * ~15 fps. This is what lets the CLI's `vehicle-snapshot` share frames
   * with the live UI — the camera firmware can only serve one HTTP client
   * at a time, so everything in Helm shares one connection.
   */

  const POLL_INTERVAL_MS = 66;        // ~15 fps; the camera is the bottleneck
  const FIRST_FRAME_TIMEOUT_MS = 12000;

  let imgEl: HTMLImageElement | null = null;
  let currentObjectUrl: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let consumerId: string | null = null;
  let openVehicleId: string | null = null;
  let lastCapturedAt = 0;
  // Track how long the feed has been stuck on the same frame. We never
  // paint the underlying error text on top of the live image (that was
  // too noisy when the AP roamed channels), but a tiny "STALE" badge
  // appears in the corner so the user knows it isn't fresh.
  let stale = false;
  let consecutiveErrors = 0;
  const STALE_THRESHOLD = 30; // ~2s at the 66ms poll cadence

  $: selected = $fleet.vehicles.find((v) => v.id === $fleet.selectedId) ?? null;
  $: hasCamera = !!selected?.camera;

  // React to vehicle changes: drop the old stream handle, open a new one.
  $: void onSelectionChange(selected?.id, hasCamera);

  async function onSelectionChange(
    vehicleId: string | undefined,
    cameraConfigured: boolean
  ): Promise<void> {
    if (openVehicleId === (vehicleId ?? null) && consumerId !== null) return;
    await teardown();
    if (!vehicleId || !cameraConfigured) return;
    await openStream(vehicleId);
  }

  async function openStream(vehicleId: string): Promise<void> {
    consecutiveErrors = 0;
    stale = false;
    try {
      const handle = await window.helm.vehicle.cameraStreamOpen({ vehicleId });
      consumerId = handle.consumerId;
      openVehicleId = vehicleId;
      // First pull gets a generous timeout so the UI doesn't blink stale
      // while the upstream connection is still negotiating.
      await pollOnce(FIRST_FRAME_TIMEOUT_MS);
      pollTimer = setInterval(() => void pollOnce(2000), POLL_INTERVAL_MS);
    } catch {
      // Swallowed — the worst we do visually is keep showing the last
      // good frame with the STALE badge. The teardown happens on unmount.
    }
  }

  function registerError(): void {
    consecutiveErrors++;
    if (consecutiveErrors >= STALE_THRESHOLD) stale = true;
  }

  function clearError(): void {
    if (consecutiveErrors > 0 || stale) {
      consecutiveErrors = 0;
      stale = false;
    }
  }

  async function pollOnce(timeoutMs: number): Promise<void> {
    if (!openVehicleId) return;
    try {
      const res = await window.helm.vehicle.cameraSnapshot({
        vehicleId: openVehicleId,
        timeoutMs,
      });
      if (!res.ok || !res.base64) {
        registerError();
        return;
      }
      // Skip if this is the same frame we already showed.
      if (res.capturedAt && res.capturedAt === lastCapturedAt) return;
      lastCapturedAt = res.capturedAt ?? Date.now();

      const bytes = base64ToBytes(res.base64);
      const blob = new Blob([bytes], { type: res.contentType ?? "image/jpeg" });
      const url = URL.createObjectURL(blob);
      const previous = currentObjectUrl;
      currentObjectUrl = url;
      if (imgEl) imgEl.src = url;
      if (previous) URL.revokeObjectURL(previous);
      clearError();
    } catch {
      registerError();
    }
  }

  function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const ab = new ArrayBuffer(bin.length);
    const out = new Uint8Array(ab);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function teardown(): Promise<void> {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (consumerId !== null) {
      const id = consumerId;
      consumerId = null;
      try {
        await window.helm.vehicle.cameraStreamClose(id);
      } catch {
        // best-effort
      }
    }
    openVehicleId = null;
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    if (imgEl) imgEl.src = "";
  }

  onDestroy(() => {
    void teardown();
  });
</script>

{#if hasCamera}
  <div class="wrap">
    <!-- svelte-ignore a11y-missing-attribute -->
    <img bind:this={imgEl} alt="Vehicle camera" />
    <div class="label" class:stale>{stale ? "CAM · STALE" : "CAM · LIVE"}</div>
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
  .label.stale {
    color: var(--danger, #f85149);
    border: 1px solid var(--danger, #f85149);
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
