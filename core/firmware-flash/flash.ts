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
}

export type ProgressCallback = (event: FlashEvent) => void;

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
  onProgress: ProgressCallback
): Promise<{ ok: boolean; sketchPath?: string; reason?: string }> {
  const startedAt = Date.now();

  onProgress({ stage: "prepare", message: `loading template ${req.templateId}` });
  const tmpl = loadTemplate(req.templateId);
  if (!tmpl) {
    onProgress({ stage: "error", message: `template not found: ${req.templateId}` });
    return { ok: false, reason: "template not found" };
  }

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
      fqbn: tmpl.manifest.fqbn,
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
  onProgress({ stage: "compile", message: `arduino-cli compile (${tmpl.manifest.fqbn})` });
  const compileSession = bmoc.registerSession({
    type: "arduino-compile",
    pid: undefined,
    sketchPath,
    fqbn: tmpl.manifest.fqbn,
  });
  const compile = await runCommandAsync(
    cli.bin,
    [...cli.baseArgs, "compile", "--fqbn", tmpl.manifest.fqbn, sketchDir],
    {
      env: cli.env,
      timeoutMs: 600000,
      onStdout: (c) => onProgress({ stage: "compile", message: "stdout", chunk: c }),
      onStderr: (c) => onProgress({ stage: "compile", message: "stderr", chunk: c }),
    }
  );
  try {
    await bmoc.closeSession(compileSession);
  } catch {
    // session may already be torn down; that's fine
  }
  if (compile.error || compile.status !== 0) {
    const reason = compile.error ?? compile.stderr.slice(0, 400) ?? "compile failed";
    onProgress({ stage: "error", message: "compile failed", reason });
    return { ok: false, reason };
  }

  // Upload.
  onProgress({ stage: "upload", message: `arduino-cli upload to ${req.port}` });
  const uploadSession = bmoc.registerSession({
    type: "arduino-upload",
    pid: undefined,
    sketchPath,
    fqbn: tmpl.manifest.fqbn,
    serialPort: req.port,
  });
  const upload = await runCommandAsync(
    cli.bin,
    [
      ...cli.baseArgs,
      "upload",
      "--fqbn",
      tmpl.manifest.fqbn,
      "--port",
      req.port,
      sketchDir,
    ],
    {
      env: cli.env,
      timeoutMs: 300000,
      onStdout: (c) => onProgress({ stage: "upload", message: "stdout", chunk: c }),
      onStderr: (c) => onProgress({ stage: "upload", message: "stderr", chunk: c }),
    }
  );
  try {
    await bmoc.closeSession(uploadSession);
  } catch {
    // ditto
  }
  if (upload.error || upload.status !== 0) {
    const reason = upload.error ?? upload.stderr.slice(0, 400) ?? "upload failed";
    onProgress({ stage: "error", message: "upload failed", reason });
    return { ok: false, reason };
  }

  onProgress({
    stage: "complete",
    message: "flashed",
    ok: true,
    fqbn: tmpl.manifest.fqbn,
    port: req.port,
    sketchPath,
    durationMs: Date.now() - startedAt,
  });
  return { ok: true, sketchPath };
}
