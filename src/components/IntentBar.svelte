<script lang="ts">
  import { fleet } from "../stores/vehicles";
  import { activity } from "../stores/activity";
  import type { DriveStreamEvent } from "@shared/ipc-channels";

  let intent = "";
  let busy = false;
  let dryRun = false;
  let lastError: string | null = null;
  let activeStop: (() => Promise<void>) | null = null;

  function fmtCommand(cmd: unknown): string {
    if (!cmd || typeof cmd !== "object") return JSON.stringify(cmd);
    const c = cmd as { kind: string; speed?: number; signed?: number; left?: number; right?: number; durationMs?: number };
    const parts: string[] = [c.kind];
    if (c.speed !== undefined) parts.push(`speed=${c.speed}`);
    if (c.signed !== undefined) parts.push(`signed=${c.signed}`);
    if (c.left !== undefined) parts.push(`left=${c.left}`);
    if (c.right !== undefined) parts.push(`right=${c.right}`);
    if (c.durationMs !== undefined) parts.push(`${c.durationMs}ms`);
    return parts.join(" · ");
  }

  async function send() {
    const text = intent.trim();
    if (!text || !$fleet.selectedId || busy) return;
    busy = true;
    lastError = null;
    activity.push({ who: "human", kind: "cmd", message: text });
    intent = "";

    try {
      const sub = await window.helm.vehicle.drive(
        {
          vehicleId: $fleet.selectedId,
          intent: text,
          dryRun,
        },
        (raw: unknown) => {
          const e = raw as DriveStreamEvent;
          if (!e || typeof e !== "object" || !("event" in e)) return;
          switch (e.event) {
            case "plan":
              activity.push({
                who: "local",
                kind: "plan",
                message: `${fmtCommand(e.command)} (${e.modelUsed}, ${e.attempts} attempt${e.attempts === 1 ? "" : "s"})`,
              });
              break;
            case "validate":
              if (!e.ok) {
                activity.push({ who: "local", kind: "error", message: `validate failed: ${e.reason}` });
              }
              break;
            case "execute":
              activity.push({ who: "local", kind: "cmd", message: `→ ${fmtCommand(e.command)}` });
              break;
            case "complete":
              if (e.dryRun) {
                activity.push({ who: "local", kind: "ok", message: "dry-run complete" });
              } else if (e.ok) {
                activity.push({ who: "local", kind: "ok", message: "complete" });
              } else {
                activity.push({
                  who: "local",
                  kind: "error",
                  message: `failed: ${e.reason ?? "unknown"}`,
                });
              }
              break;
            case "error":
              activity.push({ who: "local", kind: "error", message: e.error });
              break;
          }
        }
      );
      activeStop = sub.stop;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      activity.push({ who: "local", kind: "error", message: lastError });
    } finally {
      busy = false;
      activeStop = null;
    }
  }

  async function cancel() {
    if (!activeStop) return;
    const fn = activeStop;
    activeStop = null;
    await fn();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }
</script>

<div class="bar">
  <input
    class="input"
    type="text"
    bind:value={intent}
    on:keydown={onKey}
    placeholder='tell the truck what to do — e.g. "drive forward 2 seconds"'
    disabled={!$fleet.selectedId || busy}
  />
  <label class="dryrun">
    <input type="checkbox" bind:checked={dryRun} />
    dry-run
  </label>
  {#if busy}
    <button class="cancel" on:click={cancel}>Cancel</button>
  {:else}
    <button class="send" on:click={send} disabled={!$fleet.selectedId || !intent.trim()}>
      Send
    </button>
  {/if}
</div>

<style>
  .bar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .input {
    flex: 1 1 auto;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 0.65rem 0.85rem;
    border-radius: 6px;
    font-size: 0.95rem;
    font-family: inherit;
  }
  .input::placeholder {
    color: var(--muted);
    font-style: italic;
  }
  .input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .input:disabled {
    opacity: 0.5;
  }
  .dryrun {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--muted);
    font-size: 0.8rem;
    user-select: none;
  }
  .send {
    background: var(--accent);
    color: white;
    border: none;
    padding: 0 1.25rem;
    border-radius: 6px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    height: 38px;
  }
  .send:disabled {
    background: var(--surface-2, #1c232c);
    color: var(--muted);
    cursor: not-allowed;
  }
  .cancel {
    background: var(--danger-dark, #b62324);
    color: white;
    border: 1px solid var(--danger, #f85149);
    padding: 0 1.25rem;
    border-radius: 6px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    height: 38px;
  }
</style>
