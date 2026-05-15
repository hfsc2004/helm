<script lang="ts">
  import { activeView, type ViewName } from "../stores/view";

  const tabs: Array<{ id: ViewName; label: string; icon: string }> = [
    { id: "drive", label: "Drive", icon: "▸" },
    { id: "devices", label: "Devices", icon: "⌬" },
  ];

  function pick(id: ViewName) {
    activeView.set(id);
  }
</script>

<nav>
  <div class="strip">
    {#each tabs as t (t.id)}
      <button
        class="tab"
        class:active={$activeView === t.id}
        on:click={() => pick(t.id)}
      >
        <span class="icon">{t.icon}</span>
        <span class="label">{t.label}</span>
      </button>
    {/each}
  </div>
</nav>

<style>
  /* The nav sits at the bottom edge of the header bar. The active tab's
     bottom border matches the content background underneath, so the tab
     visually merges into the content area below — classic browser-tab look. */
  nav {
    display: flex;
    align-items: flex-end;
    /* Negative bottom margin pulls the strip down past the header's
       border-bottom so the active tab can cover/erase that seam. */
    margin-bottom: -1px;
    position: relative;
    z-index: 2;
  }
  .strip {
    display: flex;
    gap: 0.25rem;
    align-items: flex-end;
  }
  .tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    background: transparent;
    border: 1px solid transparent;
    border-bottom: none;
    color: var(--muted);
    font: inherit;
    font-size: 0.85rem;
    padding: 0.55rem 1.1rem 0.55rem 1rem;
    border-radius: 8px 8px 0 0;
    cursor: pointer;
    /* Slightly recessed inactive tabs */
    transform: translateY(0);
    transition: color 120ms, background 120ms, transform 120ms;
  }
  .tab .icon {
    font-size: 0.9rem;
    opacity: 0.7;
  }
  .tab:hover:not(.active) {
    color: var(--fg);
    background: rgba(255, 255, 255, 0.025);
  }
  .tab.active {
    background: var(--bg);
    color: var(--fg);
    border-color: var(--border);
    /* The 1px overlap that hides the header's bottom border. */
    border-bottom: 1px solid var(--bg);
    padding-top: 0.65rem;
    padding-bottom: 0.65rem;
    box-shadow:
      inset 0 2px 0 var(--accent),
      0 -2px 6px rgba(0, 0, 0, 0.25);
  }
  .tab.active .icon {
    opacity: 1;
    color: var(--accent-soft, #2d7bf0);
  }
</style>
