<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import { onMount } from "svelte";
  import type { SensorBoardSnapshotResponse } from "@shared/ipc-channels";

  export let vehicleId: string;

  let snapshot: SensorBoardSnapshotResponse | null = null;
  let updatedAt = 0;
  let imuUpdatedAt = 0;
  let signalUpdatedAt = 0;
  let wideUpdatedAt = 0;
  let now = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;

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
    return "No valid return";
  };
  const axis = (values: number[] | undefined, index: number, unit: string) =>
    values?.[index] == null ? "—" : `${values[index].toFixed(2)} ${unit}`;
  const ageLabel = (sampledAt: number, currentTime: number) =>
    sampledAt && currentTime - sampledAt > 5000 ? ` · last sample ${Math.round((currentTime - sampledAt) / 1000)}s ago` : "";
  const zoneValid = (index: number) =>
    snapshot?.wide?.targetStatus?.[index] === 5 || snapshot?.wide?.targetStatus?.[index] === 9;
  const zoneColor = (index: number) => {
    if (!zoneValid(index)) return "var(--surface-2, #20272e)";
    const distance = snapshot?.wide?.rawDistanceMm?.[index] ?? 0;
    const hue = Math.min(210, Math.max(12, (distance / 2500) * 210));
    return `hsl(${hue} 65% 38%)`;
  };

  onMount(() => {
    active = true;
    const poll = async () => {
      try {
        const next = await window.helm.vehicle.sensorBoardSnapshot({ vehicleId });
        now = Date.now();
        if (next.ranges || next.imu || next.wide) updatedAt = now;
        if (next.imu) imuUpdatedAt = now;
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
  <div class="readout"><span>Front ToF</span><strong>{rangeText(snapshot?.ranges ?? null, "front")}</strong></div>
  <div class="readout"><span>Rear ToF</span><strong>{rangeText(snapshot?.ranges ?? null, "rear")}</strong></div>
  <p class="hint">A missing return does not mean the path is clear.</p>

  <h3>Wide 8×8 ToF</h3>
  {#if wideUpdatedAt}<p class="hint">{ageLabel(wideUpdatedAt, now)}</p>{/if}
  {#if snapshot?.wide?.ready && snapshot.wide.rawDistanceMm?.length === 64}
    <div class="grid" aria-label="Raw 8 by 8 distance map">
      {#each snapshot.wide.rawDistanceMm as distance, index}
        <div class="zone" class:invalid={!zoneValid(index)} style:background-color={zoneColor(index)} title={`Zone ${index}: ${zoneValid(index) ? formatDistance(distance) : "no valid return"}`}></div>
      {/each}
    </div>
    <p class="hint">Raw sensor order · warm = near · cool = far · dim = no valid return</p>
  {:else}
    <p class="hint">No 8×8 frame available.</p>
  {/if}

  <h3>IMU <small>(chip axes)</small></h3>
  {#if imuUpdatedAt}<p class="hint">{ageLabel(imuUpdatedAt, now)}</p>{/if}
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
  .grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; width: min(100%, 256px); aspect-ratio: 1; }
  .zone { border-radius: 2px; }
  .zone.invalid { opacity: 0.5; }
</style>
