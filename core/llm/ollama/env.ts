import { paths } from "../../paths.js";

/**
 * Helm's private Ollama port.
 *
 * Picked above Core-CE's 52434-52443 range so Helm and Core-CE can coexist
 * on the same machine without colliding. Distinct from system Ollama's 11434.
 */
export const HELM_OLLAMA_PORT = 52450;

/**
 * Build the isolation env vars for Helm's private Ollama instance.
 *
 * The four-variable contract is the entire reason Helm's Ollama and the
 * system's Ollama can coexist without stepping on each other:
 *
 *  - OLLAMA_HOST    pins the bind address/port to Helm's private port.
 *  - OLLAMA_MODELS  points at Helm's own models dir, not ~/.ollama/models.
 *  - OLLAMA_ORIGINS allows Helm's renderer to call the API (wildcard is fine
 *                   because the daemon is bound to localhost only via HOST).
 *  - CUDA_VISIBLE_DEVICES (optional) forces a specific GPU UUID. Headless GPU
 *                   selection comes from core/hardware before we spawn.
 */
export function buildOllamaEnv(opts: {
  forceCpu?: boolean;
  cudaDeviceUuid?: string;
} = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OLLAMA_HOST: `127.0.0.1:${HELM_OLLAMA_PORT}`,
    OLLAMA_ORIGINS: "*",
    OLLAMA_MODELS: paths.ollamaModels(),
  };

  if (opts.forceCpu) {
    env["CUDA_VISIBLE_DEVICES"] = "";
  } else if (opts.cudaDeviceUuid) {
    env["CUDA_VISIBLE_DEVICES"] = opts.cudaDeviceUuid;
  }

  return env;
}
