<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type {
    FlashStartRequest,
    FlashStreamEvent,
    FlashTemplateSummary,
    SerialPortInfo,
  } from "@shared/ipc-channels";
  import { backToList } from "../stores/devices-view";

  export let port: SerialPortInfo;

  type BoardKind = "esp32" | "raspberry-pi-pico" | "raspberry-pi-pico-w" | "raspberry-pi-pico-2w";

  const BOARD_OPTIONS: Array<{ value: BoardKind; label: string }> = [
    { value: "esp32", label: "ESP32 (classic, no -S3)" },
    { value: "raspberry-pi-pico", label: "Raspberry Pi Pico (RP2040, no WiFi)" },
    { value: "raspberry-pi-pico-w", label: "Raspberry Pi Pico W (RP2040 + WiFi)" },
    { value: "raspberry-pi-pico-2w", label: "Raspberry Pi Pico 2 W (RP2350 + WiFi)" },
  ];

  function hintToBoard(hint: string): BoardKind {
    if (hint === "esp32") return "esp32";
    if (hint === "raspberry-pi-pico") return "raspberry-pi-pico";
    return "esp32";
  }

  let board: BoardKind = hintToBoard(port.boardHint);

  // Templates fetched on mount; filtered by selected board.
  let allTemplates: FlashTemplateSummary[] = [];
  let templatesLoading = true;
  let templatesError: string | null = null;
  let selectedTemplateId = "";

  $: filteredTemplates = allTemplates.filter((t) => templateMatchesBoard(t, board));
  $: selectedTemplate = filteredTemplates.find((t) => t.id === selectedTemplateId) ?? null;

  function templateMatchesBoard(t: FlashTemplateSummary, b: BoardKind): boolean {
    if (b === "esp32") return t.target === "esp32";
    if (b.startsWith("raspberry-pi-pico")) return t.target === "pico" || t.target === "rp2040";
    return false;
  }

  // Re-pick a template when the board selector changes.
  $: if (filteredTemplates.length === 1) {
    selectedTemplateId = filteredTemplates[0]!.id;
  } else if (!filteredTemplates.some((t) => t.id === selectedTemplateId)) {
    selectedTemplateId = "";
  }

  // ---------- form state ----------
  let vehicleName = "";
  let vehicleSlug = "";
  $: vehicleSlug = vehicleName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  let wifiSsid = "";
  let wifiPassword = "";
  let ipMode: "static" | "dhcp" = "static";
  let staticIp = "192.168.1.50";
  let staticCidr = 24;

  // Advanced — motor trims & invert flags, pulled from the template later.
  let advancedOpen = false;
  let motorLeftTrim = 0;
  let motorRightTrim = 0;
  let motorInvertLeft = false;
  let motorInvertRight = false;

  // Apply per-template defaults whenever the selected template changes.
  $: if (selectedTemplate) {
    for (const v of selectedTemplate.vars) {
      const d = v.default;
      if (d === undefined) continue;
      if (v.key === "wifi.useStatic" && typeof d === "boolean") {
        if (!touched.has("ipMode")) ipMode = d ? "static" : "dhcp";
      } else if (v.key === "wifi.staticIp" && typeof d === "string") {
        if (!touched.has("staticIp")) staticIp = d;
      } else if (v.key === "wifi.staticCidr" && typeof d === "number") {
        if (!touched.has("staticCidr")) staticCidr = d;
      } else if (v.key === "motor.leftTrim" && typeof d === "number") {
        if (!touched.has("motorLeftTrim")) motorLeftTrim = d;
      } else if (v.key === "motor.rightTrim" && typeof d === "number") {
        if (!touched.has("motorRightTrim")) motorRightTrim = d;
      } else if (v.key === "motor.invertLeft" && typeof d === "boolean") {
        if (!touched.has("motorInvertLeft")) motorInvertLeft = d;
      } else if (v.key === "motor.invertRight" && typeof d === "boolean") {
        if (!touched.has("motorInvertRight")) motorInvertRight = d;
      }
    }
  }

  // Track which fields the user has typed in so we don't overwrite their input
  // when re-applying template defaults.
  const touched = new Set<string>();
  function markTouched(key: string): void {
    touched.add(key);
  }

  // ---------- flash session ----------
  let flashing = false;
  let flashHandle: { stop: () => Promise<void> } | null = null;
  let logLines: Array<{ stage: string; text: string }> = [];
  let logEl: HTMLPreElement | null = null;
  let flashResult: "ok" | "fail" | null = null;
  let flashReason: string | null = null;
  let addingToRegistry = false;
  let registryAddError: string | null = null;
  let registryAddOk = false;

  async function refreshTemplates(): Promise<void> {
    templatesLoading = true;
    templatesError = null;
    try {
      const res = await window.helm.flash.listTemplates();
      allTemplates = res.templates;
    } catch (err) {
      templatesError = err instanceof Error ? err.message : String(err);
    } finally {
      templatesLoading = false;
    }
  }

  onMount(refreshTemplates);

  function appendLog(stage: string, text: string): void {
    const trimmed = text.replace(/\s+$/u, "");
    if (!trimmed) return;
    logLines = [...logLines, { stage, text: trimmed }];
    queueMicrotask(() => {
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
  }

  function buildVars(): Record<string, unknown> {
    return {
      "wifi.ssid": wifiSsid,
      "wifi.password": wifiPassword,
      "wifi.useStatic": ipMode === "static",
      "wifi.staticIp": staticIp,
      "wifi.staticCidr": staticCidr,
      "motor.leftTrim": motorLeftTrim,
      "motor.rightTrim": motorRightTrim,
      "motor.invertLeft": motorInvertLeft,
      "motor.invertRight": motorInvertRight,
    };
  }

  function canFlash(): boolean {
    if (flashing) return false;
    if (!selectedTemplate) return false;
    if (!vehicleName.trim() || !vehicleSlug) return false;
    if (!wifiSsid.trim() || !wifiPassword) return false;
    if (ipMode === "static") {
      const m = staticIp.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (!m) return false;
      if (m.slice(1).some((s) => Number(s) > 255)) return false;
      if (!Number.isInteger(staticCidr) || staticCidr < 0 || staticCidr > 32) return false;
    }
    return true;
  }

  async function startFlash(): Promise<void> {
    if (!canFlash() || !selectedTemplate) return;
    flashing = true;
    flashResult = null;
    flashReason = null;
    registryAddError = null;
    registryAddOk = false;
    logLines = [];

    const req: FlashStartRequest = {
      templateId: selectedTemplate.id,
      port: port.path,
      vars: buildVars(),
    };

    try {
      flashHandle = await window.helm.flash.start(req, (raw) => {
        const ev = raw as FlashStreamEvent;
        if (ev.chunk) {
          appendLog(ev.stage, ev.chunk);
        } else {
          appendLog(ev.stage, ev.message);
        }
        if (ev.stage === "complete") {
          flashResult = ev.ok ? "ok" : "fail";
          if (!ev.ok && ev.reason) flashReason = ev.reason;
          flashing = false;
          if (ev.ok) void addToRegistry();
        } else if (ev.stage === "error") {
          flashResult = "fail";
          flashReason = ev.reason ?? ev.message;
          flashing = false;
        }
      });
    } catch (err) {
      flashing = false;
      flashResult = "fail";
      flashReason = err instanceof Error ? err.message : String(err);
    }
  }

  async function cancelFlash(): Promise<void> {
    if (!flashHandle) return;
    try {
      await flashHandle.stop();
    } finally {
      flashHandle = null;
      flashing = false;
      flashResult = "fail";
      flashReason = "cancelled by user";
      appendLog("error", "cancelled by user");
    }
  }

  async function addToRegistry(): Promise<void> {
    addingToRegistry = true;
    registryAddError = null;
    try {
      const host = ipMode === "static" ? staticIp.trim() : staticIp.trim();
      const res = await window.helm.vehicle.add({
        name: vehicleName.trim(),
        host,
        kind: "ground",
      });
      if (res.ok) {
        registryAddOk = true;
      } else {
        registryAddError = res.error ?? "add failed";
      }
    } catch (err) {
      registryAddError = err instanceof Error ? err.message : String(err);
    } finally {
      addingToRegistry = false;
    }
  }

  function close(): void {
    backToList();
  }

  onDestroy(() => {
    if (flashHandle) void flashHandle.stop();
  });
</script>

<div class="page">
  <header class="page-header">
    <button class="back" on:click={close} disabled={flashing}>← Devices</button>
    <h2>Configure Board</h2>
    <div class="port-tag">
      <span class="path">{port.path}</span>
    </div>
  </header>

  <div class="form">
    <!-- Board -->
    <section>
      <h3>Board</h3>
      <label>
        <span class="lbl">Board type</span>
        <select bind:value={board} disabled={flashing}>
          {#each BOARD_OPTIONS as o (o.value)}
            <option value={o.value}>{o.label}</option>
          {/each}
        </select>
      </label>
      {#if port.boardHint}
        <p class="muted small">Auto-detected from USB descriptors as <strong>{port.boardHint}</strong>. Override here if needed.</p>
      {/if}
    </section>

    <!-- Template -->
    <section>
      <h3>Firmware template</h3>
      {#if templatesLoading}
        <p class="muted">Loading templates…</p>
      {:else if templatesError}
        <p class="error">{templatesError}</p>
      {:else if filteredTemplates.length === 0}
        <p class="muted">
          No templates target this board yet. Flashing for this board lands in a follow-up.
        </p>
      {:else}
        <label>
          <span class="lbl">Template</span>
          <select bind:value={selectedTemplateId} disabled={flashing}>
            {#each filteredTemplates as t (t.id)}
              <option value={t.id}>{t.name}</option>
            {/each}
          </select>
        </label>
        {#if selectedTemplate?.description}
          <p class="muted small">{selectedTemplate.description}</p>
        {/if}
      {/if}
    </section>

    <!-- Identity -->
    <section>
      <h3>Vehicle identity</h3>
      <label>
        <span class="lbl">Name</span>
        <input
          type="text"
          bind:value={vehicleName}
          on:input={() => markTouched("vehicleName")}
          placeholder="Truck"
          disabled={flashing}
        />
      </label>
      <p class="muted small">
        ID: <code>{vehicleSlug || "—"}</code>
      </p>
    </section>

    <!-- WiFi -->
    <section>
      <h3>WiFi</h3>
      <label>
        <span class="lbl">SSID</span>
        <input
          type="text"
          bind:value={wifiSsid}
          on:input={() => markTouched("wifiSsid")}
          placeholder="MyNetwork"
          disabled={flashing}
        />
      </label>
      <label>
        <span class="lbl">Password</span>
        <input
          type="password"
          bind:value={wifiPassword}
          on:input={() => markTouched("wifiPassword")}
          placeholder="••••••••"
          disabled={flashing}
        />
      </label>
    </section>

    <!-- Networking -->
    <section>
      <h3>Networking</h3>
      <div class="radio-row">
        <label class="radio">
          <input
            type="radio"
            value="static"
            bind:group={ipMode}
            on:change={() => markTouched("ipMode")}
            disabled={flashing}
          />
          Static IP
        </label>
        <label class="radio">
          <input
            type="radio"
            value="dhcp"
            bind:group={ipMode}
            on:change={() => markTouched("ipMode")}
            disabled={flashing}
          />
          DHCP
        </label>
      </div>
      {#if ipMode === "static"}
        <label>
          <span class="lbl">IP Address</span>
          <input
            type="text"
            bind:value={staticIp}
            on:input={() => markTouched("staticIp")}
            placeholder="192.168.1.50"
            disabled={flashing}
          />
        </label>
        <label>
          <span class="lbl">CIDR prefix</span>
          <input
            type="number"
            min="0"
            max="32"
            bind:value={staticCidr}
            on:input={() => markTouched("staticCidr")}
            disabled={flashing}
          />
        </label>
        <p class="muted small">
          The vehicle will be reached at this IP after flash. The Drive tab uses
          this as the host.
        </p>
      {:else}
        <p class="muted small">
          DHCP: the truck firmware prints its assigned IP to serial on boot.
          You'll need to discover it before driving.
        </p>
      {/if}
    </section>

    <!-- Advanced -->
    {#if selectedTemplate}
      <section>
        <button
          class="disclosure"
          type="button"
          on:click={() => (advancedOpen = !advancedOpen)}
        >
          {advancedOpen ? "▾" : "▸"} Advanced (motor trim, invert)
        </button>
        {#if advancedOpen}
          <div class="advanced">
            <label>
              <span class="lbl">Left motor trim (-40..40)</span>
              <input
                type="number"
                min="-40"
                max="40"
                bind:value={motorLeftTrim}
                on:input={() => markTouched("motorLeftTrim")}
                disabled={flashing}
              />
            </label>
            <label>
              <span class="lbl">Right motor trim (-40..40)</span>
              <input
                type="number"
                min="-40"
                max="40"
                bind:value={motorRightTrim}
                on:input={() => markTouched("motorRightTrim")}
                disabled={flashing}
              />
            </label>
            <label class="checkbox">
              <input
                type="checkbox"
                bind:checked={motorInvertLeft}
                on:change={() => markTouched("motorInvertLeft")}
                disabled={flashing}
              />
              Invert left motor
            </label>
            <label class="checkbox">
              <input
                type="checkbox"
                bind:checked={motorInvertRight}
                on:change={() => markTouched("motorInvertRight")}
                disabled={flashing}
              />
              Invert right motor
            </label>
          </div>
        {/if}
      </section>
    {/if}

    <!-- Actions -->
    <section class="actions">
      {#if !flashing}
        <button
          class="flash"
          type="button"
          on:click={startFlash}
          disabled={!canFlash()}
        >
          Flash
        </button>
      {:else}
        <button class="cancel" type="button" on:click={cancelFlash}>
          Cancel
        </button>
      {/if}
      {#if !selectedTemplate}
        <span class="muted small">Select a template to flash.</span>
      {/if}
    </section>

    <!-- Live log + result -->
    {#if logLines.length > 0 || flashing || flashResult}
      <section>
        <h3>Flash log</h3>
        <pre class="log" bind:this={logEl}>
{#each logLines as line, i (i)}<span class="log-stage">{line.stage}</span> {line.text}
{/each}
        </pre>

        {#if flashResult === "ok"}
          {#if addingToRegistry}
            <p class="muted small">Flash succeeded. Adding to vehicle registry…</p>
          {:else if registryAddOk}
            <p class="ok">
              Flashed and added to registry as <code>{vehicleSlug}</code>.
              <button class="link" type="button" on:click={close}>Back to Devices →</button>
            </p>
          {:else if registryAddError}
            <p class="error">
              Flash succeeded but registry add failed: {registryAddError}
            </p>
          {/if}
        {:else if flashResult === "fail"}
          <p class="error">Flash failed{flashReason ? `: ${flashReason}` : "."}</p>
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .page {
    overflow-y: auto;
    padding: 1rem 1.5rem;
    background: var(--bg);
  }
  .page-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin: 0 0 1rem 0;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
  }
  .back {
    background: var(--surface-2, #1c232c);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 0.35rem 0.7rem;
    border-radius: 6px;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .back:hover:not(:disabled) {
    color: var(--fg);
    border-color: var(--accent);
  }
  .back:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .port-tag {
    margin-left: auto;
    padding: 0.3rem 0.6rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .port-tag .path {
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
  }
  .form {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    max-width: 720px;
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
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.6rem;
  }
  label:last-child {
    margin-bottom: 0;
  }
  label.checkbox,
  label.radio {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
  }
  .lbl {
    font-size: 0.75rem;
    color: var(--muted);
  }
  input[type="text"],
  input[type="password"],
  input[type="number"],
  select {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 0.4rem 0.55rem;
    border-radius: 5px;
    font: inherit;
    font-size: 0.85rem;
    width: 100%;
    box-sizing: border-box;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .radio-row {
    display: flex;
    gap: 1rem;
    margin-bottom: 0.6rem;
  }
  .muted {
    color: var(--muted);
    margin: 0.3rem 0 0 0;
  }
  .muted.small,
  .small {
    font-size: 0.75rem;
  }
  .error {
    color: var(--danger, #f85149);
    font-size: 0.85rem;
    margin: 0.4rem 0 0 0;
  }
  .ok {
    color: var(--good, #3fb950);
    font-size: 0.85rem;
    margin: 0.4rem 0 0 0;
  }
  .disclosure {
    background: none;
    border: none;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
    padding: 0;
  }
  .advanced {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .flash {
    background: var(--accent, #58a6ff);
    color: #0d1117;
    border: none;
    padding: 0.55rem 1.4rem;
    border-radius: 6px;
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  .flash:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .cancel {
    background: var(--danger, #f85149);
    color: #fff;
    border: none;
    padding: 0.55rem 1.4rem;
    border-radius: 6px;
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  .log {
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.6rem 0.8rem;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    line-height: 1.4;
    max-height: 320px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .log-stage {
    color: var(--muted);
    margin-right: 0.5rem;
  }
  .link {
    background: none;
    border: none;
    color: var(--accent, #58a6ff);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
    padding: 0;
    margin-left: 0.4rem;
  }
  code {
    background: var(--bg);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.75rem;
  }
</style>
