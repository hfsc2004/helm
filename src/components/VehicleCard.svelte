<script lang="ts">
  import { fleet } from "../stores/vehicles";
  import { activeView } from "../stores/view";
  import type { DriveMapTarget, Vehicle } from "@shared/vehicle-contract";
  import { DRIVE_TUNING_DEFAULTS } from "@shared/vehicle-contract";

  export let vehicle: Vehicle;

  let cameraDraft = vehicle.camera?.baseUrl ?? "";
  let editingCamera = false;
  let audioDraft = vehicle.audio?.baseUrl ?? "";
  let editingAudio = false;
  let busy = false;
  let error: string | null = null;

  $: hasCamera = !!vehicle.camera;
  $: cameraDraft = vehicle.camera?.baseUrl ?? "";
  $: hasAudio = !!vehicle.audio;
  $: audioDraft = vehicle.audio?.baseUrl ?? "";

  // ---------------- Drive tuning ----------------
  // Edited locally; flushed to the registry via fleet.setDrive on Save.
  let tuningOpen = false;
  let driveSpeed = vehicle.drive?.speed ?? DRIVE_TUNING_DEFAULTS.speed;
  let driveSwap = vehicle.drive?.swapSides ?? DRIVE_TUNING_DEFAULTS.swapSides;
  let driveInvertLeft = vehicle.drive?.invertLeft ?? DRIVE_TUNING_DEFAULTS.invertLeft;
  let driveInvertRight = vehicle.drive?.invertRight ?? DRIVE_TUNING_DEFAULTS.invertRight;
  let mapForward: DriveMapTarget =
    vehicle.drive?.map.forward ?? DRIVE_TUNING_DEFAULTS.map.forward;
  let mapReverse: DriveMapTarget =
    vehicle.drive?.map.reverse ?? DRIVE_TUNING_DEFAULTS.map.reverse;
  let mapLeft: DriveMapTarget =
    vehicle.drive?.map.left ?? DRIVE_TUNING_DEFAULTS.map.left;
  let mapRight: DriveMapTarget =
    vehicle.drive?.map.right ?? DRIVE_TUNING_DEFAULTS.map.right;

  // Re-sync local state when the vehicle prop changes (e.g. after Save).
  $: if (vehicle.drive) {
    driveSpeed = vehicle.drive.speed;
    driveSwap = vehicle.drive.swapSides;
    driveInvertLeft = vehicle.drive.invertLeft;
    driveInvertRight = vehicle.drive.invertRight;
    mapForward = vehicle.drive.map.forward;
    mapReverse = vehicle.drive.map.reverse;
    mapLeft = vehicle.drive.map.left;
    mapRight = vehicle.drive.map.right;
  }

  const MAP_OPTIONS: Array<{ value: DriveMapTarget; label: string }> = [
    { value: "fwd", label: "Forward" },
    { value: "rev", label: "Reverse" },
    { value: "turn_left", label: "Turn left" },
    { value: "turn_right", label: "Turn right" },
    { value: "stop", label: "Stop" },
  ];

  async function saveDriveTuning() {
    busy = true;
    error = null;
    const res = await fleet.setDrive(vehicle.id, {
      speed: Number(driveSpeed),
      swapSides: driveSwap,
      invertLeft: driveInvertLeft,
      invertRight: driveInvertRight,
      map: {
        forward: mapForward,
        reverse: mapReverse,
        left: mapLeft,
        right: mapRight,
      },
    });
    busy = false;
    if (!res.ok) {
      error = res.error ?? "Failed to save drive tuning.";
    }
  }

  async function resetDriveTuning() {
    if (!confirm("Reset drive tuning to defaults?")) return;
    busy = true;
    error = null;
    const res = await fleet.setDrive(vehicle.id, null);
    busy = false;
    if (!res.ok) {
      error = res.error ?? "Failed to reset drive tuning.";
    }
  }

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

  async function saveAudio() {
    const url = audioDraft.trim();
    if (!url) {
      error = "Mic URL required.";
      return;
    }
    busy = true;
    error = null;
    const res = await fleet.setAudio(vehicle.id, { baseUrl: url });
    busy = false;
    if (!res.ok) {
      error = res.error ?? "Failed to save mic.";
      return;
    }
    editingAudio = false;
  }

  async function clearAudio() {
    if (!confirm(`Remove the mic from ${vehicle.name}?`)) return;
    busy = true;
    error = null;
    const res = await fleet.setAudio(vehicle.id, null);
    busy = false;
    if (!res.ok) {
      error = res.error ?? "Failed to remove mic.";
      return;
    }
    editingAudio = false;
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

    <div class="sidecar">
      <div class="sidecar-line">
        <input
          type="checkbox"
          checked={hasAudio}
          on:change={(e) => {
            if (!(e.currentTarget instanceof HTMLInputElement)) return;
            if (e.currentTarget.checked) {
              editingAudio = true;
            } else {
              void clearAudio();
            }
          }}
          disabled={busy}
        />
        <span class="sidecar-name">Mic</span>
        {#if hasAudio && !editingAudio}
          <span class="sidecar-meta mono">{vehicle.audio?.baseUrl}</span>
          <button class="link" on:click={() => (editingAudio = true)}>edit</button>
        {:else if !hasAudio && !editingAudio}
          <span class="sidecar-meta">not configured</span>
          <button class="link" on:click={() => (editingAudio = true)}>add</button>
        {/if}
      </div>

      {#if editingAudio}
        <div class="editor">
          <input
            type="text"
            bind:value={audioDraft}
            placeholder="http://172.20.0.17:82"
            disabled={busy}
          />
          <button class="primary-sm" on:click={saveAudio} disabled={busy}>Save</button>
          <button
            class="link"
            on:click={() => {
              editingAudio = false;
              audioDraft = vehicle.audio?.baseUrl ?? "";
              error = null;
            }}
            disabled={busy}
          >
            cancel
          </button>
        </div>
      {/if}
    </div>
  </section>

  <section class="tuning">
    <button
      class="disclosure"
      type="button"
      on:click={() => (tuningOpen = !tuningOpen)}
    >
      {tuningOpen ? "▾" : "▸"} Drive tuning
      {#if vehicle.drive}<span class="badge">customized</span>{/if}
    </button>

    {#if tuningOpen}
      <div class="tuning-body">
        <p class="muted small">
          Rotates intents from the driver / planner before they hit the wire.
          Use this when the chassis is wired 90/180° rotated, without re-flashing.
        </p>

        <div class="map-grid">
          <label>
            <span class="lbl">Forward intent →</span>
            <select bind:value={mapForward} disabled={busy}>
              {#each MAP_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
            </select>
          </label>
          <label>
            <span class="lbl">Reverse intent →</span>
            <select bind:value={mapReverse} disabled={busy}>
              {#each MAP_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
            </select>
          </label>
          <label>
            <span class="lbl">Left intent →</span>
            <select bind:value={mapLeft} disabled={busy}>
              {#each MAP_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
            </select>
          </label>
          <label>
            <span class="lbl">Right intent →</span>
            <select bind:value={mapRight} disabled={busy}>
              {#each MAP_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
            </select>
          </label>
        </div>

        <div class="tuning-row">
          <label>
            <span class="lbl">Default speed (0..255)</span>
            <input type="number" min="0" max="255" bind:value={driveSpeed} disabled={busy} />
          </label>
        </div>

        <label class="checkbox">
          <input type="checkbox" bind:checked={driveSwap} disabled={busy} />
          Swap left/right motor outputs (tank only)
        </label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={driveInvertLeft} disabled={busy} />
          Invert left motor (tank only)
        </label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={driveInvertRight} disabled={busy} />
          Invert right motor (tank only)
        </label>

        <div class="tuning-actions">
          <button class="primary-sm" on:click={saveDriveTuning} disabled={busy}>
            Save tuning
          </button>
          {#if vehicle.drive}
            <button class="link" on:click={resetDriveTuning} disabled={busy}>
              Reset to defaults
            </button>
          {/if}
        </div>
      </div>
    {/if}
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

  .tuning {
    border-top: 1px solid var(--border);
    padding-top: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .disclosure {
    background: transparent;
    border: none;
    color: var(--fg);
    font: inherit;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .badge {
    background: var(--surface-2, #1c232c);
    color: var(--accent, #58a6ff);
    border: 1px solid var(--accent, #58a6ff);
    border-radius: 4px;
    padding: 0.05rem 0.4rem;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .tuning-body {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.75rem 0.85rem;
  }
  .map-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem 0.85rem;
  }
  .map-grid label,
  .tuning-row label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .tuning-body .lbl {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .tuning-body input[type="number"],
  .tuning-body select {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    font: inherit;
    font-size: 0.8rem;
  }
  .tuning-body input:focus,
  .tuning-body select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .checkbox {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
  }
  .tuning-actions {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    margin-top: 0.35rem;
  }
  .small {
    font-size: 0.75rem;
  }
</style>
