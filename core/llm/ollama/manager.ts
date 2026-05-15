import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { OllamaStatus } from "../../../shared/llm.js";
import { paths } from "../../paths.js";
import * as bmoc from "../../bmoc/index.js";
import { HELM_OLLAMA_PORT, buildOllamaEnv } from "./env.js";
import {
  killStaleHelmOllama,
  portIsClaimableByHelm,
} from "./process-utils.js";

/**
 * Manager for Helm's private Ollama instance.
 *
 * Lifecycle: install (download binary) → start (spawn under BMOC) →
 * chat/use → stop (BMOC closes the session, releases the port).
 *
 * Architectural rules:
 *   1. Helm never talks to the system Ollama on 11434. Period.
 *   2. The Ollama process is registered with BMOC; nothing here calls
 *      `child_process.spawn` and walks away.
 *   3. Before spawning, we check the port is free OR held by a stale Helm
 *      process we can clean up. If a foreign process holds the port, we
 *      refuse to start.
 */

interface RunningRef {
  child: ChildProcess;
  sessionId: string;
  pid: number;
  port: number;
}

let running: RunningRef | null = null;

function measureDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += measureDir(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

export function isInstalled(): boolean {
  return existsSync(paths.ollamaBin());
}

export function isRunning(): boolean {
  return running !== null && running.child.exitCode === null;
}

/**
 * Spawn the private Ollama instance.
 *
 * Throws if the binary isn't installed, if a foreign process holds the port,
 * or if the daemon doesn't become reachable within the timeout.
 */
export async function start(opts: {
  forceCpu?: boolean;
  cudaDeviceUuid?: string;
  readyTimeoutMs?: number;
} = {}): Promise<RunningRef> {
  if (running !== null && running.child.exitCode === null) {
    return running;
  }
  if (!isInstalled()) {
    throw new Error(
      `Ollama binary not installed at ${paths.ollamaBin()}. Run 'helm ollama-install' first.`
    );
  }

  // Defensive: clean up any stale Helm Ollama processes from a prior crash.
  await killStaleHelmOllama(HELM_OLLAMA_PORT);

  const claim = await portIsClaimableByHelm(HELM_OLLAMA_PORT);
  if (!claim.claimable) {
    throw new Error(
      `Cannot start Helm Ollama: ${claim.reason}. Helm only manages its own Ollama on port ${HELM_OLLAMA_PORT}; it will not touch any other process.`
    );
  }

  const env = buildOllamaEnv(opts);
  const child = spawn(paths.ollamaBin(), ["serve"], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  if (!child.pid) {
    throw new Error("Failed to spawn Ollama: no PID returned.");
  }

  const sessionId = bmoc.registerSession({
    type: "ollama",
    pid: child.pid,
    port: HELM_OLLAMA_PORT,
  });

  const ref: RunningRef = {
    child,
    sessionId,
    pid: child.pid,
    port: HELM_OLLAMA_PORT,
  };
  running = ref;

  // Surface stderr to Helm's stderr (not stdout) so NDJSON output stays clean.
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[ollama] ${chunk}`);
  });
  child.on("exit", (code) => {
    if (running?.pid === ref.pid) running = null;
    if (code !== null && code !== 0) {
      process.stderr.write(`[ollama] exited with code ${code}\n`);
    }
  });

  await waitUntilReachable(HELM_OLLAMA_PORT, opts.readyTimeoutMs ?? 30000);
  return ref;
}

async function waitUntilReachable(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/tags`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 200) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Ollama did not become reachable on port ${port} within ${timeoutMs} ms.`
  );
}

export async function stop(): Promise<boolean> {
  if (running === null) {
    // Defense in depth: nothing in-memory, but check for orphans on disk too.
    const killed = await killStaleHelmOllama(HELM_OLLAMA_PORT);
    return killed > 0;
  }
  const sessionId = running.sessionId;
  await bmoc.closeSession(sessionId);
  running = null;
  return true;
}

export async function status(): Promise<OllamaStatus> {
  const installed = isInstalled();
  const live = isRunning();
  return {
    installed,
    running: live,
    port: HELM_OLLAMA_PORT,
    pid: live && running ? running.pid : null,
    binaryPath: paths.ollamaBin(),
    modelsPath: paths.ollamaModels(),
    env: {
      OLLAMA_HOST: `127.0.0.1:${HELM_OLLAMA_PORT}`,
      OLLAMA_MODELS: paths.ollamaModels(),
      OLLAMA_ORIGINS: "*",
    },
    bytesUsed: measureDir(paths.ollamaRoot()),
  };
}
