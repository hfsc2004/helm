/**
 * BMOC — sole authority over process lifecycle in PSF Helm.
 *
 * Imported verbatim from PSF Core's session-manager subsystem. The .js files
 * here are battle-tested across years of fighting process/port/orphan cleanup
 * bugs. Do not "modernize" them.
 *
 * Architectural rule (non-negotiable):
 *   Nothing in Helm spawns or kills its own processes. Every subsystem that
 *   needs to run a child process — llama.cpp, whisper.cpp, piper, vehicle
 *   transports later — registers it here. BMOC owns the kill switch.
 *
 * If you find yourself reaching for `child_process.spawn` in a feature module,
 * stop. Route through BMOC.
 */

// Verbatim CommonJS modules from PSF Core.
// `require` is available in CJS context (the module system both this file
// and the .js siblings compile to).
const processUtils = require("./session-manager-process-utils.js") as {
  isProcessRunning(pid: number): Promise<boolean>;
  killProcess(pid: number, signal?: string): Promise<boolean>;
  killProcessesOnPort(port: number): Promise<boolean>;
};

const sessionUtils = require("./session-manager-session-utils.js") as {
  normalizeServiceType(value: unknown): string;
  generateSessionId(type: string): string;
  getOllamaPortForService(type: string): number | null;
  hasActiveSession(sessions: Record<string, unknown>, type: string): boolean;
  getActiveSessionsForService(
    sessions: Record<string, unknown>,
    type: string
  ): unknown[];
  getSessionCount(sessions: Record<string, unknown>): number;
  getSessionStats(sessions: Record<string, unknown>): Record<string, unknown>;
  getSessionSummary(sessions: Record<string, unknown>): string;
};

const createStateManager = require("./session-manager-state.js") as (deps: {
  processUtils: typeof processUtils;
  sessionUtils: typeof sessionUtils;
}) => {
  initialize(appPath: string): string;
  getAppPath(): string | null;
  getSessionsFile(): string | null;
  loadSessions(): void;
  validateSessions(): Promise<void>;
  registerSession(config: SessionConfig): string;
  getSession(sessionId: string): SessionRecord | null;
  removeSession(sessionId: string): boolean;
  closeSession(sessionId: string): Promise<boolean>;
  closeAllSessions(): Promise<void>;
  getAllSessions(): Record<string, SessionRecord>;
};

export interface SessionConfig {
  type: string;
  pid?: number;
  port?: number;
  [key: string]: unknown;
}

export interface SessionRecord {
  id: string;
  type: string;
  pid?: number;
  port?: number;
  startedAt: number;
  [key: string]: unknown;
}

const state = createStateManager({ processUtils, sessionUtils });

/**
 * Initialize BMOC. Call once at app startup.
 *
 * @param appPath  Path to the Helm install dir. sessions.json is written
 *                 alongside it ("../sessions.json" relative to appPath, per
 *                 PSF Core convention).
 */
export function initialize(appPath: string): void {
  state.initialize(appPath);
  state.loadSessions();
  void state.validateSessions();
}

export function registerSession(config: SessionConfig): string {
  return state.registerSession(config);
}

export function getSession(sessionId: string): SessionRecord | null {
  return state.getSession(sessionId);
}

export function closeSession(sessionId: string): Promise<boolean> {
  return state.closeSession(sessionId);
}

export function closeAllSessions(): Promise<void> {
  return state.closeAllSessions();
}

export function getAllSessions(): Record<string, SessionRecord> {
  return state.getAllSessions();
}

export { processUtils, sessionUtils };
