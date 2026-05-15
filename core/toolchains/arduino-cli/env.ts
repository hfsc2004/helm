import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { paths } from "../../paths.js";

/**
 * Isolated arduino-cli environment.
 *
 * Same isolation pattern as Helm's private Ollama: never touches the user's
 * ~/.arduino15. Helm's arduino-cli reads/writes config, downloads cores, and
 * stores user libraries entirely under <dataDir>/toolchains/arduino-cli/.
 *
 * If a system arduino-cli is also installed, the user's setup is unaffected.
 */
function arduinoCliConfigDir(): string {
  return join(paths.arduinoCliRoot(), "config");
}
function arduinoCliDataDir(): string {
  return join(paths.arduinoCliRoot(), "data");
}
function arduinoCliDownloadsDir(): string {
  return join(paths.arduinoCliRoot(), "downloads");
}
function arduinoCliUserDir(): string {
  return join(paths.arduinoCliRoot(), "user");
}

export function ensureArduinoCliDirs(): void {
  for (const p of [
    paths.arduinoCliRoot(),
    arduinoCliConfigDir(),
    arduinoCliDataDir(),
    arduinoCliDownloadsDir(),
    arduinoCliUserDir(),
  ]) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

export function buildArduinoCliEnv(): NodeJS.ProcessEnv {
  ensureArduinoCliDirs();
  return {
    ...process.env,
    ARDUINO_CONFIG_DIR: arduinoCliConfigDir(),
    ARDUINO_DIRECTORIES_DATA: arduinoCliDataDir(),
    ARDUINO_DIRECTORIES_DOWNLOADS: arduinoCliDownloadsDir(),
    ARDUINO_DIRECTORIES_USER: arduinoCliUserDir(),
  };
}

export const arduinoCliPaths = {
  root: () => paths.arduinoCliRoot(),
  bin: () => paths.arduinoCliBin(),
  config: arduinoCliConfigDir,
  data: arduinoCliDataDir,
  downloads: arduinoCliDownloadsDir,
  user: arduinoCliUserDir,
};
