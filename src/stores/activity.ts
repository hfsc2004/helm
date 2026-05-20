import { writable } from "svelte/store";

export type ActivityKind = "cmd" | "ok" | "stop" | "snap" | "advise" | "error" | "plan";

export interface ActivityEntry {
  id: number;
  ts: number;
  who: "human" | "local" | "remote";
  kind: ActivityKind;
  message: string;
  /** When set, this entry represents N identical messages collapsed
   *  into one row instead of flooding the log. */
  count?: number;
}

const MAX_ENTRIES = 80;
let counter = 0;

function createActivityStore() {
  const store = writable<ActivityEntry[]>([]);

  function push(entry: Omit<ActivityEntry, "id" | "ts" | "count">) {
    store.update((arr) => {
      // If the newest entry is identical (same who/kind/message), bump its
      // count and refresh its timestamp instead of pushing a duplicate row.
      // This is what keeps a hold-drive loop or a long string of identical
      // errors from saturating the visible log.
      const head = arr[0];
      if (
        head &&
        head.who === entry.who &&
        head.kind === entry.kind &&
        head.message === entry.message
      ) {
        const updated: ActivityEntry = {
          ...head,
          ts: Date.now(),
          count: (head.count ?? 1) + 1,
        };
        return [updated, ...arr.slice(1)];
      }
      counter++;
      const next = [
        { id: counter, ts: Date.now(), ...entry },
        ...arr,
      ];
      if (next.length > MAX_ENTRIES) next.length = MAX_ENTRIES;
      return next;
    });
  }

  return { subscribe: store.subscribe, push, clear: () => store.set([]) };
}

export const activity = createActivityStore();
