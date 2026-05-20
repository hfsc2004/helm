<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fleet } from "../stores/vehicles";

  export let open = false;

  const dispatch = createEventDispatcher<{
    close: void;
    added: { id: string };
  }>();

  // Drive board (required minimum: name + host)
  let name = "";
  let host = "";
  let port = 8080;

  // Video board (optional)
  let videoEnabled = false;
  let videoHost = "";
  let videoPort = 81;
  let videoStreamPath = "/stream";
  let videoSnapshotPath = "/capture";
  let videoFlashStatusPath = "/health";

  let busy = false;
  let error: string | null = null;

  function reset() {
    name = "";
    host = "";
    port = 8080;
    videoEnabled = false;
    videoHost = "";
    videoPort = 81;
    videoStreamPath = "/stream";
    videoSnapshotPath = "/capture";
    videoFlashStatusPath = "/health";
    error = null;
    busy = false;
  }

  function close() {
    if (busy) return;
    reset();
    dispatch("close");
  }

  async function submit() {
    if (busy) return;
    const trimmedName = name.trim();
    const trimmedHost = host.trim();
    if (!trimmedName || !trimmedHost) {
      error = "Name and drive-board host are required.";
      return;
    }
    if (videoEnabled && !videoHost.trim()) {
      error = "Video board enabled — video host is required.";
      return;
    }

    busy = true;
    error = null;
    const res = await fleet.add({
      name: trimmedName,
      host: trimmedHost,
      port: Number(port) || 8080,
    });
    if (!res.ok || !res.vehicle) {
      busy = false;
      error = res.error ?? "Failed to add vehicle.";
      return;
    }

    const newId = res.vehicle.id;

    if (videoEnabled) {
      const vHost = videoHost.trim();
      const vPort = Number(videoPort) || 81;
      const cameraRes = await fleet.setCamera(newId, {
        baseUrl: `http://${vHost}:${vPort}`,
        streamPath: videoStreamPath.trim() || "/stream",
        snapshotPath: videoSnapshotPath.trim() || "/capture",
        flashStatusPath: videoFlashStatusPath.trim() || "/health",
      });
      if (!cameraRes.ok) {
        busy = false;
        error = `Vehicle added but camera config failed: ${cameraRes.error ?? "unknown"}`;
        return;
      }
    }

    busy = false;
    dispatch("added", { id: newId });
    reset();
    dispatch("close");
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && !busy) void submit();
  }
</script>

{#if open}
  <div class="backdrop" on:click={close} role="presentation">
    <div
      class="dialog"
      on:click|stopPropagation
      on:keydown={onKey}
      role="dialog"
      aria-modal="true"
      aria-label="Add vehicle"
      tabindex="-1"
    >
      <header>
        <h2>Add a vehicle</h2>
        <button class="close" on:click={close} title="Close" disabled={busy}>×</button>
      </header>

      <div class="body">
        <section>
          <h3>Identity</h3>
          <label>
            <span>Name</span>
            <input
              type="text"
              bind:value={name}
              placeholder="truck-01"
              disabled={busy}
            />
          </label>
        </section>

        <section>
          <h3>Drive board (ESP32)</h3>
          <p class="muted small">Where the motor-control firmware lives.</p>
          <label>
            <span>Host (IP or hostname on your LAN)</span>
            <input
              type="text"
              bind:value={host}
              placeholder="172.20.0.15"
              disabled={busy}
            />
          </label>
          <label>
            <span>HTTP port</span>
            <input
              type="number"
              bind:value={port}
              min="1"
              max="65535"
              disabled={busy}
            />
          </label>
        </section>

        <section>
          <h3>Video board (ESP32-S3)</h3>
          <label class="checkbox">
            <input
              type="checkbox"
              bind:checked={videoEnabled}
              disabled={busy}
            />
            This vehicle has a separate camera board
          </label>
          {#if videoEnabled}
            <p class="muted small">
              Runs on its own IP — does not need to match the drive board.
            </p>
            <label>
              <span>Video host</span>
              <input
                type="text"
                bind:value={videoHost}
                placeholder="172.20.0.16"
                disabled={busy}
              />
            </label>
            <label>
              <span>Video port</span>
              <input
                type="number"
                bind:value={videoPort}
                min="1"
                max="65535"
                disabled={busy}
              />
            </label>
            <label>
              <span>Stream path</span>
              <input type="text" bind:value={videoStreamPath} disabled={busy} />
            </label>
            <label>
              <span>Snapshot path</span>
              <input type="text" bind:value={videoSnapshotPath} disabled={busy} />
            </label>
            <label>
              <span>Health path</span>
              <input type="text" bind:value={videoFlashStatusPath} disabled={busy} />
            </label>
          {/if}
        </section>

        {#if error}
          <p class="error">{error}</p>
        {/if}
      </div>

      <footer>
        <button class="cancel" on:click={close} disabled={busy}>Cancel</button>
        <button class="submit" on:click={submit} disabled={busy}>
          {busy ? "Adding…" : "Add vehicle"}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .dialog {
    width: min(480px, 92vw);
    max-height: 90vh;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1.1rem;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  h3 {
    margin: 0 0 0.5rem 0;
    font-size: 0.7rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .close {
    background: transparent;
    border: none;
    color: var(--muted);
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .close:hover {
    color: var(--fg);
  }
  .body {
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    overflow-y: auto;
  }
  section {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.75rem 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
  }
  label.checkbox {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }
  label span {
    color: var(--muted);
    font-size: 0.75rem;
  }
  input[type="text"],
  input[type="number"] {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 0.45rem 0.6rem;
    border-radius: 5px;
    font: inherit;
    font-size: 0.85rem;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .muted {
    color: var(--muted);
    margin: 0;
  }
  .muted.small,
  .small {
    font-size: 0.75rem;
  }
  .error {
    color: var(--danger, #f85149);
    font-size: 0.8rem;
    margin: 0;
  }
  footer {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    padding: 0.85rem 1.1rem;
    border-top: 1px solid var(--border);
  }
  button.cancel,
  button.submit {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  button.cancel {
    background: transparent;
    color: var(--muted);
  }
  button.cancel:hover {
    color: var(--fg);
  }
  button.submit {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
    font-weight: 600;
  }
  button.submit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
