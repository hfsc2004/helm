<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type {
    FlashStartRequest,
    FlashStreamEvent,
    FlashTemplateSummary,
    SerialPortInfo,
  } from "@shared/ipc-channels";
  import { backToList } from "../stores/devices-view";
  import { fleet } from "../stores/vehicles";

  export let port: SerialPortInfo;

  type BoardKind =
    | "esp32"
    | "esp32-s3"
    | "raspberry-pi-pico"
    | "raspberry-pi-pico-w"
    | "raspberry-pi-pico-2w";

  const BOARD_OPTIONS: Array<{ value: BoardKind; label: string }> = [
    { value: "esp32", label: "ESP32 (drive board)" },
    { value: "esp32-s3", label: "ESP32-S3 (video / camera board)" },
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
    if (b === "esp32") {
      // Drive-side templates (FQBN esp32:esp32:esp32) — not the S3 ones.
      return t.target === "esp32" && !t.fqbn.includes("esp32s3");
    }
    if (b === "esp32-s3") {
      return t.fqbn.includes("esp32s3");
    }
    if (b.startsWith("raspberry-pi-pico")) {
      return t.target === "pico" || t.target === "rp2040";
    }
    return false;
  }

  $: isVideoTemplate = selectedTemplate?.id === "video-esp32-s3";
  $: boardRole = isVideoTemplate ? ("video" as const) : ("drive" as const);

  $: if (filteredTemplates.length === 1) {
    selectedTemplateId = filteredTemplates[0]!.id;
  } else if (!filteredTemplates.some((t) => t.id === selectedTemplateId)) {
    selectedTemplateId = "";
  }

  // ---------- common form state ----------
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

  // Drive-board advanced (motor trims & invert flags).
  let advancedOpen = false;
  let motorLeftTrim = 0;
  let motorRightTrim = 0;
  let motorInvertLeft = false;
  let motorInvertRight = false;

  // Video-board specific (template var-driven).
  let videoPinProfile = "esp32s3_eye";
  let videoFrameSize = "VGA";
  let videoJpegQuality = 12;
  let videoHttpPort = 81;
  let videoStreamPath = "/stream";
  let videoSnapshotPath = "/capture";
  let videoFlashStatusPath = "/health";
  let videoEraseBeforeUpload = false;
  let videoCaptureSerialMs = 20000;

  // Existing vehicle to attach the camera sidecar to, when we flash the
  // video board. Optional — if blank, the user can wire it up later from
  // the Vehicles tab.
  let attachToVehicleId = "";
  $: fleetVehicles = $fleet.vehicles;

  // Track which fields the user has typed in so we don't overwrite their input
  // when re-applying template defaults.
  const touched = new Set<string>();
  function markTouched(key: string): void {
    touched.add(key);
  }

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
      } else if (v.key === "camera.pinProfile" && typeof d === "string") {
        if (!touched.has("videoPinProfile")) videoPinProfile = d;
      } else if (v.key === "camera.frameSize" && typeof d === "string") {
        if (!touched.has("videoFrameSize")) videoFrameSize = d;
      } else if (v.key === "camera.jpegQuality" && typeof d === "number") {
        if (!touched.has("videoJpegQuality")) videoJpegQuality = d;
      } else if (v.key === "http.port" && typeof d === "number") {
        if (!touched.has("videoHttpPort")) videoHttpPort = d;
      }
    }
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

  onMount(async () => {
    await refreshTemplates();
    await fleet.refresh();
  });

  function appendLog(stage: string, text: string): void {
    const trimmed = text.replace(/\s+$/u, "");
    if (!trimmed) return;
    logLines = [...logLines, { stage, text: trimmed }];
    queueMicrotask(() => {
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
  }

  function buildVars(): Record<string, unknown> {
    if (isVideoTemplate) {
      return {
        "wifi.ssid": wifiSsid,
        "wifi.password": wifiPassword,
        "wifi.useStatic": ipMode === "static",
        "wifi.staticIp": staticIp,
        "wifi.staticCidr": staticCidr,
        "http.port": videoHttpPort,
        "camera.pinProfile": videoPinProfile,
        "camera.frameSize": videoFrameSize,
        "camera.jpegQuality": videoJpegQuality,
      };
    }
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

  function pinProfileBuildProps(): string[] {
    // Map the user-selected pin profile to a -D macro that selects the right
    // pin block at compile time.
    const map: Record<string, string> = {
      esp32s3_eye: "build.extra_flags=-DCAMERA_PIN_PROFILE_ESP32S3_EYE",
      ai_thinker_s3: "build.extra_flags=-DCAMERA_PIN_PROFILE_AI_THINKER_S3",
      elegoo_s3: "build.extra_flags=-DCAMERA_PIN_PROFILE_ELEGOO_S3",
    };
    const flag = map[videoPinProfile];
    return flag ? [flag] : [];
  }

  function canFlash(): boolean {
    if (flashing) return false;
    if (!selectedTemplate) return false;
    if (!vehicleName.trim() || !vehicleSlug) {
      if (!isVideoTemplate) return false;
      // For video, name is optional — we can attach to an existing vehicle.
      if (!attachToVehicleId) return false;
    }
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
      board: boardRole,
    };
    if (isVideoTemplate) {
      req.buildProperties = pinProfileBuildProps();
      req.eraseBeforeUpload = videoEraseBeforeUpload;
      req.captureRuntimeSerialMs = videoCaptureSerialMs > 0 ? videoCaptureSerialMs : undefined;
    }

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
          if (ev.ok) void afterSuccessfulFlash();
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

  async function afterSuccessfulFlash(): Promise<void> {
    if (isVideoTemplate) {
      // Attach the camera sidecar to either an existing vehicle (attachToVehicleId)
      // or to a freshly-created one.
      addingToRegistry = true;
      registryAddError = null;
      try {
        let targetId = attachToVehicleId;
        if (!targetId && vehicleName.trim()) {
          const addRes = await fleet.add({
            name: vehicleName.trim(),
            host: ipMode === "static" ? staticIp.trim() : staticIp.trim(),
          });
          if (!addRes.ok || !addRes.vehicle) {
            registryAddError = addRes.error ?? "vehicle create failed";
            return;
          }
          targetId = addRes.vehicle.id;
        }
        if (!targetId) {
          registryAddError = "no vehicle to attach the camera to";
          return;
        }
        const camRes = await fleet.setCamera(targetId, {
          baseUrl: `http://${staticIp.trim()}:${videoHttpPort}`,
          streamPath: videoStreamPath,
          snapshotPath: videoSnapshotPath,
          flashStatusPath: videoFlashStatusPath,
        });
        if (!camRes.ok) {
          registryAddError = camRes.error ?? "camera attach failed";
          return;
        }
        registryAddOk = true;
      } finally {
        addingToRegistry = false;
      }
      return;
    }

    // Drive board: create the vehicle and persist drive tuning.
    addingToRegistry = true;
    registryAddError = null;
    try {
      const res = await fleet.add({
        name: vehicleName.trim(),
        host: ipMode === "static" ? staticIp.trim() : staticIp.trim(),
      });
      if (!res.ok || !res.vehicle) {
        registryAddError = res.error ?? "add failed";
        return;
      }
      // Persist motor invert flags as drive tuning so they're reachable
      // from the CLI / Vehicles tab without re-flashing.
      await fleet.setDrive(res.vehicle.id, {
        invertLeft: motorInvertLeft,
        invertRight: motorInvertRight,
      });
      registryAddOk = true;
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

    <section>
      <h3>Firmware template</h3>
      {#if templatesLoading}
        <p class="muted">Loading templates…</p>
      {:else if templatesError}
        <p class="error">{templatesError}</p>
      {:else if filteredTemplates.length === 0}
        <p class="muted">
          No templates target this board yet.
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

    {#if isVideoTemplate}
      <section>
        <h3>Attach to vehicle</h3>
        <p class="muted small">
          The camera sidecar attaches to a vehicle by its IP. Pick an existing one,
          or leave blank and we'll create a new vehicle with the name below.
        </p>
        <label>
          <span class="lbl">Existing vehicle (optional)</span>
          <select bind:value={attachToVehicleId} disabled={flashing}>
            <option value="">— create new vehicle —</option>
            {#each fleetVehicles as v (v.id)}
              <option value={v.id}>{v.name} ({v.transport.host})</option>
            {/each}
          </select>
        </label>
        {#if !attachToVehicleId}
          <label>
            <span class="lbl">New vehicle name</span>
            <input
              type="text"
              bind:value={vehicleName}
              on:input={() => markTouched("vehicleName")}
              placeholder="Truck"
              disabled={flashing}
            />
          </label>
        {/if}
      </section>
    {:else}
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
    {/if}

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
          The board will be reached at this IP after flash.
        </p>
      {:else}
        <p class="muted small">
          DHCP: the board prints its assigned IP to serial on boot.
        </p>
      {/if}
    </section>

    {#if isVideoTemplate}
      <section>
        <h3>Camera</h3>
        <label>
          <span class="lbl">Pin profile</span>
          <select bind:value={videoPinProfile} disabled={flashing}>
            <option value="esp32s3_eye">ESP32-S3-EYE (Espressif dev board)</option>
            <option value="ai_thinker_s3">AI-Thinker ESP32-S3-CAM</option>
            <option value="elegoo_s3">Elegoo ESP32-S3-WROOM-1 shield</option>
          </select>
        </label>
        <label>
          <span class="lbl">Default frame size</span>
          <select bind:value={videoFrameSize} disabled={flashing}>
            <option value="QVGA">QVGA (320×240)</option>
            <option value="VGA">VGA (640×480)</option>
            <option value="SVGA">SVGA (800×600)</option>
            <option value="XGA">XGA (1024×768)</option>
            <option value="HD">HD (1280×720)</option>
          </select>
        </label>
        <label>
          <span class="lbl">JPEG quality (0..63, lower=better)</span>
          <input type="number" min="0" max="63" bind:value={videoJpegQuality} disabled={flashing} />
        </label>
        <label>
          <span class="lbl">HTTP port</span>
          <input type="number" min="1" max="65535" bind:value={videoHttpPort} disabled={flashing} />
        </label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={videoEraseBeforeUpload} disabled={flashing} />
          Erase flash before upload
        </label>
        <label>
          <span class="lbl">Post-upload serial capture (ms)</span>
          <input type="number" min="0" max="120000" bind:value={videoCaptureSerialMs} disabled={flashing} />
        </label>
      </section>
    {/if}

    {#if selectedTemplate && !isVideoTemplate}
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
              <input type="number" min="-40" max="40" bind:value={motorLeftTrim} disabled={flashing} />
            </label>
            <label>
              <span class="lbl">Right motor trim (-40..40)</span>
              <input type="number" min="-40" max="40" bind:value={motorRightTrim} disabled={flashing} />
            </label>
            <label class="checkbox">
              <input type="checkbox" bind:checked={motorInvertLeft} disabled={flashing} />
              Invert left motor
            </label>
            <label class="checkbox">
              <input type="checkbox" bind:checked={motorInvertRight} disabled={flashing} />
              Invert right motor
            </label>
          </div>
        {/if}
      </section>
    {/if}

    <section class="actions">
      {#if !flashing}
        <button class="flash" type="button" on:click={startFlash} disabled={!canFlash()}>
          Flash {boardRole === "video" ? "video" : "drive"} board
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

    {#if logLines.length > 0 || flashing || flashResult}
      <section>
        <h3>Flash log</h3>
        <pre class="log" bind:this={logEl}>
{#each logLines as line, i (i)}<span class="log-stage">{line.stage}</span> {line.text}
{/each}
        </pre>

        {#if flashResult === "ok"}
          {#if addingToRegistry}
            <p class="muted small">Flash succeeded. Updating vehicle registry…</p>
          {:else if registryAddOk}
            <p class="ok">
              Flashed and registered.
              <button class="link" type="button" on:click={close}>Back to Devices →</button>
            </p>
          {:else if registryAddError}
            <p class="error">Flash succeeded but registry update failed: {registryAddError}</p>
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
