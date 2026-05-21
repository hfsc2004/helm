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

/**
 * Translate arduino-cli's terse failure modes into one-line user-readable
 * causes. Falls back to a sliced stderr when nothing obvious matches.
 */
function diagnoseCoreFailure(stderr: string, fallbackPrefix: string): string {
  const s = stderr.toLowerCase();
  if (/getaddrinfo|enotfound|econnrefused|network is unreachable|no route to host/.test(s)) {
    return `${fallbackPrefix}: couldn't reach the Arduino index server — check your internet connection`;
  }
  if (/permission denied|eacces|read-?only/.test(s)) {
    return `${fallbackPrefix}: permission denied writing to the arduino-cli data dir`;
  }
  if (/no space left|enospc|disk full/.test(s)) {
    return `${fallbackPrefix}: out of disk space while installing the board core`;
  }
  if (/checksum|verification failed|sha-?256/.test(s)) {
    return `${fallbackPrefix}: download verification failed (partial install) — re-run to retry`;
  }
  return `${fallbackPrefix}: ${stderr.slice(0, 200).trim() || "no stderr output"}`;
}

/**
 * Heuristic: does an arduino-cli compile failure look like "the ESP32 core
 * isn't really installed, even if `core list` showed it"? Triggers an
 * auto-heal reinstall. Strings copied from arduino-cli's own emissions —
 * what we saw on the partial-install case.
 */
function looksLikeMissingPlatform(stderr: string, core: string): boolean {
  const s = stderr.toLowerCase();
  const coreLower = core.toLowerCase();
  return (
    s.includes(`platform ${coreLower} not found`) ||
    s.includes(`${coreLower} not found`) ||
    s.includes("missing platform") ||
    s.includes("platform not installed") ||
    // arduino-cli sometimes emits FQBN-shaped errors instead of core-shaped
    /fqbn .* not found/.test(s) ||
    /unknown fqbn/.test(s)
  );
}

async function ensureCore(
  bin: string,
  baseArgs: string[],
  env: NodeJS.ProcessEnv,
  core: string,
  onProgress: ProgressCallback,
  /** If true, skip the installed-check and force re-install (auto-heal path). */
  forceReinstall = false
): Promise<{ ok: boolean; reason?: string }> {
  if (!forceReinstall) {
    // Check if installed.
    const check = await runCommandAsync(
      bin,
      [...baseArgs, "core", "list", "--format", "json"],
      { env, timeoutMs: 30000 }
    );
    if (check.error || check.status !== 0) {
      return {
        ok: false,
        reason: diagnoseCoreFailure(check.stderr, "arduino-cli core list failed"),
      };
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
  }

  onProgress({
    stage: "core-install",
    message: forceReinstall
      ? `reinstalling ${core} core (auto-heal — last compile reported it missing)`
      : `installing ${core} core (one-time, may take several minutes)`,
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
    return {
      ok: false,
      reason: diagnoseCoreFailure(update.stderr, "core update-index failed"),
    };
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
    return {
      ok: false,
      reason: diagnoseCoreFailure(install.stderr, `core install ${core} failed`),
    };
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
  // If the first compile fails with a "platform not found" style error
  // (rare — usually means a partial install: `core list` saw it but the
  // actual files are gone or corrupted), we run ensureCore() once more
  // with forceReinstall, then retry the compile a single time. Anything
  // beyond that is a real bug and we surface the error to the user.
  const compileArgs = [...cli.baseArgs, "compile", "--fqbn", fqbn];
  for (const prop of req.buildProperties ?? []) {
    compileArgs.push("--build-property", prop);
  }
  compileArgs.push(sketchDir);

  const runCompile = async (attempt: number) => {
    onProgress({
      stage: "compile",
      message:
        attempt === 1
          ? `arduino-cli compile (${fqbn})`
          : `arduino-cli compile retry after auto-heal (${fqbn})`,
    });
    const session = bmoc.registerSession({
      type: "arduino-compile",
      pid: undefined,
      sketchPath,
      fqbn,
    });
    const result = await runCommandAsync(
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
      await bmoc.closeSession(session);
    } catch {
      // session may already be torn down; that's fine
    }
    return result;
  };

  let compile = await runCompile(1);
  if (
    !cancelled &&
    (compile.error || compile.status !== 0) &&
    looksLikeMissingPlatform(compile.stderr, tmpl.manifest.core)
  ) {
    onProgress({
      stage: "core-install",
      message: `[auto-heal] compile reported missing ${tmpl.manifest.core} — reinstalling and retrying`,
    });
    const heal = await ensureCore(
      cli.bin,
      cli.baseArgs,
      cli.env,
      tmpl.manifest.core,
      onProgress,
      true
    );
    if (heal.ok) {
      compile = await runCompile(2);
    } else {
      onProgress({
        stage: "compile",
        message: `[auto-heal failed] ${heal.reason ?? "core reinstall failed"}`,
      });
    }
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
