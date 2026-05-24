<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Pseudo Science Fiction -->
<script lang="ts">
  import DriverView from "./views/DriverView.svelte";
  import VehiclesView from "./views/VehiclesView.svelte";
  import DevicesView from "./views/DevicesView.svelte";
  import VehiclePicker from "./components/VehiclePicker.svelte";
  import TabNav from "./components/TabNav.svelte";
  import { activeView } from "./stores/view";
</script>

<main>
  <header>
    <div class="top">
      <div class="brand">
        <img src="/logo.png" alt="PSF Helm" />
      </div>
      <div class="spacer"></div>
      {#if $activeView === "drive"}
        <VehiclePicker />
      {/if}
    </div>
    <div class="tabs-row">
      <TabNav />
    </div>
  </header>

  <div class="content">
    {#if $activeView === "drive"}
      <DriverView />
    {:else if $activeView === "vehicles"}
      <VehiclesView />
    {:else if $activeView === "devices"}
      <DevicesView />
    {/if}
  </div>

  <footer>
    <span>Copyright © 2026 Pseudo Science Fiction</span>
  </footer>
</main>

<style>
  main {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100vh;
    width: 100vw;
  }
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    /* The tabs row pulls -1px below to bleed into the content area. */
    position: relative;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem 0.4rem 1rem;
  }
  .tabs-row {
    display: flex;
    align-items: flex-end;
    padding: 0 1rem;
  }
  .brand {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 0.35rem 0.85rem;
    background: #f4f1ea;
    border: 1px solid #d4cfc4;
    border-radius: 999px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }
  .brand img {
    height: 32px;
    width: auto;
    display: block;
    position: relative;
    z-index: 1;
  }
  /* Soft pulse: a faint ring expands from the center of the capsule outward,
     like a single drop landing on a still pond. Used radial-gradient with
     opacity scale so it grows + fades simultaneously. */
  .brand::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: radial-gradient(
      circle at 20% 50%,
      transparent 0%,
      transparent 28%,
      rgba(40, 70, 110, 0.35) 38%,
      transparent 50%,
      transparent 100%
    );
    transform-origin: 20% 50%;
    mix-blend-mode: multiply;
    transform: scale(0.2);
    opacity: 0;
    animation: brand-pulse 8s ease-out infinite;
    pointer-events: none;
    z-index: 2;
  }
  @keyframes brand-pulse {
    0% {
      transform: scale(0.2);
      opacity: 0;
    }
    8% {
      opacity: 0.9;
    }
    35% {
      transform: scale(2.2);
      opacity: 0;
    }
    100% {
      transform: scale(2.2);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .brand::after {
      animation: none;
    }
  }
  .spacer {
    flex: 1 1 auto;
  }
  .content {
    overflow: hidden;
    min-height: 0;
    background: var(--bg);
  }
  /* Direct child fills the content area (DriverView's grid, DevicesView's
     scroll container, etc.). */
  .content > :global(*) {
    height: 100%;
  }
  footer {
    flex: 0 0 auto;
    padding: 0.5rem 1rem;
    font-size: 0.75rem;
    color: var(--muted);
    border-top: 1px solid var(--border);
    background: var(--surface);
    text-align: center;
  }
</style>
