// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Generic subprocess runner used by toolchain helpers.
 *
 * Intentionally narrow: spawn, capture stdout/stderr, optional per-chunk
 * callbacks for streaming progress, optional timeout, optional env override.
 *
 * Always resolves (never throws) — caller checks `error` and `status`.
 */
export interface RunOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Called once with the spawned child so callers can kill it (cancellation). */
  onProcess?: (child: ChildProcess) => void;
}

export interface RunResult {
  bin: string;
  args: string[];
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  timedOut?: boolean;
}

export function runCommandAsync(
  bin: string,
  args: string[] = [],
  options: RunOptions = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      options.onProcess?.(child);
    } catch (err) {
      resolve({
        bin,
        args,
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGKILL");
            } catch {
              // already gone
            }
          }, options.timeoutMs)
        : null;

    child.stdout?.on("data", (chunk) => {
      const s = chunk.toString();
      stdout += s;
      options.onStdout?.(s);
    });
    child.stderr?.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      options.onStderr?.(s);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        bin,
        args,
        status: null,
        signal: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        error: err.message,
        timedOut,
      });
    });

    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        bin,
        args,
        status: code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        ...(timedOut ? { timedOut: true, error: "timeout" } : {}),
      });
    });
  });
}
