import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as bmoc from "../bmoc/index.js";
import { paths } from "../paths.js";
import { runCommandAsync } from "../toolchains/process.js";
import { resolveArduinoCli } from "../toolchains/arduino-cli/index.js";
import { loadTemplate } from "./templates.js";
import { renderSketch } from "./render.js";

/**
 * Flash a microcontroller using arduino-cli.
 *
 * Flow:
 *   1. Load + render the sketch template with the user's vars.
 *   2. Resolve arduino-cli (managed or system).
 *   3. Ensure the relevant board core is installed (one-time, slow).
 *   4. Compile the sketch.
 *   5. Upload to the resolved port.
 *
 * Every subprocess is registered with BMOC so a window-close or app-quit
 * mid-flash cleans up cleanly.
 */

export type FlashStage =
  | "prepare"
  | "render"
  | "resolve-toolchain"
  | "core-install"
  | "compile"
  | "upload"
  | "complete"
  | "error";

export interface FlashEvent {
  stage: FlashStage;
  message: string;
  /** Stream chunks from arduino-cli (stage = compile or upload). */
  chunk?: string;
  /** Final result fields, present only on stage = complete. */
  ok?: boolean;
  fqbn?: string;
  port?: string;
  sketchPath?: string;
  durationMs?: number;
  /** Failure details on stage = error. */
  reason?: string;
}

export interface FlashRequest {
  templateId: string;
  port: string;
  vars: Record<string, unknown>;
  /** If true, render + write the sketch but do not compile or upload. */
  dryRun?: boolean;
  /**
   * Optional board override — chooses which side of a dual-board vehicle this
   * flash targets. Used only to label progress events; the template id is
   * still the source of truth for what gets compiled.
   */
  board?: "drive" | "video";
  /** Override the template's FQBN (rare; use when one board has a variant). */
  fqbnOverride?: string;
  /** Extra --build-property KEY=VALUE pairs for compile (USB-CDC, partitions, …). */
  buildProperties?: string[];
  /** Pass --erase-flash to arduino-cli upload before writing the new image. */
  eraseBeforeUpload?: boolean;
  /** After a successful upload, hold the port open and stream serial for N ms
   *  so the user can see first-boot output (typical for ESP32-S3 cam boards). */
  captureRuntimeSerialMs?: number;
  /** Baud rate used for the post-upload serial capture. Defaults to 115200. */
  monitorBaudRate?: number;
}

export type ProgressCallback = (event: FlashEvent) => void;

/**
 * Returned to callers so they can cancel an in-flight flash. Idempotent;
 * calling cancel() after the flash finishes is a no-op. Killing mid-compile
 * or mid-upload sends SIGKILL to the active arduino-cli subprocess, which
 * resolves runCommandAsync with status=null + signal — the existing
 * error-path code turns that into a clean `error` event.
 */
export interface FlashController {
  cancel(): void;
}

function jobId(): string {
  return `flash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function stagingDir(id: string): string {
  return join(paths.data, "flash-staging", id);
}

async function ensureCore(
  bin: string,
  baseArgs: string[],
  env: NodeJS.ProcessEnv,
  core: string,
  onProgress: ProgressCallback
): Promise<{ ok: boolean; reason?: string }> {
  // Check if installed.
  const check = await runCommandAsync(
    bin,
    [...baseArgs, "core", "list", "--format", "json"],
    { env, timeoutMs: 30000 }
  );
  if (check.error || check.status !== 0) {
    return { ok: false, reason: `arduino-cli core list failed: ${check.stderr.slice(0, 200)}` };
  }
  try {
    const parsed = JSON.parse(check.stdout) as {
      platforms?: Array<{ id?: string; installed_version?: string }>;
    };
    const cores = parsed.platforms ?? [];
    if (cores.some((c) => c.id === core && c.installed_version)) {
      return { ok: true };
    }
  } catch {
    // Older arduino-cli versions returned a different shape; fall through to install.
  }

  onProgress({
    stage: "core-install",
    message: `installing ${core} core (one-time, may take several minutes)`,
  });

  // index update + core install
  const update = await runCommandAsync(
    bin,
    [...baseArgs, "core", "update-index"],
    {
      env,
      timeoutMs: 120000,
      onStderr: (c) => onProgress({ stage: "core-install", message: "index", chunk: c }),
    }
  );
  if (update.error || update.status !== 0) {
    return { ok: false, reason: `core update-index failed: ${update.stderr.slice(0, 200)}` };
  }

  const install = await runCommandAsync(
    bin,
    [...baseArgs, "core", "install", core],
    {
      env,
      timeoutMs: 900000, // 15 minutes; the ESP32 core is large
      onStdout: (c) => onProgress({ stage: "core-install", message: "downloading", chunk: c }),
      onStderr: (c) => onProgress({ stage: "core-install", message: "downloading", chunk: c }),
    }
  );
  if (install.error || install.status !== 0) {
    return { ok: false, reason: `core install ${core} failed: ${install.stderr.slice(0, 200)}` };
  }
  return { ok: true };
}

export async function flash(
  req: FlashRequest,
  onProgress: ProgressCallback,
  /** Optional. If provided, .cancel() will be wired to kill any active
   *  arduino-cli subprocess (compile or upload). */
  controller?: FlashController
): Promise<{ ok: boolean; sketchPath?: string; reason?: string }> {
  const startedAt = Date.now();

  // Track the active subprocess so cancellation can kill it. Only one runs
  // at a time (compile, then upload), so a single slot is enough.
  let active: { kill: () => void } | null = null;
  let cancelled = false;
  if (controller) {
    controller.cancel = () => {
      cancelled = true;
      const target = active;
      if (target) {
        try {
          target.kill();
        } catch {
          // already dead
        }
      }
    };
  }

  const boardLabel = req.board ? ` [${req.board} board]` : "";
  onProgress({
    stage: "prepare",
    message: `loading template ${req.templateId}${boardLabel}`,
  });
  const tmpl = loadTemplate(req.templateId);
  if (!tmpl) {
    onProgress({ stage: "error", message: `template not found: ${req.templateId}` });
    return { ok: false, reason: "template not found" };
  }
  const fqbn = req.fqbnOverride && req.fqbnOverride.trim()
    ? req.fqbnOverride.trim()
    : tmpl.manifest.fqbn;

  onProgress({ stage: "render", message: "applying template variables" });
  const rendered = renderSketch(tmpl, req.vars);
  if (!rendered.ok) {
    onProgress({ stage: "error", message: rendered.errors.join("; ") });
    return { ok: false, reason: rendered.errors.join("; ") };
  }

  const id = jobId();
  const dir = stagingDir(id);
  // arduino-cli requires the sketch dir name to match the .ino filename.
  const sketchDir = join(dir, req.templateId);
  mkdirSync(sketchDir, { recursive: true });
  const sketchPath = join(sketchDir, `${req.templateId}.ino`);
  writeFileSync(sketchPath, rendered.sketch, "utf8");

  if (req.dryRun) {
    onProgress({
      stage: "complete",
      message: "dry-run: sketch written, not flashed",
      ok: true,
      fqbn,
      sketchPath,
      durationMs: Date.now() - startedAt,
    });
    return { ok: true, sketchPath };
  }

  onProgress({ stage: "resolve-toolchain", message: "resolving arduino-cli" });
  const cli = await resolveArduinoCli();
  if (!cli) {
    const reason =
      "arduino-cli not installed. Run: helm toolchain-install --target arduino-cli --confirm";
    onProgress({ stage: "error", message: reason, reason });
    return { ok: false, reason };
  }

  // Make sure the right core is installed.
  const coreResult = await ensureCore(
    cli.bin,
    cli.baseArgs,
    cli.env,
    tmpl.manifest.core,
    onProgress
  );
  if (!coreResult.ok) {
    onProgress({ stage: "error", message: coreResult.reason ?? "core install failed" });
    return { ok: false, reason: coreResult.reason };
  }

  // Compile.
  onProgress({ stage: "compile", message: `arduino-cli compile (${fqbn})` });
  const compileSession = bmoc.registerSession({
    type: "arduino-compile",
    pid: undefined,
    sketchPath,
    fqbn,
  });
  const compileArgs = [...cli.baseArgs, "compile", "--fqbn", fqbn];
  for (const prop of req.buildProperties ?? []) {
    compileArgs.push("--build-property", prop);
  }
  compileArgs.push(sketchDir);
  const compile = await runCommandAsync(
    cli.bin,
    compileArgs,
    {
      env: cli.env,
      timeoutMs: 600000,
      onStdout: (c) => onProgress({ stage: "compile", message: "stdout", chunk: c }),
      onStderr: (c) => onProgress({ stage: "compile", message: "stderr", chunk: c }),
      onProcess: (child) => {
        active = { kill: () => child.kill("SIGKILL") };
      },
    }
  );
  active = null;
  try {
    await bmoc.closeSession(compileSession);
  } catch {
    // session may already be torn down; that's fine
  }
  if (compile.error || compile.status !== 0) {
    const reason = cancelled
      ? "cancelled"
      : compile.error ?? compile.stderr.slice(0, 400) ?? "compile failed";
    onProgress({ stage: "error", message: cancelled ? "cancelled" : "compile failed", reason });
    return { ok: false, reason };
  }

  // Upload.
  onProgress({ stage: "upload", message: `arduino-cli upload to ${req.port}` });
  const uploadSession = bmoc.registerSession({
    type: "arduino-upload",
    pid: undefined,
    sketchPath,
    fqbn,
    serialPort: req.port,
  });
  const uploadArgs = [...cli.baseArgs, "upload", "--fqbn", fqbn, "--port", req.port];
  if (req.eraseBeforeUpload) uploadArgs.push("--erase");
  uploadArgs.push(sketchDir);
  const upload = await runCommandAsync(
    cli.bin,
    uploadArgs,
    {
      env: cli.env,
      timeoutMs: 300000,
      onStdout: (c) => onProgress({ stage: "upload", message: "stdout", chunk: c }),
      onStderr: (c) => onProgress({ stage: "upload", message: "stderr", chunk: c }),
      onProcess: (child) => {
        active = { kill: () => child.kill("SIGKILL") };
      },
    }
  );
  active = null;
  try {
    await bmoc.closeSession(uploadSession);
  } catch {
    // ditto
  }
  if (upload.error || upload.status !== 0) {
    const reason = cancelled
      ? "cancelled"
      : upload.error ?? upload.stderr.slice(0, 400) ?? "upload failed";
    onProgress({ stage: "error", message: cancelled ? "cancelled" : "upload failed", reason });
    return { ok: false, reason };
  }

  // Optional post-upload serial capture (lets the user see the first-boot
  // output — IP acquired, sensor init, etc.). Best-effort: if arduino-cli
  // monitor isn't supported on this version, we just skip.
  const captureMs = req.captureRuntimeSerialMs ?? 0;
  if (captureMs > 0) {
    const baud = req.monitorBaudRate ?? 115200;
    onProgress({
      stage: "upload",
      message: `capturing serial output for ${Math.round(captureMs / 1000)}s @ ${baud}`,
    });
    const monitorArgs = [
      ...cli.baseArgs,
      "monitor",
      "--port",
      req.port,
      "--config",
      `baudrate=${baud}`,
    ];
    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      const target = active;
      if (target) {
        try {
          target.kill();
        } catch {
          // already dead
        }
      }
    }, captureMs);
    try {
      await runCommandAsync(cli.bin, monitorArgs, {
        env: cli.env,
        timeoutMs: captureMs + 5000,
        onStdout: (c) => onProgress({ stage: "upload", message: "serial", chunk: c }),
        onStderr: (c) => onProgress({ stage: "upload", message: "serial-err", chunk: c }),
        onProcess: (child) => {
          active = { kill: () => child.kill("SIGKILL") };
        },
      });
    } finally {
      clearTimeout(killTimer);
      active = null;
      if (!killed) {
        // arduino-cli monitor exited on its own (probably unsupported); fine.
      }
    }
  }

  onProgress({
    stage: "complete",
    message: "flashed",
    ok: true,
    fqbn,
    port: req.port,
    sketchPath,
    durationMs: Date.now() - startedAt,
  });
  return { ok: true, sketchPath };
}
