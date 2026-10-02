// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import type { SensorBoardWideRange } from "@shared/ipc-channels";

export const wideDistanceBands = [
  { maxMm: 250, label: "≤25 cm", color: "#e5484d" },
  { maxMm: 500, label: "25–50 cm", color: "#f58135" },
  { maxMm: 750, label: "50–75 cm", color: "#f5cc37" },
  { maxMm: 1000, label: "75 cm–1 m", color: "#94d82d" },
  { maxMm: 1500, label: "1–1.5 m", color: "#28c7bc" },
  { maxMm: 2500, label: "1.5–2.5 m", color: "#4d8cf5" },
  { maxMm: Infinity, label: ">2.5 m", color: "#ae7bf4" },
];

// All changing inputs are explicit. Svelte can otherwise untrack helper calls
// used in attributes, leaving colors unchanged when the indexed cell survives.
export function wideTofCells(wide: SensorBoardWideRange | null, ageMs: number) {
  const resolution = wide?.resolution ?? wide?.rawDistanceMm?.length;
  if (!wide?.ready || (resolution !== 16 && resolution !== 64) ||
      wide.rawDistanceMm?.length !== resolution || wide.targetStatus?.length !== resolution) return [];
  const side = resolution === 16 ? 4 : 8;
  return wide.rawDistanceMm.map((distance, index) => {
    const status = wide.targetStatus![index];
    const valid = (status === 5 || status === 9) && ageMs <= 2000;
    const color = valid ? wideDistanceBands.find((band) => distance <= band.maxMm)!.color :
      "var(--surface-2, #20272e)";
    let title = `Row ${Math.floor(index / side) + 1}, column ${index % side + 1}: ` +
      (valid ? `${distance} mm (${(distance / 1000).toFixed(2)} m)` : "no fresh valid return");
    if (wide.profile === "inspect") {
      title += `\nStatus: ${status}`;
      title += `\nSignal: ${wide.signalKcpsPerSpad?.[index] ?? "unknown"} kcps/SPAD`;
      title += `\nAmbient: ${wide.ambientKcpsPerSpad?.[index] ?? "unknown"} kcps/SPAD`;
      title += `\nTargets: ${wide.targetCount?.[index] ?? "unknown"}`;
    }
    return { distance, valid, color, title };
  });
}
