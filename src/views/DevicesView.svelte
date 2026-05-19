<script lang="ts">
  import { onMount } from "svelte";
  import type {
    SerialPortInfo,
    HardwareInfo,
  } from "@shared/ipc-channels";
  import type { OllamaStatus } from "@shared/llm";
  import { devicesScreen, openConfigure } from "../stores/devices-view";
  import ConfigureBoardView from "./ConfigureBoardView.svelte";

  let ports: SerialPortInfo[] = [];
  let portsLoading = false;
  let portsError: string | null = null;

  let hw: HardwareInfo | null = null;
  let hwLoading = false;
  let hwError: string | null = null;

  let ollama: OllamaStatus | null = null;
  let ollamaLoading = false;
  let ollamaError: string | null = null;

  async function refreshPorts() {
    portsLoading = true;
    portsError = null;
    try {
      const res = await window.helm.serial.list();
      ports = res.ports;
    } catch (err) {
      portsError = err instanceof Error ? err.message : String(err);
    } finally {
      portsLoading = false;
    }
  }

  async function refreshHardware() {
    hwLoading = true;
    hwError = null;
    try {
      hw = await window.helm.hardware.detect();
    } catch (err) {
      hwError = err instanceof Error ? err.message : String(err);
    } finally {
      hwLoading = false;
    }
  }

  async function refreshOllama() {
    ollamaLoading = true;
    ollamaError = null;
    try {
      ollama = await window.helm.ollama.status();
    } catch (err) {
      ollamaError = err instanceof Error ? err.message : String(err);
    } finally {
      ollamaLoading = false;
    }
  }

  function refreshAll() {
    void refreshPorts();
    void refreshHardware();
    void refreshOllama();
  }

  onMount(refreshAll);

  function fmtBytes(b: number | undefined): string {
    if (b === undefined || b === 0) return "0";
    if (b > 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    if (b > 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  }

  function boardLabel(hint: string): string {
    switch (hint) {
      case "raspberry-pi-pico": return "Raspberry Pi Pico (RP2040)";
      case "esp32": return "ESP32";
      default: return "";
    }
  }

</script>

{#if $devicesScreen.kind === "configure"}
  <ConfigureBoardView port={$devicesScreen.port} />
{:else}

<div class="page">
  <header class="page-header">
    <h2>Devices</h2>
    <button class="refresh" on:click={refreshAll}>Refresh</button>
  </header>

  <div class="grid">
    <!-- Serial / USB -->
    <section>
      <h3>USB / Serial</h3>
      {#if portsLoading}
        <p class="muted">Scanning…</p>
      {:else if portsError}
        <p class="error">{portsError}</p>
      {:else if ports.length === 0}
        <p class="muted">No USB or serial devices detected.</p>
      {:else}
        <ul class="ports">
          {#each ports as p (p.path)}
            <li>
              {#if p.boardHint}
                <button
                  class="port-button"
                  type="button"
                  on:click={() => openConfigure(p)}
                >
                  <div class="port-main">
                    <span class="path">{p.path}</span>
                    <span class="hint hint-{p.boardHint}">{boardLabel(p.boardHint)}</span>
                    <span class="cta">Configure →</span>
                  </div>
                  <div class="port-meta">{p.label}</div>
                </button>
              {:else}
                <div class="port-main">
                  <span class="path">{p.path}</span>
                  <span class="kind">{p.kind}</span>
                </div>
                <div class="port-meta">{p.label}</div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Hardware / GPU -->
    <section>
      <h3>Inference hardware</h3>
      {#if hwLoading}
        <p class="muted">Detecting…</p>
      {:else if hwError}
        <p class="error">{hwError}</p>
      {:else if hw}
        <div class="kv">
          <div class="k">Acceleration</div>
          <div class="v">{hw.classification.displayText ?? hw.classification.accelerationType}</div>

          <div class="k">Selected GPU</div>
          <div class="v">
            {#if hw.classification.name}
              {hw.classification.name}
              {#if hw.classification.vram}
                · {hw.classification.vram} GB
              {/if}
            {:else}
              CPU only
            {/if}
          </div>

          {#if hw.nvidiaSelection && hw.nvidiaSelection.uuid}
            <div class="k">CUDA UUID (active)</div>
            <div class="v mono">{hw.nvidiaSelection.uuid}</div>
          {/if}

          <div class="k">RAM</div>
          <div class="v">{hw.hardware.ram_gb ?? "?"} GB</div>

          <div class="k">CPU cores</div>
          <div class="v">{hw.hardware.cpu_count ?? "?"}</div>
        </div>

        {#if (hw.hardware.gpu_list?.length ?? 0) > 1}
          <div class="multi-gpu">
            <div class="muted small">All detected GPUs (headless preferred for inference):</div>
            <ul>
              {#each hw.hardware.gpu_list ?? [] as g}
                <li>
                  <span class="path">{g.name}</span>
                  {#if g.vram}<span class="kind">{g.vram} GB</span>{/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      {/if}
    </section>

    <!-- Ollama -->
    <section>
      <h3>LLM backend (private Ollama)</h3>
      {#if ollamaLoading}
        <p class="muted">Checking…</p>
      {:else if ollamaError}
        <p class="error">{ollamaError}</p>
      {:else if ollama}
        <div class="kv">
          <div class="k">Installed</div>
          <div class="v">{ollama.installed ? "yes" : "no"}</div>

          <div class="k">Running</div>
          <div class="v" class:ok={ollama.running} class:warn={!ollama.running}>
            {ollama.running ? `yes (PID ${ollama.pid})` : "no"}
          </div>

          <div class="k">Port</div>
          <div class="v mono">{ollama.port}</div>

          <div class="k">Models dir</div>
          <div class="v mono small">{ollama.modelsPath}</div>

          <div class="k">Disk used</div>
          <div class="v">{fmtBytes(ollama.bytesUsed)}</div>
        </div>

        {#if !ollama.installed}
          <p class="hint-cli">
            Install with: <code>npm run helm -- ollama-install --confirm</code>
          </p>
        {:else if !ollama.running}
          <p class="hint-cli">
            Start with: <code>npm run helm -- ollama-start</code>
          </p>
        {/if}
      {/if}
    </section>
  </div>
</div>
{/if}

<style>
  .page {
    overflow-y: auto;
    padding: 1rem 1.5rem;
    background: var(--bg);
  }
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 1rem 0;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
  }
  .refresh {
    background: var(--surface-2, #1c232c);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 0.4rem 0.85rem;
    border-radius: 6px;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .refresh:hover {
    color: var(--fg);
    border-color: var(--accent);
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    max-width: 900px;
  }
  @media (min-width: 1100px) {
    .grid {
      grid-template-columns: 1fr 1fr;
    }
    section:first-child {
      grid-column: 1 / -1;
    }
  }
  section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.25rem;
  }
  h3 {
    margin: 0 0 0.75rem 0;
    font-size: 0.7rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0;
  }
  .error {
    color: var(--danger, #f85149);
    font-size: 0.85rem;
    margin: 0;
  }
  ul.ports {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  ul.ports li {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
  }
  .port-button {
    display: block;
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 0;
    margin: 0;
    cursor: pointer;
    border-radius: 4px;
  }
  ul.ports li:has(.port-button) {
    padding: 0;
    transition: border-color 120ms ease, background 120ms ease;
  }
  ul.ports li:has(.port-button:hover),
  ul.ports li:has(.port-button:focus-visible) {
    border-color: var(--accent);
    background: var(--surface-2, #1c232c);
  }
  .port-button:focus-visible {
    outline: none;
  }
  .port-button .port-main,
  .port-button .port-meta {
    padding: 0 0.75rem;
  }
  .port-button .port-main {
    padding-top: 0.5rem;
  }
  .port-button .port-meta {
    padding-bottom: 0.5rem;
  }
  .cta {
    font-size: 0.7rem;
    color: var(--accent, #58a6ff);
    margin-left: auto;
  }
  .port-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .port-meta {
    color: var(--muted);
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    margin-top: 0.25rem;
  }
  .path {
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
  }
  .kind, .hint {
    font-size: 0.7rem;
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    background: var(--surface-2, #1c232c);
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .hint-raspberry-pi-pico {
    background: rgba(163, 113, 247, 0.1);
    color: #a371f7;
    border-color: #a371f7;
  }
  .hint-esp32 {
    background: rgba(63, 185, 80, 0.1);
    color: #3fb950;
    border-color: #3fb950;
  }
  .kv {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.4rem 1rem;
    align-items: baseline;
  }
  .k {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .v {
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
  }
  .v.ok { color: var(--good, #3fb950); }
  .v.warn { color: var(--warn, #d29922); }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .small {
    font-size: 0.75rem;
  }
  .multi-gpu {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }
  .multi-gpu ul {
    list-style: none;
    padding: 0;
    margin: 0.4rem 0 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .multi-gpu li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.8rem;
  }
  .hint-cli {
    margin: 0.75rem 0 0 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
  code {
    background: var(--bg);
    padding: 0.15rem 0.35rem;
    border-radius: 3px;
    font-size: 0.7rem;
  }
</style>
