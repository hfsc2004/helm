import { runCommandAsync } from "../process.js";

/**
 * mpremote toolchain — for Pi Pico / Pico 2 (RP2040 / RP2350) running
 * MicroPython.
 *
 * mpremote is a Python tool, not a single binary. It needs Python 3 + the
 * mpremote package. v0.1 detects the user's existing install (system
 * `mpremote` on PATH, or `python3 -m mpremote`). If neither exists, the
 * caller surfaces a clear "install Python and run pip install mpremote"
 * message. Bundling our own Python venv with mpremote is deferred to a
 * later branch (it's significantly more work than arduino-cli's single
 * binary).
 */

export interface MpremoteCommand {
  bin: string;
  baseArgs: string[];
  source: "system" | "python-module";
  version: string;
}

async function probe(
  bin: string,
  args: string[]
): Promise<string | null> {
  const res = await runCommandAsync(bin, [...args, "version"], {
    timeoutMs: 5000,
  });
  if (res.error || res.status !== 0) return null;
  // mpremote outputs e.g. "mpremote 1.24.1"
  const match = res.stdout.match(/mpremote\s+(\S+)/i);
  return match ? match[1]! : "unknown";
}

export async function resolveMpremote(): Promise<MpremoteCommand | null> {
  // Try system `mpremote` first — most common case.
  const sys = await probe("mpremote", []);
  if (sys) {
    return { bin: "mpremote", baseArgs: [], source: "system", version: sys };
  }

  // Fall back to `python3 -m mpremote` — works if pip-installed but not on PATH.
  for (const py of ["python3", "python"]) {
    const v = await probe(py, ["-m", "mpremote"]);
    if (v) {
      return {
        bin: py,
        baseArgs: ["-m", "mpremote"],
        source: "python-module",
        version: v,
      };
    }
  }

  return null;
}
