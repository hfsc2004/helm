<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type {
    FlashStartRequest,
    FlashStreamEvent,
    FlashTemplateSummary,
    SerialPortInfo,
    WifiNetworkInfo,
    WifiScanResponse,
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
  // Derive from allTemplates (not filteredTemplates) so this can never be
  // stale relative to the dropdown's bound value during reactive batching.
  // If selectedTemplateId points at a template that exists at all, we want
  // to find it.
  $: selectedTemplate = allTemplates.find((t) => t.id === selectedTemplateId) ?? null;

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

  // Keep selectedTemplateId in sync with whatever filteredTemplates currently
  // contains. Three cases worth handling explicitly because the previous
  // `length === 1 || stale` short-circuit was missing the "multiple available
  // but selection is stale" case and could leave selectedTemplateId pointing
  // at an id that no longer exists in the dropdown (so `selectedTemplate`
  // resolves to null and canFlash() refuses with "pick a template" even
  // though the dropdown visually shows a row).
  $: {
    const stillValid = filteredTemplates.some((t) => t.id === selectedTemplateId);
    if (filteredTemplates.length === 0) {
      selectedTemplateId = "";
    } else if (!stillValid) {
      // Either nothing was selected yet, or the previous selection got
      // filtered out. Pick the first available so the user starts on a
      // valid option without needing to re-click the dropdown.
      selectedTemplateId = filteredTemplates[0]!.id;
    }
  }

  // ---------- common form state ----------
  let vehicleName = "";
  let vehicleSlug = "";
  $: vehicleSlug = vehicleName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // The mDNS hostname the firmware will advertise. Defaults to the vehicle
  // slug (already RFC-6763 safe — lowercase, alphanumerics, hyphens). Empty
  // when the user hasn't typed a name yet; we fall back to "psf-robot" at
  // flash time so the firmware always has something to advertise.
  $: mdnsName = vehicleSlug || "psf-robot";
  $: mdnsHost = `${mdnsName}.local`;

  let wifiSsid = "";
  let wifiPassword = "";
  // Show/mask the WiFi password while typing — lets the user verify they
  // got it right before the firmware bakes it in (a typo here means
  // re-flashing, which is slow and annoying).
  let wifiPasswordVisible = false;

  // Host-side Wi-Fi scan. When ok with results, we show a dropdown; when
  // unsupported or empty we silently fall back to a plain text input so
  // nothing about the existing flow gets worse on platforms we haven't
  // wired (macOS, Windows). The user can always opt into manual entry.
  let wifiScan: WifiScanResponse | null = null;
  let wifiScanLoading = false;
  let wifiManualEntry = false;

  // The host's radio sees networks the target board can't reach — most ESP32
  // chips are 2.4GHz-only. Derive which bands the selected template can
  // actually join from its FQBN, then filter the scan results so the user
  // doesn't pick an SSID that would silently fail to associate.
  $: supportedBands = boardBandsFromFqbn(selectedTemplate?.fqbn ?? "");
  $: filteredWifiNetworks = (wifiScan?.networks ?? []).filter(
    (n) => n.band === null || supportedBands.includes(n.band)
  );
  $: hiddenByBandCount =
    (wifiScan?.networks.length ?? 0) - filteredWifiNetworks.length;
  $: wifiHasResults = !!wifiScan && wifiScan.ok && filteredWifiNetworks.length > 0;
  $: showWifiDropdown = wifiHasResults && !wifiManualEntry;

  function boardBandsFromFqbn(fqbn: string): Array<"2.4GHz" | "5GHz" | "6GHz"> {
    // Source of truth is the silicon, not the sketch. Update this map when
    // adding a template that targets a new chip family.
    const f = fqbn.toLowerCase();
    // Wi-Fi 6 / 6E parts: ESP32-C5, ESP32-C6 (2.4 + 5GHz on C5; 2.4 only on C6
    // but with 802.11ax). Most ESP32 family chips remain 2.4-only.
    if (f.includes("esp32c5")) return ["2.4GHz", "5GHz"];
    // Boards Helm doesn't ship templates for today but planning for: pico 2w
    // dual-band. Safe default for any other chip is 2.4GHz-only.
    if (f.includes("pico_2w") || f.includes("pico-2w")) return ["2.4GHz", "5GHz"];
    return ["2.4GHz"];
  }

  async function refreshWifiScan(): Promise<void> {
    wifiScanLoading = true;
    try {
      wifiScan = await window.helm.wifi.scan();
    } catch (err) {
      wifiScan = {
        ok: false,
        networks: [],
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      wifiScanLoading = false;
    }
  }

  function wifiBandLabel(band: WifiNetworkInfo["band"]): string {
    return band ?? "?";
  }

  function wifiSignalBars(signal: number | null): string {
    if (signal === null) return "····";
    if (signal >= 75) return "▮▮▮▮";
    if (signal >= 50) return "▮▮▮·";
    if (signal >= 25) return "▮▮··";
    return "▮···";
  }
  let ipMode: "static" | "dhcp" = "static";
  let staticIp = "192.168.1.50";
  let staticCidr = 24;

  // What to write into Vehicle.transport.host. With DHCP we use mDNS; with
  // a static IP, the IP itself is the most direct route. The user can edit
  // this later from the Vehicles tab if their network blocks mDNS.
  $: resolvedHost = ipMode === "static" ? staticIp.trim() : mdnsHost;

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
    await Promise.all([refreshTemplates(), fleet.refresh(), refreshWifiScan()]);
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
        "mdns.name": mdnsName,
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
      "mdns.name": mdnsName,
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

  // Returns a human-readable reason the flash can't start, or "" when it's
  // ready. Drives both the Flash button's disabled state and the visible
  // checklist underneath it, so the user never has to guess what's missing.
  // Resolves the selected template inline (rather than relying on the $:
  // derived `selectedTemplate`) so the gate is consistent with what the
  // dropdown is currently bound to, regardless of Svelte reactive ordering.
  function flashBlockReason(): string {
    if (flashing) return "flash in progress";
    if (!selectedTemplateId) return "pick a template";
    const tpl = allTemplates.find((t) => t.id === selectedTemplateId);
    if (!tpl) {
      return allTemplates.length === 0
        ? "loading templates…"
        : "pick a template";
    }
    const tplIsVideo = tpl.id === "video-esp32-s3";
    if (!vehicleName.trim()) {
      if (!tplIsVideo) return "enter a vehicle name";
      if (!attachToVehicleId) return "enter a vehicle name (or attach to an existing one)";
    }
    if (vehicleName.trim() && !vehicleSlug && !tplIsVideo) {
      return "vehicle name needs at least one letter or number";
    }
    if (!wifiSsid.trim()) return "pick or type a WiFi SSID";
    if (!wifiPassword) return "enter the WiFi password";
    if (ipMode === "static") {
      const m = staticIp.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (!m) return "static IP must be in N.N.N.N form";
      if (m.slice(1).some((s) => Number(s) > 255)) return "static IP octets must be 0–255";
      if (!Number.isInteger(staticCidr) || staticCidr < 0 || staticCidr > 32) {
        return "CIDR prefix must be an integer 0–32";
      }
    }
    return "";
  }

  // Reference the reactive inputs explicitly so Svelte tracks them and
  // re-runs flashBlockReason() when any of them change. Without this list,
  // Svelte can fail to invalidate `blockReason` when the user updates a
  // field inside the dialog — leaving the user staring at a stale gate.
  $: blockReason = (
    flashing,
    selectedTemplateId,
    allTemplates,
    vehicleName,
    vehicleSlug,
    wifiSsid,
    wifiPassword,
    ipMode,
    staticIp,
    staticCidr,
    attachToVehicleId,
    flashBlockReason()
  );

  function canFlash(): boolean {
    return blockReason === "";
  }

  async function startFlash(): Promise<void> {
    if (!canFlash() || !selectedTemplate) return;
    flashing = true;
    flashResult = null;
    flashReason = null;
    registryAddError = null;
    registryAddOk = false;
    registryReused = false;
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

  // Find an existing vehicle by name (case-sensitive, post-trim) or create
  // a new one. Re-flashing the same robot should be idempotent at the
  // registry layer — we used to throw "already exists" and force the user
  // to delete by hand. Returns the vehicle id and whether we created vs.
  // reused so the UI can phrase the success message accurately.
  async function findOrCreateVehicle(
    name: string,
    host: string
  ): Promise<{ ok: boolean; vehicleId?: string; reused?: boolean; error?: string }> {
    await fleet.refresh();
    const trimmed = name.trim();
    const existing = $fleet.vehicles.find((v) => v.name === trimmed);
    if (existing) {
      return { ok: true, vehicleId: existing.id, reused: true };
    }
    const addRes = await fleet.add({ name: trimmed, host });
    if (!addRes.ok || !addRes.vehicle) {
      return { ok: false, error: addRes.error ?? "vehicle create failed" };
    }
    return { ok: true, vehicleId: addRes.vehicle.id, reused: false };
  }

  // Tracks whether the most recent successful registry write was a fresh
  // create or an update of an existing record. UI uses this to pick the
  // right message ("Created" vs "Updated existing").
  let registryReused = false;

  async function afterSuccessfulFlash(): Promise<void> {
    if (isVideoTemplate) {
      // Attach the camera sidecar to either an existing vehicle (attachToVehicleId)
      // or to a freshly-created/reused one keyed by name.
      addingToRegistry = true;
      registryAddError = null;
      try {
        let targetId = attachToVehicleId;
        let reused = !!attachToVehicleId;
        if (!targetId && vehicleName.trim()) {
          const res = await findOrCreateVehicle(vehicleName, resolvedHost);
          if (!res.ok || !res.vehicleId) {
            registryAddError = res.error ?? "vehicle create failed";
            return;
          }
          targetId = res.vehicleId;
          reused = !!res.reused;
        }
        if (!targetId) {
          registryAddError = "no vehicle to attach the camera to";
          return;
        }
        const camRes = await fleet.setCamera(targetId, {
          baseUrl: `http://${resolvedHost}:${videoHttpPort}`,
          streamPath: videoStreamPath,
          snapshotPath: videoSnapshotPath,
          flashStatusPath: videoFlashStatusPath,
        });
        if (!camRes.ok) {
          registryAddError = camRes.error ?? "camera attach failed";
          return;
        }
        registryReused = reused;
        registryAddOk = true;
      } finally {
        addingToRegistry = false;
      }
      return;
    }

    // Drive board: find-or-create the vehicle and persist drive tuning.
    addingToRegistry = true;
    registryAddError = null;
    try {
      const res = await findOrCreateVehicle(vehicleName, resolvedHost);
      if (!res.ok || !res.vehicleId) {
        registryAddError = res.error ?? "add failed";
        return;
      }
      // Persist motor invert flags as drive tuning so they're reachable
      // from the CLI / Vehicles tab without re-flashing.
      await fleet.setDrive(res.vehicleId, {
        invertLeft: motorInvertLeft,
        invertRight: motorInvertRight,
      });
      registryReused = !!res.reused;
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
            {#if !selectedTemplateId}
              <option value="" disabled>— pick a template —</option>
            {/if}
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
      {#if showWifiDropdown}
        <label>
          <span class="lbl">SSID
            <button
              type="button"
              class="link"
              on:click={() => void refreshWifiScan()}
              disabled={flashing || wifiScanLoading}
            >{wifiScanLoading ? "scanning…" : "rescan"}</button>
            <button
              type="button"
              class="link"
              on:click={() => { wifiManualEntry = true; }}
              disabled={flashing}
            >type manually</button>
          </span>
          <select
            bind:value={wifiSsid}
            on:change={() => markTouched("wifiSsid")}
            disabled={flashing}
          >
            <option value="" disabled selected={!wifiSsid}>— pick a network —</option>
            {#each filteredWifiNetworks as n (n.ssid)}
              <option value={n.ssid}>
                {wifiSignalBars(n.signal)} {n.ssid} · {wifiBandLabel(n.band)} · {n.security}
              </option>
            {/each}
          </select>
        </label>
        {#if hiddenByBandCount > 0}
          <p class="muted small">
            {hiddenByBandCount} network{hiddenByBandCount === 1 ? "" : "s"} hidden
            (this board is {supportedBands.join(" / ")} only).
          </p>
        {/if}
      {:else}
        <label>
          <span class="lbl">SSID
            {#if wifiHasResults}
              <button
                type="button"
                class="link"
                on:click={() => { wifiManualEntry = false; }}
                disabled={flashing}
              >pick from scan</button>
            {:else if !wifiScanLoading}
              <button
                type="button"
                class="link"
                on:click={() => void refreshWifiScan()}
                disabled={flashing}
              >scan</button>
            {/if}
          </span>
          <input
            type="text"
            bind:value={wifiSsid}
            on:input={() => markTouched("wifiSsid")}
            placeholder="MyNetwork"
            disabled={flashing}
          />
        </label>
        {#if wifiScan && !wifiScan.ok && !wifiHasResults}
          <p class="muted small">{wifiScan.reason ?? "scan unavailable on this host"}</p>
        {/if}
      {/if}
      <label>
        <span class="lbl">Password</span>
        <div class="password-wrap">
          <input
            type={wifiPasswordVisible ? "text" : "password"}
            bind:value={wifiPassword}
            on:input={() => markTouched("wifiPassword")}
            placeholder="••••••••"
            disabled={flashing}
          />
          <button
            type="button"
            class="reveal"
            on:click={() => { wifiPasswordVisible = !wifiPasswordVisible; }}
            aria-label={wifiPasswordVisible ? "Hide password" : "Show password"}
            title={wifiPasswordVisible ? "Hide password" : "Show password"}
            disabled={flashing}
          >
            {#if wifiPasswordVisible}
              <!-- eye-off -->
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.6 19.6 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A11 11 0 0 1 12 4c7 0 11 8 11 8a19.6 19.6 0 0 1-3.17 4.19" />
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            {:else}
              <!-- eye -->
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            {/if}
          </button>
        </div>
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
          The board will be reached at <code>{staticIp.trim()}</code>.
          It will also advertise itself as
          <code>{mdnsHost}</code> via mDNS as a backup.
        </p>
      {:else}
        <p class="muted small">
          DHCP: the router assigns the IP. Helm will reach the board by its mDNS name
          <code>{mdnsHost}</code> instead, so a new lease won't break the connection.
        </p>
        <p class="muted small">
          Heads-up: mDNS needs Avahi (Linux) or Bonjour (Windows). Most desktops already have one;
          on networks that block multicast (some guest WiFi), switch to Static IP instead.
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
        <button class="flash" type="button" on:click={startFlash} disabled={blockReason !== ""}>
          Flash {boardRole === "video" ? "video" : "drive"} board
        </button>
      {:else}
        <button class="cancel" type="button" on:click={cancelFlash}>
          Cancel
        </button>
      {/if}
      {#if !flashing && blockReason}
        <span class="block-reason" role="status" aria-live="polite">
          <span class="block-icon" aria-hidden="true">!</span>
          {blockReason}
        </span>
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
              {registryReused
                ? `Flashed. Updated existing vehicle "${vehicleName.trim()}" — host left untouched so you don't lose the .local name or static IP you'd already set.`
                : "Flashed and registered."}
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
  .password-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .password-wrap input {
    /* Reserve room for the reveal button so the dots don't slide under it. */
    padding-right: 2.25rem;
  }
  .reveal {
    position: absolute;
    right: 0.35rem;
    top: 50%;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    color: var(--muted);
    padding: 0.25rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }
  .reveal:hover:not(:disabled) {
    color: var(--fg);
    background: var(--surface-2, #1c232c);
  }
  .reveal:focus-visible {
    outline: none;
    color: var(--accent);
  }
  .reveal:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
  .block-reason {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--warn, #d29922);
    font-size: 0.8rem;
  }
  .block-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--warn, #d29922);
    color: #0d1117;
    font-weight: 700;
    font-size: 0.7rem;
    line-height: 1;
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
