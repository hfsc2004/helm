import { writable } from "svelte/store";

export type ActivityKind = "cmd" | "ok" | "stop" | "snap" | "advise" | "error" | "plan";

export interface ActivityEntry {
  id: number;
  ts: number;
  who: "human" | "local" | "remote";
  kind: ActivityKind;
  message: string;
}

const MAX_ENTRIES = 80;
let counter = 0;

function createActivityStore() {
  const store = writable<ActivityEntry[]>([]);

  function push(entry: Omit<ActivityEntry, "id" | "ts">) {
    counter++;
    store.update((arr) => {
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
