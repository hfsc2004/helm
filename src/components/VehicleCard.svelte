<script lang="ts">
  import { fleet } from "../stores/vehicles";
  import { activeView } from "../stores/view";
  import type { Vehicle } from "@shared/vehicle-contract";

  export let vehicle: Vehicle;

  let cameraDraft = vehicle.camera?.baseUrl ?? "";
  let editingCamera = false;
  let busy = false;
  let error: string | null = null;

  $: hasCamera = !!vehicle.camera;
  $: cameraDraft = vehicle.camera?.baseUrl ?? "";

  async function saveCamera() {
    const url = cameraDraft.trim();
    if (!url) {
      error = "Camera URL required.";
      return;
    }
    busy = true;
    error = null;
    const res = await fleet.setCamera(vehicle.id, { baseUrl: url });
    busy = false;
    if (!res.ok) {
      error = res.error ?? "Failed to save camera.";
      return;
    }
    editingCamera = false;
  }

  async function clearCamera() {
    if (!confirm(`Remove the camera from ${vehicle.name}?`)) return;
    busy = true;
    error = null;
    const res = await fleet.setCamera(vehicle.id, null);
    busy = false;
    if (!res.ok) {
      error = res.error ?? "Failed to remove camera.";
      return;
    }
    editingCamera = false;
  }

  async function removeVehicle() {
    if (!confirm(`Remove vehicle "${vehicle.name}"? Its registry entry is deleted; the firmware on the device is untouched.`)) return;
    busy = true;
    const res = await fleet.remove(vehicle.id);
    busy = false;
    if (!res.ok) error = res.error ?? "Failed to remove.";
  }

  function driveThis() {
    fleet.select(vehicle.id);
    activeView.set("drive");
  }
</script>

<article class="card">
  <header>
    <div class="title-row">
      <h3>{vehicle.name}</h3>
      <span class="kind">{vehicle.kind} · {vehicle.capabilities.join(" · ")}</span>
    </div>
    <button class="drive-btn" on:click={driveThis}>
      <span class="play">▸</span>
      Drive
    </button>
  </header>

  <section class="rows">
    <div class="row">
      <span class="label">Endpoint</span>
      <span class="val mono">{vehicle.transport.host}:{vehicle.transport.port}</span>
    </div>
    <div class="row">
      <span class="label">Loss-of-comms</span>
      <span class="val">{vehicle.lossOfCommsBehavior}</span>
    </div>
  </section>

  <section class="sidecars">
    <h4>Sidecars</h4>

    <div class="sidecar">
      <div class="sidecar-line">
        <input
          type="checkbox"
          checked={hasCamera}
          on:change={(e) => {
            if (!(e.currentTarget instanceof HTMLInputElement)) return;
            if (e.currentTarget.checked) {
              editingCamera = true;
            } else {
              void clearCamera();
            }
          }}
          disabled={busy}
        />
        <span class="sidecar-name">Camera</span>
        {#if hasCamera && !editingCamera}
          <span class="sidecar-meta mono">{vehicle.camera?.baseUrl}</span>
          <button class="link" on:click={() => (editingCamera = true)}>edit</button>
        {:else if !hasCamera && !editingCamera}
          <span class="sidecar-meta">not configured</span>
          <button class="link" on:click={() => (editingCamera = true)}>add</button>
        {/if}
      </div>

      {#if editingCamera}
        <div class="editor">
          <input
            type="text"
            bind:value={cameraDraft}
            placeholder="http://172.20.0.16:81"
            disabled={busy}
          />
          <button class="primary-sm" on:click={saveCamera} disabled={busy}>Save</button>
          <button
            class="link"
            on:click={() => {
              editingCamera = false;
              cameraDraft = vehicle.camera?.baseUrl ?? "";
              error = null;
            }}
            disabled={busy}
          >
            cancel
          </button>
        </div>
      {/if}
    </div>

    <div class="sidecar disabled" title="Coming soon">
      <div class="sidecar-line">
        <input type="checkbox" disabled />
        <span class="sidecar-name">Mic</span>
        <span class="sidecar-meta">— roving microphone (planned)</span>
      </div>
    </div>
  </section>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  <footer>
    <button class="danger-link" on:click={removeVehicle} disabled={busy}>
      Remove vehicle
    </button>
  </footer>
</article>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  .title-row {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  h3 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .kind {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .drive-btn {
    background: var(--accent);
    color: white;
    border: 1px solid var(--accent);
    padding: 0.4rem 0.85rem;
    border-radius: 6px;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .play {
    font-size: 0.9rem;
  }

  .rows {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.3rem 0.85rem;
    align-items: baseline;
  }
  .row {
    display: contents;
  }
  .label {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .val {
    font-size: 0.85rem;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }

  .sidecars {
    border-top: 1px solid var(--border);
    padding-top: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  h4 {
    margin: 0;
    font-size: 0.7rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .sidecar.disabled {
    opacity: 0.5;
  }
  .sidecar-line {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-size: 0.85rem;
  }
  .sidecar-name {
    min-width: 60px;
  }
  .sidecar-meta {
    color: var(--muted);
    font-size: 0.75rem;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .editor {
    margin-top: 0.4rem;
    margin-left: 1.5rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .editor input {
    flex: 1 1 auto;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 0.4rem 0.55rem;
    border-radius: 4px;
    font: inherit;
    font-size: 0.8rem;
  }
  .editor input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .primary-sm {
    background: var(--accent);
    color: white;
    border: 1px solid var(--accent);
    padding: 0.35rem 0.7rem;
    border-radius: 4px;
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .link {
    background: transparent;
    border: none;
    color: var(--accent-soft, #2d7bf0);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0;
  }
  .link:hover {
    text-decoration: underline;
  }
  .danger-link {
    background: transparent;
    border: none;
    color: var(--danger, #f85149);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0;
  }
  .danger-link:hover {
    text-decoration: underline;
  }
  .error {
    color: var(--danger, #f85149);
    font-size: 0.8rem;
    margin: 0;
  }
  footer {
    border-top: 1px solid var(--border);
    padding-top: 0.6rem;
    display: flex;
    justify-content: flex-end;
  }
</style>
