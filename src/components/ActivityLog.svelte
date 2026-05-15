<script lang="ts">
  import { activity } from "../stores/activity";

  function fmtTime(t: number): string {
    const d = new Date(t);
    return d.toLocaleTimeString();
  }
</script>

<section>
  <h3>Activity</h3>
  {#if $activity.length === 0}
    <p class="muted">No activity yet</p>
  {:else}
    <div class="log">
      {#each $activity as e (e.id)}
        <div class="line">
          <span class="ts">{fmtTime(e.ts)}</span>
          <span class="who who-{e.who}">{e.who}</span>
          <span class="kind kind-{e.kind}">{e.kind}</span>
          <span class="msg">{e.message}</span>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  section {
    padding: 1rem;
    border-bottom: 1px solid var(--border);
  }
  h3 {
    margin: 0 0 0.6rem 0;
    font-size: 0.7rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .log {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.72rem;
    color: var(--muted);
    max-height: 200px;
    overflow-y: auto;
    line-height: 1.55;
  }
  .line {
    display: grid;
    grid-template-columns: auto auto auto 1fr;
    gap: 0.4rem;
    align-items: baseline;
    padding: 1px 0;
  }
  .ts {
    color: var(--border);
  }
  .who {
    padding: 0 0.35rem;
    border-radius: 3px;
    font-size: 0.62rem;
    text-transform: lowercase;
  }
  .who-human { background: rgba(63, 185, 80, 0.12); color: var(--good, #3fb950); }
  .who-local { background: rgba(163, 113, 247, 0.12); color: #a371f7; }
  .who-remote { background: rgba(31, 111, 235, 0.12); color: var(--accent-soft, #2d7bf0); }
  .kind {
    font-size: 0.62rem;
  }
  .kind-cmd { color: var(--accent-soft, #2d7bf0); }
  .kind-plan { color: #a371f7; }
  .kind-ok { color: var(--good, #3fb950); }
  .kind-stop { color: var(--danger, #f85149); }
  .kind-snap { color: #a371f7; }
  .kind-advise { color: var(--accent-soft, #2d7bf0); }
  .kind-error { color: var(--danger, #f85149); }
  .msg {
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0;
  }
</style>
