import { homedir, platform } from "node:os";
import { join } from "node:path";
import { env } from "node:process";

const APP_NAME = "psf-helm";

function dataDir(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", APP_NAME);
    case "win32":
      return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_NAME);
    default:
      return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), APP_NAME);
  }
}

function configDir(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Preferences", APP_NAME);
    case "win32":
      return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_NAME, "config");
    default:
      return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP_NAME);
  }
}

export const paths = {
  data: dataDir(),
  config: configDir(),
  registry: () => join(dataDir(), "registry.json"),
  state: (vehicleId: string) => join(dataDir(), "state", `${vehicleId}.ndjson`),
  commandHistory: (vehicleId: string) =>
    join(dataDir(), "history", `${vehicleId}.ndjson`),
  trace: (traceId: string) => join(dataDir(), "traces", `${traceId}.ndjson`),
  errors: () => join(dataDir(), "errors.ndjson"),
  ollamaRoot: () => join(dataDir(), "ollama"),
  ollamaBin: () => join(dataDir(), "ollama", "bin", "ollama"),
  ollamaModels: () => join(dataDir(), "ollama", "models"),
  modelStaging: () => join(dataDir(), "model-staging"),
  toolchainsRoot: () => join(dataDir(), "toolchains"),
  arduinoCliRoot: () => join(dataDir(), "toolchains", "arduino-cli"),
  arduinoCliBin: () => join(dataDir(), "toolchains", "arduino-cli", "arduino-cli"),
  controlPlane: () => join(dataDir(), "control-plane.json"),
};
