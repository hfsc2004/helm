/**
 * Typed IPC contract shared between the Electron main process and the renderer.
 *
 * Keep this file dependency-free — it is imported by both sides.
 */

export interface HelmAPI {
  app: {
    getVersion(): Promise<string>;
  };
}

declare global {
  interface Window {
    helm: HelmAPI;
  }
}
