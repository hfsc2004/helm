<script lang="ts">
  // Driver view — the simple, one-robot surface.
  // v0.1: placeholder. Real driving controls land in v0.2.
</script>

<section class="driver">
  <div class="brand">
    <img src="/logo.png" alt="PSF Helm" />
    <p class="tagline">The natural-language helm for your robot — or your drone.</p>
  </div>

  <div class="status">
    <p>PSF Helm v0.1</p>
    <p class="muted">No vehicle paired yet.</p>
  </div>
</section>

<style>
  .driver {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2rem;
    padding: 2rem;
  }

  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .brand img {
    max-width: 420px;
    width: 60%;
    height: auto;
  }

  .tagline {
    color: var(--muted);
    font-style: italic;
    margin: 0;
    text-align: center;
  }

  .status {
    text-align: center;
  }

  .status p {
    margin: 0.25rem 0;
  }

  .muted {
    color: var(--muted);
    font-size: 0.9rem;
  }
</style>
