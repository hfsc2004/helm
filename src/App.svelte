<script lang="ts">
  import DriverView from "./views/DriverView.svelte";
</script>

<main>
  <DriverView />

  <footer>
    <span>Copyright © 2026 Pseudo Science Fiction</span>
  </footer>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
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
