<script lang="ts">
  import DriverView from "./views/DriverView.svelte";
  import VehiclePicker from "./components/VehiclePicker.svelte";
</script>

<main>
  <header>
    <div class="brand">
      <img src="/logo.png" alt="PSF Helm" />
    </div>
    <VehiclePicker />
    <div class="spacer"></div>
  </header>

  <DriverView />

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
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .brand img {
    height: 36px;
    width: auto;
  }
  .spacer {
    flex: 1 1 auto;
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
