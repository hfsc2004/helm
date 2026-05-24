// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { paths } from "../../paths.js";

const execAsync = promisify(exec);

/**
 * Find PIDs listening on a given port.
 *
 * Uses lsof on Linux/macOS. On Windows we'd use netstat or PowerShell; that
 * variant lands when we add Windows support to this branch's successor.
 */
export async function findPidsOnPort(port: number): Promise<number[]> {
  try {
    const { stdout } = await execAsync(`lsof -ti:${port}`);
    return stdout
      .trim()
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Read the full command line of a running process.
 *
 * The whole isolation story rests on this: we kill processes whose command
 * line includes *Helm's* ollama binary path, never processes whose command
 * line points elsewhere (e.g., a system Ollama on 11434).
 */
async function readCommandLine(pid: number): Promise<string> {
  try {
    const { stdout } = await execAsync(`ps -p ${pid} -o command=`);
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Kill any stale Helm-owned Ollama instances on the private port.
 *
 * Safe across reboots: identifies "ours" by whether the process's command
 * line includes Helm's binary path. Will NOT touch:
 *   - a system Ollama daemon on port 11434
 *   - a Core-CE Ollama instance (different binary path)
 *   - anything not running from <dataDir>/ollama/bin/
 *
 * Called at startup (before we spawn fresh) and on shutdown (defense in depth).
 */
export async function killStaleHelmOllama(port: number): Promise<number> {
  const helmBinaryDir = paths.ollamaRoot();
  const pids = await findPidsOnPort(port);
  let killed = 0;

  for (const pid of pids) {
    const cmdline = await readCommandLine(pid);
    if (!cmdline.includes(helmBinaryDir)) continue;
    try {
      process.kill(pid, "SIGTERM");
      killed++;
    } catch {
      // Already gone; that's fine.
    }
  }
  return killed;
}

/**
 * Best-effort: confirm a system Ollama isn't already on Helm's chosen port.
 * Returns true if the port is free or holds one of our own processes (which
 * killStaleHelmOllama will clean up).
 */
export async function portIsClaimableByHelm(port: number): Promise<{
  claimable: boolean;
  reason: string;
}> {
  const pids = await findPidsOnPort(port);
  if (pids.length === 0) return { claimable: true, reason: "free" };

  for (const pid of pids) {
    const cmdline = await readCommandLine(pid);
    if (!cmdline.includes(paths.ollamaRoot())) {
      return {
        claimable: false,
        reason: `port ${port} held by foreign process (pid ${pid}): ${cmdline.slice(0, 80)}`,
      };
    }
  }
  return { claimable: true, reason: "held by stale Helm process; will clean up" };
}
