<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { onMount } from "svelte";
  import { LIGHT_TARGETS, validateLightScript, lightLineDuration, type LightLine, type LightAction, type LightTarget, type LightScript } from "@shared/light-scripts";
  let script: LightScript = { id: "", name: "", lines: [blank()] };
  let busy = false;
  let error = "";
  let message = "";
  let dirty = false;
  let colorLine = -1;
  let colorTarget: LightTarget = "LED1";
  let color = "#0000ff";
  function action(target: LightTarget): LightAction { return { target, mode: "steady", r: 0, g: 0, b: 255, w: 0, flashes: 1, durationMs: 500 }; }
  function blank(): LightLine { return { actions: [action("LED1")], durationMs: 500 }; }
  function toggle(index: number, target: LightTarget, enabled: boolean) {
    const line = script.lines[index]!;
    line.actions = enabled ? [...line.actions, action(target)] : line.actions.filter(item => item.target !== target);
    script = { ...script }; colorLine = -1; changed();
  }
  $: totalSeconds = script.lines.reduce((sum, line) => sum + lightLineDuration(line), 0) / 1000;
  function changed() { dirty = true; message = ""; }
  function move(index: number, direction: number) {
    const lines = [...script.lines];
    [lines[index], lines[index + direction]] = [lines[index + direction]!, lines[index]!];
    script = { ...script, lines }; colorLine = -1; changed();
  }
  function pick(index: number, target: LightTarget) {
    colorLine = index; colorTarget = target;
    const line = script.lines[index]!.actions.find(item => item.target === target)!;
    color = "#" + [line.r, line.g, line.b].map(n => n.toString(16).padStart(2, "0")).join("");
  }
  function updateRgb() {
    if (colorLine < 0) return;
    const line = script.lines[colorLine]!.actions.find(item => item.target === colorTarget);
    if (!line) return;
    [line.r, line.g, line.b] = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
    script = { ...script }; changed();
  }
  async function save() {
    error = ""; busy = true;
    try {
      script = await window.helm.lights.save(validateLightScript(script));
      dirty = false; message = `Saved ${script.name}`; document.title = `${script.name} — LED script editor`;
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  onMount(() => {
    const id = new URLSearchParams(window.location.hash.split("?")[1] || "").get("id");
    if (id) {
      busy = true;
      void window.helm.lights.get(id).then(value => { script = validateLightScript(value); document.title = `${value.name} — LED script editor`; })
        .catch(e => { error = String(e); }).finally(() => { busy = false; });
    }
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  });
</script>

<main>
  <header><div><h1>LED script editor</h1><p>Create a light show, one step at a time.</p></div><button class="save" on:click={save} disabled={busy}>Save</button></header>
  <label class="filename">Filename <input bind:value={script.name} on:input={changed} placeholder="My light show" maxlength="80" disabled={busy} /></label>
  <p class="help">Select multiple lights per line and program each separately. Selected lights run together; the next line starts after the longest finishes. Lines run from top to bottom. Steady on holds the color without flashing, including between loop repeats. Flash alternates on and off for the duration. All affected lights turn off when the show finishes or stops. IR controls all three emitters together. No Action pauses for the duration without changing any lights.</p>
  <p class="help">ESP32-LED4 and ESP32-LED5 need verified GPIO mappings before playback. IR requires updated firmware and the board switch in expander mode (1–2).</p>
  <div class="lines">
    {#each script.lines as line, index}
      <article>
        <div class="line-head"><strong>Line {index + 1}</strong><div>
          <button on:click={() => move(index, -1)} disabled={busy || index === 0} aria-label={`Move line ${index + 1} up`}>↑</button>
          <button on:click={() => move(index, 1)} disabled={busy || index === script.lines.length - 1} aria-label={`Move line ${index + 1} down`}>↓</button>
          <button on:click={() => { script.lines = script.lines.filter((_, i) => i !== index); colorLine = -1; changed(); }} disabled={busy || script.lines.length === 1}>Remove line</button>
        </div></div>
        <fieldset disabled={busy}><legend>Lights to run together</legend><div class="targets">
          {#each LIGHT_TARGETS as target}
            <label><input type="checkbox" checked={line.actions.some(item => item.target === target)} on:change={event => toggle(index, target, event.currentTarget.checked)} />{target}</label>
          {/each}
          <label><input type="checkbox" checked={!line.actions.length} on:change={() => { line.actions = []; script = { ...script }; colorLine = -1; changed(); }} />No Action</label>
        </div></fieldset>
        {#if !line.actions.length}
          <div class="settings"><span class="channels">Pause · no light commands</span><label>Duration (ms) <input type="number" min="100" max="60000" step="100" bind:value={line.durationMs} on:input={changed} disabled={busy} /></label></div>
        {/if}
        {#each line.actions as light (light.target)}
          <div class="light-settings">
            <div class="settings">
              <strong class="light-name">{light.target}</strong>
              {#if ["LED1", "LED2", "LED3"].includes(light.target)}
                <button class="color-button" disabled={busy} on:click={() => pick(index, light.target)}><span style={`background: rgb(${light.r}, ${light.g}, ${light.b})`}></span>Choose RGBW color</button>
                <span class="channels">R {light.r} · G {light.g} · B {light.b} · W {light.w}</span>
              {:else}<span class="channels">On / off</span>{/if}
              <label>Behavior <select bind:value={light.mode} on:change={changed} disabled={busy} aria-label={`${light.target} behavior`}><option value="steady">Steady on</option><option value="flash">Flash</option></select></label>
              {#if light.mode === "flash"}<label>Flashes <input type="number" min="1" max="1000" step="1" bind:value={light.flashes} on:input={changed} disabled={busy} /></label>{/if}
              <label>Duration (ms) <input type="number" min="100" max="60000" step="100" bind:value={light.durationMs} on:input={changed} disabled={busy} /></label>
            </div>
            {#if colorLine === index && colorTarget === light.target}
              <div class="palette">
                <label>RGB spectrum <input type="color" bind:value={color} on:input={updateRgb} /></label>
                {#each ["r", "g", "b", "w"] as channel}
                  <label>{channel === "w" ? "White channel" : channel.toUpperCase()} <input class={channel} type="range" min="0" max="255" step="1" bind:value={light[channel as "r" | "g" | "b" | "w"]} on:input={changed} /> <span>{light[channel as "r" | "g" | "b" | "w"]}</span></label>
                {/each}
                <button on:click={() => { colorLine = -1; }}>Done</button>
              </div>
            {/if}
          </div>
        {/each}
      </article>
    {/each}
  </div>
  <footer><button on:click={() => { script.lines = [...script.lines, blank()]; changed(); }} disabled={busy || script.lines.length >= 200}>+ Add line</button><span>{script.lines.length} lines · {Number.isFinite(totalSeconds) ? totalSeconds.toFixed(1) : "—"} seconds{dirty ? " · Unsaved" : ""}</span><button on:click={save} disabled={busy}>Save script</button></footer>
  {#if message}<p class="message" role="status">{message}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</main>

<style>
  main { height: 100vh; overflow-y: auto; padding: 1.5rem; }
  header, footer, .line-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  h1 { font-size: 1.4rem; margin: 0; }
  header p, .help { color: var(--muted); font-size: .85rem; line-height: 1.5; }
  .filename { display: flex; align-items: center; gap: .75rem; margin-top: 1rem; }
  .filename input { flex: 1; }
  article { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .line-head { margin-bottom: .75rem; }
  .line-head div { display: flex; gap: .4rem; }
  fieldset { border: 1px solid var(--border); border-radius: 4px; }
  legend { color: var(--muted); font-size: .8rem; }
  .targets, .settings { display: flex; flex-wrap: wrap; align-items: center; gap: .9rem; }
  .targets label { display: flex; gap: .3rem; align-items: center; font-size: .85rem; }
  .settings { margin-top: .8rem; }
  .light-settings { padding-bottom: .8rem; border-bottom: 1px solid var(--border); }
  .light-settings:last-child { border-bottom: 0; padding-bottom: 0; }
  .light-name { min-width: 60px; font-size: .85rem; }
  .settings label { display: flex; align-items: center; gap: .4rem; font-size: .8rem; }
  select { padding: .5rem; border-radius: 4px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); }
  input[type="number"] { width: 100px; }
  input:not([type="checkbox"]):not([type="range"]):not([type="color"]) { padding: .5rem; border-radius: 4px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); }
  button { cursor: pointer; padding: .5rem .7rem; border-radius: 4px; border: 1px solid var(--border); background: #242c36; color: var(--fg); }
  button:disabled { opacity: .5; cursor: default; }
  .save { background: var(--accent); }
  .color-button { display: flex; align-items: center; gap: .5rem; }
  .color-button span { width: 22px; height: 22px; border: 1px solid #aaa; border-radius: 4px; }
  .channels { color: var(--muted); font-size: .75rem; }
  .palette { margin-top: 1rem; padding: 1rem; background: var(--bg); border-radius: 6px; }
  .palette label { display: flex; align-items: center; gap: 1rem; margin-bottom: .7rem; font-size: .85rem; }
  .palette input[type="range"] { flex: 1; appearance: none; border-radius: 5px; height: 10px; }
  .r { background: linear-gradient(to right, #000, #ff0000); } .g { background: linear-gradient(to right, #000, #00ff00); }
  .b { background: linear-gradient(to right, #000, #0000ff); } .w { background: linear-gradient(to right, #000, #fff); }
  footer span { color: var(--muted); font-size: .8rem; }
  .message { color: #80d0a0; } .error { color: #ff9090; }
</style>
