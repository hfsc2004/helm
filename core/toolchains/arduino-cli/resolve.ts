import { existsSync } from "node:fs";

import { runCommandAsync } from "../process.js";
import { arduinoCliPaths, buildArduinoCliEnv } from "./env.js";

/**
 * Where Helm should look for arduino-cli.
 *
 * Order:
 *   1. Helm's managed binary at <dataDir>/toolchains/arduino-cli/arduino-cli
 *      (preferred — fully isolated env).
 *   2. System arduino-cli on PATH (still uses Helm's isolated env, so the
 *      user's ~/.arduino15 is untouched).
 *   3. null — caller should prompt the user to install via
 *      `helm toolchain-install --target arduino-cli --confirm`.
 */
export interface ArduinoCliCommand {
  bin: string;
  baseArgs: string[];
  env: NodeJS.ProcessEnv;
  source: "managed" | "system";
  version: string;
}

async function probeVersion(
  bin: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const res = await runCommandAsync(bin, ["version"], { env, timeoutMs: 5000 });
  if (res.error || res.status !== 0) return null;
  // arduino-cli prints e.g. "arduino-cli  Version: 1.0.4 Commit: ..."
  const match = res.stdout.match(/Version:\s*(\S+)/i);
  return match ? match[1]! : "unknown";
}

export async function resolveArduinoCli(): Promise<ArduinoCliCommand | null> {
  const env = buildArduinoCliEnv();

  // Managed binary first.
  const managed = arduinoCliPaths.bin();
  if (existsSync(managed)) {
    const v = await probeVersion(managed, env);
    if (v) {
      return { bin: managed, baseArgs: [], env, source: "managed", version: v };
    }
  }

  // System fallback.
  const v = await probeVersion("arduino-cli", env);
  if (v) {
    return { bin: "arduino-cli", baseArgs: [], env, source: "system", version: v };
  }

  return null;
}
