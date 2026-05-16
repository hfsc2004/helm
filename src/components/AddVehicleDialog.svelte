<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fleet } from "../stores/vehicles";

  export let open = false;

  const dispatch = createEventDispatcher<{
    close: void;
    added: { id: string };
  }>();

  let name = "";
  let host = "";
  let port = 8080;
  let busy = false;
  let error: string | null = null;

  function reset() {
    name = "";
    host = "";
    port = 8080;
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
      error = "Name and host are required.";
      return;
    }
    busy = true;
    error = null;
    const res = await fleet.add({
      name: trimmedName,
      host: trimmedHost,
      port: Number(port) || 8080,
    });
    busy = false;
    if (res.ok && res.vehicle) {
      dispatch("added", { id: res.vehicle.id });
      reset();
      dispatch("close");
    } else {
      error = res.error ?? "Failed to add vehicle.";
    }
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
        <label>
          <span>Name</span>
          <input
            type="text"
            bind:value={name}
            placeholder="truck-01"
            disabled={busy}
          />
        </label>

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
    width: min(420px, 92vw);
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
    gap: 0.85rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
  }
  label span {
    color: var(--muted);
    font-size: 0.75rem;
  }
  input {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 0.55rem 0.7rem;
    border-radius: 6px;
    font: inherit;
    font-size: 0.9rem;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
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
