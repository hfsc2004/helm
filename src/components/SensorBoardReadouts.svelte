<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import { onMount } from "svelte";
  import type { SensorBoardScanZone, SensorBoardSnapshotResponse } from "@shared/ipc-channels";

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
  $: frontScan = snapshot?.ranges?.singleZone?.find((item) => item.name === "front")?.scan;

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
  const zoneValid = (index: number) =>
    (snapshot?.wide?.targetStatus?.[index] === 5 || snapshot?.wide?.targetStatus?.[index] === 9) &&
    (effectiveAge(snapshot?.wide?.ageMs, wideUpdatedAt) ?? Infinity) <= 2000;
  const distanceBands = [
    { maxMm: 250, label: "≤25 cm", color: "#e5484d" },
    { maxMm: 500, label: "25–50 cm", color: "#f58135" },
    { maxMm: 750, label: "50–75 cm", color: "#f5cc37" },
    { maxMm: 1000, label: "75 cm–1 m", color: "#94d82d" },
    { maxMm: 1500, label: "1–1.5 m", color: "#28c7bc" },
    { maxMm: 2500, label: "1.5–2.5 m", color: "#4d8cf5" },
    { maxMm: Infinity, label: ">2.5 m", color: "#ae7bf4" },
  ];
  const zoneColor = (index: number) => {
    if (!zoneValid(index)) return "var(--surface-2, #20272e)";
    const distance = snapshot?.wide?.rawDistanceMm?.[index] ?? 0;
    return distanceBands.find((band) => distance <= band.maxMm)?.color ?? distanceBands[distanceBands.length - 1].color;
  };

  onMount(() => {
    active = true;
    const poll = async () => {
      try {
        const next = await window.helm.vehicle.sensorBoardSnapshot({ vehicleId });
        now = Date.now();
        if (next.ranges || next.imu || next.wide) updatedAt = now;
        if (next.imu) imuUpdatedAt = now;
        if (next.ranges) rangesUpdatedAt = now;
        if (next.wide) wideUpdatedAt = now;
        if (next.rssi != null) signalUpdatedAt = now;
        snapshot = {
          ranges: next.ranges ?? snapshot?.ranges ?? null,
          imu: next.imu ?? snapshot?.imu ?? null,
          wide: next.wide ?? snapshot?.wide ?? null,
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
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
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

  <h3>Distance</h3>
  {#each ["front", "rear"] as name}
    {@const sensor = snapshot?.ranges?.singleZone?.find((item) => item.name === name)}
    <div class="readout"><span>{name === "front" ? "Front" : "Rear"} ToF</span><strong>{rangeText(snapshot?.ranges ?? null, name)}</strong></div>
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

  <h3>Wide 8×8 ToF</h3>
  {#if wideUpdatedAt}<p class="hint">Frame age: {effectiveAge(snapshot?.wide?.ageMs, wideUpdatedAt) == null ? "unknown" : `${((effectiveAge(snapshot?.wide?.ageMs, wideUpdatedAt) ?? 0) / 1000).toFixed(1)}s`}{(effectiveAge(snapshot?.wide?.ageMs, wideUpdatedAt) ?? Infinity) > 2000 ? " · stale" : ""}</p>{/if}
  {#if snapshot?.wide?.ready && snapshot.wide.rawDistanceMm?.length === 64}
    <div class="grid-wrap">
      <div class="grid" aria-label="Raw 8 by 8 distance map">
        {#each snapshot.wide.rawDistanceMm as distance, index}
          <div class="zone" class:invalid={!zoneValid(index)} style:background-color={zoneColor(index)} title={`Zone ${index}: ${zoneValid(index) ? formatDistance(distance) : "no fresh valid return"}`}></div>
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
    <div class="distance-legend" aria-label="8 by 8 distance colors">
      {#each distanceBands as band}
        <span><i style:background-color={band.color}></i>{band.label}</span>
      {/each}
      <span><i class="invalid-swatch"></i>Invalid or stale</span>
    </div>
    <p class="hint">Colored squares are the 8×8 sensor. White transparent outlines and UL/UR/LL/LR labels are the separate CB quadrant scan, approximately placed—not pixel-aligned. * = stale confirmed CB value; ? = unconfirmed CB value; ! = raw CB target with invalid status, not a reliable distance.</p>
  {:else}
    <p class="hint">No 8×8 frame available.</p>
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
  .grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; width: 100%; height: 100%; }
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
