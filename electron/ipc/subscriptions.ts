// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import * as bmoc from "../../core/bmoc/index.js";

/**
 * Long-lived IPC subscription helper.
 *
 * Architectural rule (companion to BMOC's process rule):
 *   No long-lived IPC subscription opens without BMOC knowing about it.
 *   Every stream registers as a session here, so shutdown reaps it.
 *
 * One-shot request/response calls do NOT need this; they open and close
 * within the call. Use this only for streams.
 */

export interface SubscriptionInfo {
  streamId: string;
  bmocSessionId: string;
}

export interface SubscriptionHandle {
  info: SubscriptionInfo;
  /** Idempotent. Safe to call repeatedly; only the first call does work. */
  close: () => Promise<void>;
}

interface ActiveSubscription {
  streamId: string;
  bmocSessionId: string;
  closer: () => void | Promise<void>;
  closed: boolean;
}

const active = new Map<string, ActiveSubscription>();

let counter = 0;
function nextStreamId(kind: string): string {
  counter++;
  return `stream_${kind}_${Date.now()}_${counter}`;
}

/**
 * Open a tracked subscription. The caller provides the closer (e.g., a
 * setInterval handle wrapped in clearInterval). The closer is invoked on:
 *   - explicit close() on the returned handle
 *   - bmoc.closeAllSessions() at shutdown
 */
export function openSubscription(opts: {
  kind: string;
  consumerId?: string;
  metadata?: Record<string, unknown>;
  closer: () => void | Promise<void>;
}): SubscriptionHandle {
  const streamId = nextStreamId(opts.kind);
  const bmocSessionId = bmoc.registerSession({
    type: `ipc-${opts.kind}`,
    streamId,
    consumerId: opts.consumerId,
    ...(opts.metadata ?? {}),
  });

  const sub: ActiveSubscription = {
    streamId,
    bmocSessionId,
    closer: opts.closer,
    closed: false,
  };
  active.set(streamId, sub);

  return {
    info: { streamId, bmocSessionId },
    close: async () => {
      if (sub.closed) return;
      sub.closed = true;
      try {
        await sub.closer();
      } finally {
        active.delete(streamId);
        try {
          await bmoc.closeSession(bmocSessionId);
        } catch {
          // Already torn down by BMOC; that's fine.
        }
      }
    },
  };
}

export function closeByStreamId(streamId: string): Promise<void> {
  const sub = active.get(streamId);
  if (!sub || sub.closed) return Promise.resolve();
  sub.closed = true;
  active.delete(streamId);
  return Promise.resolve()
    .then(() => sub.closer())
    .then(() => bmoc.closeSession(sub.bmocSessionId).catch(() => undefined))
    .then(() => undefined);
}

/**
 * Close all subscriptions tied to a given consumer (e.g., on window close).
 */
export async function closeByConsumer(consumerId: string): Promise<number> {
  let count = 0;
  for (const [streamId, sub] of active) {
    // Consumer is stored on the BMOC session; query it.
    const session = bmoc.getSession(sub.bmocSessionId);
    if (session && session["consumerId"] === consumerId) {
      await closeByStreamId(streamId);
      count++;
    }
  }
  return count;
}

/** Snapshot, for diagnostics. */
export function listActive(): SubscriptionInfo[] {
  return [...active.values()].map((s) => ({
    streamId: s.streamId,
    bmocSessionId: s.bmocSessionId,
  }));
}
