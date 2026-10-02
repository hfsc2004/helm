<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import { onMount } from "svelte";
  import type { SensorBoardScanZone, SensorBoardSnapshotResponse } from "@shared/ipc-channels";
  import { isWideTofProfile, WIDE_TOF_PROFILES, type WideTofProfile } from "@shared/wide-tof";
  import { wideTofCells, wideDistanceBands as distanceBands } from "../lib/wide-tof-display";

  export let vehicleId: string;

  let snapshot: SensorBoardSnapshotResponse | null = null;
  let updatedAt = 0;
  let imuUpdatedAt = 0;
  let signalUpdatedAt = 0;
  let rangesUpdatedAt = 0;
  let wideUpdatedAt = 0;
  let now = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let wideTimer: ReturnType<typeof setTimeout> | undefined;
  let ageTimer: ReturnType<typeof setInterval> | undefined;
  let wideBusy = false;
  let wideEpoch = 0;
  let wideError = "";
  let profileError = "";
  $: wideResolution = snapshot?.wide?.resolution ??
    (snapshot?.wide?.rawDistanceMm?.length === 16 ? 16 : 64);
  $: gridSide = wideResolution === 16 ? 4 : 8;
  $: wideFrameAge = snapshot?.wide?.ageMs == null || !wideUpdatedAt ? Infinity :
    snapshot.wide.ageMs + Math.max(0, now - wideUpdatedAt);
  $: wideCells = wideTofCells(snapshot?.wide ?? null, wideFrameAge);
  $: canConfigureWide = (snapshot?.wide?.profileControlVersion ?? 0) >= 1;
  $: profileChoice = snapshot?.wide?.profile ?? "detail";
  $: rateChoice = snapshot?.wide?.frequencyHz ?? WIDE_TOF_PROFILES[profileChoice].hz;
  $: profileRates = Array.from(
    { length: WIDE_TOF_PROFILES[profileChoice].maxHz - WIDE_TOF_PROFILES[profileChoice].minHz + 1 },
    (_, i) => WIDE_TOF_PROFILES[profileChoice].minHz + i);
  $: frontScan = snapshot?.ranges?.singleZone?.find((item) => item.name === "front")?.scan;

  async function setWideProfile(profile: WideTofProfile, hz?: number) {
    if (wideBusy) return;
    wideBusy = true;
    ++wideEpoch;
    profileError = "";
    try {
      const result = await window.helm.vehicle.sensorBoardWideConfigure({ vehicleId, profile, hz });
      if (!result.ok) throw new Error(result.error ?? "SR Front profile change failed.");
      // A settings response has no distance frame. Wait for a fresh frame
      // instead of redrawing old measurements at the new resolution.
      snapshot = { ranges: snapshot?.ranges ?? null, imu: snapshot?.imu ?? null,
        wide: { ...result, ready: false }, rssi: snapshot?.rssi ?? null, error: snapshot?.error };
      wideUpdatedAt = 0;
    } catch (error) {
      profileError = String(error);
      if (snapshot?.wide) snapshot = { ...snapshot, wide: { ...snapshot.wide,
        ready: false, rawDistanceMm: undefined, targetStatus: undefined } };
      wideUpdatedAt = 0;
    } finally {
      if (active) wideBusy = false;
    }
  }

  function changeWideProfile(event: Event & { currentTarget: HTMLSelectElement }) {
    // Read the user's choice from the event, before reactive/poll updates can
    // overwrite it with the board's last confirmed value.
    const profile = event.currentTarget.value;
    if (isWideTofProfile(profile)) void setWideProfile(profile);
  }

  function changeWideRate(event: Event & { currentTarget: HTMLSelectElement }) {
    void setWideProfile(profileChoice, Number(event.currentTarget.value));
  }

  const formatDistance = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return "—";
    if (value >= 1000) return `${(value / 1000).toFixed(2).replace(/\.?0+$/, "")} m`;
    if (value >= 100) return `${(value / 10).toFixed(1).replace(/\.0$/, "")} cm`;
    return `${value} mm`;
  };
  const rangeText = (ranges: SensorBoardSnapshotResponse["ranges"], name: string) => {
    const sensor = ranges?.singleZone?.find((item) => item.name === name);
    if (!sensor) return "—";
    if (!sensor.ready) return "Offline";
    if (sensor.timeout) return "Timed out";
    if (sensor.distanceMm != null) return formatDistance(sensor.distanceMm);
    if (sensor.rangeStatus === 2) return "Weak return";
    if (sensor.rangeStatus === 4) return "Out of range";
    if (sensor.rangeStatus === 11) return "Merged targets";
    return "No valid return";
  };
  const scanZoneLabels: Record<string, string> = {
    full: "Full field",
    "upper-left": "ROI upper-left",
    "upper-right": "ROI upper-right",
    "lower-left": "ROI lower-left",
    "lower-right": "ROI lower-right",
  };
  const scanZoneShort: Record<string, string> = {
    "upper-left": "UL", "upper-right": "UR",
    "lower-left": "LL", "lower-right": "LR",
  };
  const effectiveAge = (boardAge: number | null | undefined, receivedAt: number) =>
    boardAge == null || !receivedAt ? null : boardAge + Math.max(0, now - receivedAt);
  const scanValue = (zone: SensorBoardScanZone) => {
    const confirmedAge = effectiveAge(zone.stableAgeMs, rangesUpdatedAt);
    if (zone.stableDistanceMm != null) {
      return `${formatDistance(zone.stableDistanceMm)}${confirmedAge != null && confirmedAge > 2000 ? " · stale" : ""}`;
    }
    const rawAge = effectiveAge(zone.ageMs, rangesUpdatedAt);
    if (zone.distanceMm != null && rawAge != null && rawAge <= 2000) {
      return `${formatDistance(zone.distanceMm)} · unconfirmed`;
    }
    const rawTarget = zone.targets?.[0];
    if (rawTarget && rawAge != null && rawAge <= 2000) {
      return `${formatDistance(rawTarget.distanceMm)} · raw, invalid`;
    }
    if (zone.rangeStatus === 11 && rawAge != null && rawAge <= 2000) return "Merged returns";
    if (zone.rangeStatus === 4 && rawAge != null && rawAge <= 2000) return "Out of range";
    return "—";
  };
  const overlayValue = (zone: SensorBoardScanZone) => {
    const age = effectiveAge(zone.stableAgeMs, rangesUpdatedAt);
    if (zone.stableDistanceMm != null) {
      return `${formatDistance(zone.stableDistanceMm)}${age != null && age > 2000 ? "*" : ""}`;
    }
    const rawAge = effectiveAge(zone.ageMs, rangesUpdatedAt);
    if (zone.distanceMm != null && rawAge != null && rawAge <= 2000) {
      return `${formatDistance(zone.distanceMm)}?`;
    }
    const rawTarget = zone.targets?.[0];
    return rawTarget && rawAge != null && rawAge <= 2000
      ? `${formatDistance(rawTarget.distanceMm)}!` : "—";
  };
  const scanDetail = (zone: SensorBoardScanZone) => {
    const age = effectiveAge(zone.stableAgeMs ?? zone.ageMs, rangesUpdatedAt);
    const ageText = age == null ? "no sample" : `${(age / 1000).toFixed(1)}s old`;
    const targets = zone.targets?.length ?? 0;
    return `${ageText} · ${targets} target${targets === 1 ? "" : "s"} · status ${zone.rangeStatus}`;
  };
  const scanTargetTitle = (zone: SensorBoardScanZone) =>
    zone.targets?.map((target, index) =>
      `Target ${index + 1}: ${formatDistance(target.distanceMm)}, status ${target.rangeStatus}, ${target.signalMcps.toFixed(2)} MCPS`
    ).join("\n") || "No targets in latest scan";
  const axis = (values: number[] | undefined, index: number, unit: string) =>
    values?.[index] == null ? "—" : `${values[index].toFixed(2)} ${unit}`;
  const angle = (values: number[] | null | undefined, index: number, sign = 1) =>
    values?.[index] == null ? "—" : `${(values[index] * sign).toFixed(1)}°`;
  const ageLabel = (sampledAt: number, currentTime: number) =>
    sampledAt && currentTime - sampledAt > 5000 ? ` · last sample ${Math.round((currentTime - sampledAt) / 1000)}s ago` : "";

  onMount(() => {
    active = true;
    ageTimer = setInterval(() => { now = Date.now(); }, 100);
    const pollWide = async () => {
      const epoch = wideEpoch;
      if (!wideBusy) {
        try {
          const next = await window.helm.vehicle.sensorBoardWideSnapshot({ vehicleId });
          if (active && !wideBusy && epoch === wideEpoch) {
            wideError = next.ok ? "" : next.error ?? "SR Front unavailable.";
            if (next.ok) {
              wideUpdatedAt = Date.now();
              snapshot = { ranges: snapshot?.ranges ?? null, imu: snapshot?.imu ?? null,
                wide: next, rssi: snapshot?.rssi ?? null, error: snapshot?.error };
            }
          }
        } catch (error) {
          if (active && epoch === wideEpoch) wideError = String(error);
        }
      }
      // Display polling is independent of the slower LR/IMU sidebar reads.
      const profile = snapshot?.wide?.profile;
      const interval = profile === "idle" ? 500 :
        profile === "fast" || profile === "navigation" ? 100 : 200;
      if (active) wideTimer = setTimeout(pollWide, interval);
    };
    const poll = async () => {
      try {
        const next = await window.helm.vehicle.sensorBoardSnapshot({ vehicleId, includeWide: false });
        if (!active) return;
        now = Date.now();
        if (next.ranges || next.imu || next.wide) updatedAt = now;
        if (next.imu) imuUpdatedAt = now;
        if (next.ranges) rangesUpdatedAt = now;
        if (next.rssi != null) signalUpdatedAt = now;
        snapshot = {
          ranges: next.ranges ?? snapshot?.ranges ?? null,
          imu: next.imu ?? snapshot?.imu ?? null,
          wide: snapshot?.wide ?? null,
          rssi: next.rssi ?? snapshot?.rssi ?? null,
          error: next.error,
        };
      } catch (error) {
        now = Date.now();
        snapshot = {
          ranges: snapshot?.ranges ?? null,
          imu: snapshot?.imu ?? null,
          wide: snapshot?.wide ?? null,
          rssi: snapshot?.rssi ?? null,
          error: String(error),
        };
      }
      if (active) timer = setTimeout(poll, 1500);
    };
    void poll();
    void pollWide();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (wideTimer) clearTimeout(wideTimer);
      if (ageTimer) clearInterval(ageTimer);
    };
  });
</script>

<section class="sensor-panel">
  <h2>Sensor Board v1.3</h2>
  <p class="status">
    {#if !snapshot}Connecting…
    {:else if snapshot.error}{snapshot.error}{updatedAt ? ` · last update ${new Date(updatedAt).toLocaleTimeString()}` : ""}
    {:else}Live · updated {new Date(updatedAt).toLocaleTimeString()}{/if}
  </p>

  <h3>LR Distance</h3>
  {#each ["front", "rear"] as name}
    {@const sensor = snapshot?.ranges?.singleZone?.find((item) => item.name === name)}
    <div class="readout"><span>LR {name === "front" ? "Front" : "Rear"} ToF</span><strong>{rangeText(snapshot?.ranges ?? null, name)}</strong></div>
    {#if sensor?.scan?.zones?.length === 5}
      <div class="scan-list" aria-label={`${name} ToF scan regions`}>
        {#each sensor.scan.zones as zone}
          <div class="scan-row" title={scanTargetTitle(zone)}>
            <span>{scanZoneLabels[zone.id] ?? zone.id}</span>
            <strong>{scanValue(zone)}</strong>
            <small>{scanDetail(zone)}</small>
          </div>
        {/each}
      </div>
      <p class="hint">Full field: {sensor.mode ?? "?"} mode · quadrants: {sensor.scan.quadrantMode} mode. Confirmed readings persist but are marked stale; latest raw targets are in each row’s tooltip.</p>
    {/if}
  {/each}
  <p class="hint">Quadrant names are chip-ROI coordinates, not verified physical left/right. A missing return does not mean the path is clear.</p>

  <h3>SR Front ToF · {gridSide}×{gridSide}</h3>
  <div class="wide-controls">
    <label>Profile
      <select value={profileChoice} disabled={wideBusy || !canConfigureWide}
        on:change={changeWideProfile}>
        {#each Object.entries(WIDE_TOF_PROFILES) as [profile, settings]}
          <option value={profile}>{settings.label} · ~{settings.observedFeet}′ · {settings.resolution === 16 ? "4×4" : "8×8"}</option>
        {/each}
      </select>
    </label>
    <label>Rate
      <select value={rateChoice} disabled={wideBusy || !canConfigureWide || profileRates.length === 1}
        on:change={changeWideRate}>
        {#each profileRates as hz}<option value={hz}>{hz} Hz</option>{/each}
      </select>
    </label>
  </div>
  {#if wideBusy}<p class="hint">Changing SR Front profile…</p>{/if}
  {#if profileError || wideError}<p class="hint error">{profileError || wideError}</p>{/if}
  {#if snapshot?.wide && !canConfigureWide}<p class="hint">Update the sensor-board firmware to enable SR Front profiles.</p>{/if}
  {#if snapshot?.wide?.profile}
    <p class="hint">Observed range: ~{WIDE_TOF_PROFILES[profileChoice].observedFeet}′ at {WIDE_TOF_PROFILES[profileChoice].hz} Hz in your test.</p>
    <p class="hint">{snapshot.wide.frequencyHz} Hz requested · {snapshot.wide.rangingMode} · strongest target{snapshot.wide.integrationMs != null ? ` · ${snapshot.wide.integrationMs} ms integration` : ""}</p>
  {/if}
  {#if wideUpdatedAt}<p class="hint">Frame age: {Number.isFinite(wideFrameAge) ? `${(wideFrameAge / 1000).toFixed(1)}s` : "unknown"}{wideFrameAge > 2000 ? " · stale" : ""}</p>{/if}
  {#if !wideBusy && snapshot?.wide?.ready && snapshot.wide.rawDistanceMm?.length === wideResolution && snapshot.wide.targetStatus?.length === wideResolution}
    <div class="grid-wrap">
      <div class="grid" style:grid-template-columns={`repeat(${gridSide}, 1fr)`}
        style:grid-template-rows={`repeat(${gridSide}, 1fr)`} aria-label={`Raw ${gridSide} by ${gridSide} distance map`}>
        {#each wideCells as cell}
          <div class="zone" class:invalid={!cell.valid} style:background-color={cell.color} title={cell.title}></div>
        {/each}
      </div>
      {#if frontScan?.zones?.length === 5}
        <div class="roi-overlay" aria-hidden="true">
          {#each frontScan.zones.slice(1) as zone}
            <div class="roi-cell" title={`${scanZoneLabels[zone.id] ?? zone.id}: ${scanValue(zone)}`}>
              <span>{scanZoneShort[zone.id] ?? "?"}</span>
              <strong>{overlayValue(zone)}</strong>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <div class="distance-legend" aria-label="SR Front distance colors">
      {#each distanceBands as band}
        <span><i style:background-color={band.color}></i>{band.label}</span>
      {/each}
      <span><i class="invalid-swatch"></i>Invalid or stale</span>
    </div>
    <p class="hint">Colored squares are the SR Front sensor. White outlines and UL/UR/LL/LR labels are the separate LR Front quadrant scan, approximately placed—not pixel-aligned. * = stale confirmed LR value; ? = unconfirmed; ! = invalid raw target.</p>
    {#if snapshot.wide.profile === "inspect"}<p class="hint">Hover a square for target status, signal, ambient level, and target count.</p>{/if}
  {:else}
    <p class="hint">Waiting for a fresh {gridSide}×{gridSide} frame.</p>
  {/if}

  <h3>IMU <small>(chip axes)</small></h3>
  {#if imuUpdatedAt}<p class="hint">{ageLabel(imuUpdatedAt, now)}</p>{/if}
  <h3>Orientation <small>(relative to boot pose)</small></h3>
  {#if snapshot?.imu?.orientationReady === false}
    <p class="hint">Calibrating while stationary: {snapshot.imu.calibrationSamples ?? 0}/{snapshot.imu.calibrationTarget ?? 80} samples</p>
  {:else if snapshot?.imu?.orientationReady !== true}
    <p class="hint">Orientation tracking requires updated firmware.</p>
  {/if}
  <div class="readout"><span>Roll (upright +)</span><strong>{angle(snapshot?.imu?.orientationDeg, 0, -1)}</strong></div>
  <div class="readout"><span>Pitch</span><strong>{angle(snapshot?.imu?.orientationDeg, 1)}</strong></div>
  <div class="readout"><span>Yaw</span><strong>{angle(snapshot?.imu?.orientationDeg, 2)}</strong></div>
  <p class="hint">Roll sign follows the tested upright direction in Helm; raw chip-axis data is unchanged. Yaw can drift without a compass.</p>

  <h3>Motion rate <small>(chip axes)</small></h3>
  <div class="readout"><span>Accel X</span><strong>{axis(snapshot?.imu?.accelG, 0, "g")}</strong></div>
  <div class="readout"><span>Accel Y</span><strong>{axis(snapshot?.imu?.accelG, 1, "g")}</strong></div>
  <div class="readout"><span>Accel Z</span><strong>{axis(snapshot?.imu?.accelG, 2, "g")}</strong></div>
  <div class="readout"><span>Gyro X</span><strong>{axis(snapshot?.imu?.gyroDps, 0, "°/s")}</strong></div>
  <div class="readout"><span>Gyro Y</span><strong>{axis(snapshot?.imu?.gyroDps, 1, "°/s")}</strong></div>
  <div class="readout"><span>Gyro Z</span><strong>{axis(snapshot?.imu?.gyroDps, 2, "°/s")}</strong></div>

  <h3>Board</h3>
  <div class="readout"><span>Wi‑Fi signal{ageLabel(signalUpdatedAt, now)}</span><strong>{snapshot?.rssi == null ? "—" : `${snapshot.rssi} dBm`}</strong></div>
  <div class="readout"><span>IMU temperature</span><strong>{snapshot?.imu?.temperatureC == null ? "—" : `${snapshot.imu.temperatureC.toFixed(1)} °C / ${(snapshot.imu.temperatureC * 9 / 5 + 32).toFixed(1)} °F`}</strong></div>
  <p class="hint">IMU die temperature is not room temperature.</p>
</section>

<style>
  .sensor-panel { padding: 1rem; color: var(--text); }
  h2 { font-size: 1rem; margin: 0 0 0.25rem; }
  h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; margin: 1.25rem 0 0.55rem; color: var(--muted); }
  small { font-size: 0.7rem; text-transform: none; letter-spacing: normal; }
  .status, .hint { color: var(--muted); font-size: 0.75rem; line-height: 1.4; margin: 0.35rem 0; }
  .readout { display: flex; justify-content: space-between; gap: 0.5rem; padding: 0.35rem 0; border-bottom: 1px solid var(--border); font-size: 0.82rem; }
  .readout strong { font-variant-numeric: tabular-nums; font-weight: 600; }
  .scan-list { margin: 0.15rem 0 0.65rem 0.65rem; border-left: 2px solid var(--border); padding-left: 0.6rem; }
  .scan-row { display: grid; grid-template-columns: 1fr auto; gap: 0.1rem 0.5rem; padding: 0.25rem 0; font-size: 0.75rem; }
  .scan-row strong { font-variant-numeric: tabular-nums; text-align: right; }
  .scan-row small { grid-column: 1 / -1; color: var(--muted); }
  .grid-wrap { position: relative; width: min(100%, 256px); aspect-ratio: 1; }
  .grid { display: grid; gap: 2px; width: 100%; height: 100%; }
  .wide-controls { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.4rem 0; }
  .wide-controls label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.75rem; color: var(--muted); }
  .wide-controls label:first-child { min-width: 0; max-width: 100%; }
  .wide-controls select { background: var(--surface-2, #20272e); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.3rem; }
  .hint.error { color: #ff9c9c; }
  .zone { border-radius: 2px; }
  .zone.invalid { opacity: 0.5; }
  .distance-legend { display: flex; flex-wrap: wrap; gap: 0.3rem 0.65rem; margin: 0.45rem 0; font-size: 0.68rem; color: var(--muted); }
  .distance-legend span { display: inline-flex; align-items: center; gap: 0.25rem; white-space: nowrap; }
  .distance-legend i { width: 0.65rem; height: 0.65rem; border-radius: 2px; flex: none; }
  .distance-legend .invalid-swatch { background: var(--surface-2, #20272e); border: 1px solid var(--border); }
  .roi-overlay { position: absolute; left: 28.5%; top: 28.5%; width: 43%; height: 43%; display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(2, 1fr); border: 1px solid #f2f7ff; background: transparent; pointer-events: none; }
  .roi-cell { position: relative; border: 1px dashed #f2f7ff; background: transparent; color: white; font-size: 0.58rem; font-weight: 700; text-shadow: -1px -1px 2px #000, 1px 1px 2px #000, 0 0 3px #000; }
  .roi-cell span { position: absolute; top: 2px; left: 3px; }
  .roi-cell strong { position: absolute; bottom: 2px; right: 3px; font-size: 0.6rem; white-space: nowrap; }
</style>
