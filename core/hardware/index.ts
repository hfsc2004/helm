// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
/**
 * Hardware detection — verbatim import from PSF Core.
 *
 * The underlying .js files are kept exactly as written and proven there.
 * This file is the thin TypeScript surface the rest of Helm uses.
 *
 * If you find a bug in the detector, fix it in the .js file directly. Do not
 * "modernize" the implementation; it works.
 */

// Verbatim CommonJS modules from PSF Core.
const detector = require("./gpu-detector.js") as {
  detectAll(appDir: string): Promise<HardwareInfo>;
  classifyForInference(hardware: HardwareInfo): GpuClassification;
};

const createStartupGpuTools = require("./gpu-select.js") as (deps: {
  execFileSync: typeof import("node:child_process").execFileSync;
}) => {
  resolvePreferredNvidiaGpuIndex(
    gpuInfo: GpuClassification,
    overrideValue?: string | number
  ): number | null;
  resolvePreferredNvidiaGpuUuid(
    gpuInfo: GpuClassification,
    overrideValue?: string
  ): string;
};

export interface GpuEntry {
  name: string;
  vram: number;
  uuid?: string;
  index?: number;
  type?: string;
  source?: string;
}

export interface HardwareInfo {
  gpu_list: GpuEntry[];
  cpu?: { name?: string; cores?: number };
  ram_gb?: number;
  [key: string]: unknown;
}

export interface GpuClassification {
  accelerationType: "cpu" | "nvidia" | "apple-silicon" | "mali" | "videocore" | "npu" | string;
  cudaDeviceIndex: string | number | null;
  displayText: string;
  detected: boolean;
  name?: string;
  vram?: number;
  uuid?: string;
  index?: number;
}

/**
 * The verbatim .js modules emit `[GPU Detector]` and `[GPU Classifier]` lines
 * via `console.log`. Those land on stdout, which would corrupt the agent-facing
 * NDJSON stream from the CLI. Redirect them to stderr for the duration of the
 * call. Nothing is silenced — the diagnostic logs are still available for the
 * user / agent reading stderr.
 */
async function withStdoutToStderr<T>(fn: () => T | Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    process.stderr.write(args.map((a) => String(a)).join(" ") + "\n");
  };
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

export async function detectHardware(appDir: string): Promise<HardwareInfo> {
  return withStdoutToStderr(() => detector.detectAll(appDir));
}

export function classifyForInference(hardware: HardwareInfo): GpuClassification {
  // Synchronous; redirect by direct swap.
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    process.stderr.write(args.map((a) => String(a)).join(" ") + "\n");
  };
  try {
    return detector.classifyForInference(hardware);
  } finally {
    console.log = originalLog;
  }
}

/**
 * Pick the right NVIDIA GPU when multiple are present.
 * Headless beats display-active; more VRAM wins ties.
 */
export function selectNvidiaGpu(
  classification: GpuClassification,
  override?: { index?: number; uuid?: string }
): { index: number | null; uuid: string } {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const tools = createStartupGpuTools({ execFileSync });
  return {
    index: tools.resolvePreferredNvidiaGpuIndex(classification, override?.index),
    uuid: tools.resolvePreferredNvidiaGpuUuid(classification, override?.uuid),
  };
}
