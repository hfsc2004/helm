/**
 * Storage limits. Every persistent thing in PSF Helm is capped.
 *
 * If you find yourself wanting to write to disk and there isn't a category
 * here, add one. Do not bypass storage limits.
 */

export const STORAGE_LIMITS = {
  /** Per-vehicle rolling state log. NDJSON file, oldest line dropped on overflow. */
  stateLogBytes: 10 * 1024 * 1024,

  /** Per-vehicle command history. Rolling, oldest entry drops off. */
  commandHistoryEntries: 1000,

  /** Max per-trace file size (NDJSON). */
  traceBytes: 1 * 1024 * 1024,

  /** Max number of trace files retained; oldest evicted on overflow. */
  traceFiles: 50,

  /** Max number of vehicles in the registry. Add rejected past this. */
  registryVehicles: 64,

  /** LLM planner cache: in-memory LRU of intent -> command. */
  plannerCacheEntries: 100,

  /** Errors log: rolling NDJSON, capped by size. */
  errorsLogBytes: 100 * 1024,

  /** Errors log: max entries; oldest drop off. */
  errorsLogEntries: 20,

  /** Max length of a user-provided intent string in bytes. */
  intentMaxBytes: 2 * 1024,

  /** Max commands-per-second per vehicle from the CLI/UI. */
  commandRatePerSec: 20,

  /** Max queued pending commands per vehicle. */
  commandQueueDepth: 8,

  /** Max concurrent state-stream subscribers per vehicle. */
  stateStreamSubscribers: 4,

  /** NDJSON stream backpressure buffer (per subscriber). */
  streamBufferBytes: 64 * 1024,
} as const;

export type StorageLimitKey = keyof typeof STORAGE_LIMITS;
