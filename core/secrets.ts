import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Secret storage backed by a .env file in the project root.
 *
 * Why .env: the Node convention developers expect. The file is git-ignored
 * (see .gitignore) and never logged. We don't ship to OS keychain in v0.1
 * — that's a cross-platform engineering effort better suited to its own
 * polish branch later.
 *
 * Rules:
 *   - File mode 0600 on write. Never world-readable.
 *   - Values are never logged, never echoed in command output, never
 *     emitted in JSON output unless the caller explicitly asked for a
 *     "status" view that returns presence only.
 *   - Read on demand, not cached at startup. Token rotation works without
 *     restarting Helm.
 */

const ENV_PATH = join(process.cwd(), ".env");

/** Keys recognized by Helm. Add new ones here so the schema stays explicit. */
export type SecretKey = "HF_TOKEN";

function readDotenv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const text = readFileSync(ENV_PATH, "utf8");
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function writeDotenv(values: Record<string, string>): void {
  const lines: string[] = [];
  lines.push("# PSF Helm local secrets. Do not commit. (Already in .gitignore.)");
  lines.push("");
  for (const [k, v] of Object.entries(values)) {
    lines.push(`${k}=${v}`);
  }
  writeFileSync(ENV_PATH, lines.join("\n") + "\n", { encoding: "utf8" });
  try {
    chmodSync(ENV_PATH, 0o600);
  } catch {
    // Filesystem may not support chmod (e.g. Windows on some FS); the
    // gitignore is the primary safeguard.
  }
}

export function getSecret(key: SecretKey): string | null {
  const env = readDotenv();
  const v = env[key];
  return v && v.length > 0 ? v : null;
}

export function setSecret(key: SecretKey, value: string): void {
  const env = readDotenv();
  env[key] = value;
  writeDotenv(env);
}

export function clearSecret(key: SecretKey): boolean {
  const env = readDotenv();
  if (env[key] === undefined) return false;
  delete env[key];
  writeDotenv(env);
  return true;
}

export function hasSecret(key: SecretKey): boolean {
  return getSecret(key) !== null;
}
