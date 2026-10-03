// SPDX-License-Identifier: Apache-2.0
import type { LightAction, LightScript, LightTarget, LightPlayback } from "../../shared/light-scripts.js";
import { validateLightScript } from "../../shared/light-scripts.js";

export class LightPlayer {
  private state: LightPlayback = { running: false, looping: false, scriptId: null, line: 0, error: "" };
  private cancel: AbortController | null = null;
  private completion: Promise<void> | null = null;
  status(): LightPlayback { return { ...this.state }; }
  async stop(): Promise<void> { this.cancel?.abort(); await this.completion; }
  async start(script: LightScript, endpoint: URL, loop = false): Promise<void> {
    if (this.state.running) throw new Error("A light show is already running. Stop it first.");
    script = validateLightScript(script);
    const actions = script.lines.flatMap(line => line.actions);
    const unsupported = actions.find(action => action.target.startsWith("ESP32-"));
    if (unsupported) throw new Error(`${unsupported.target}: its control GPIO has not been identified. Choose LED1–LED3 or IR.`);
    if (actions.some(action => action.target === "IR")) {
      const response = await fetch(new URL("/ir", endpoint), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("IR control requires the updated light-control firmware and the switch in expander mode (1–2).");
    }
    // Recheck after asynchronous preflight to prevent concurrent starts.
    if (this.state.running) throw new Error("A light show is already running.");
    const controller = new AbortController();
    this.cancel = controller;
    this.state = { running: true, looping: loop, scriptId: script.id, line: 0, error: "" };
    this.completion = this.run(script, endpoint, controller.signal, loop);
  }
  private async set(endpoint: URL, line: LightAction, on: boolean): Promise<void> {
    const url = new URL(line.target === "IR" ? "/ir" : "/led", endpoint);
    if (line.target === "IR") url.searchParams.set("enabled", on ? "1" : "0");
    else {
      url.searchParams.set("index", String(Number(line.target.slice(3)) - 1));
      for (const channel of ["r", "g", "b", "w"] as const) url.searchParams.set(channel, String(on ? line[channel] : 0));
    }
    const response = await fetch(url, { method: line.target === "IR" ? "POST" : "GET", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`${line.target}: HTTP ${response.status}`);
    const result = await response.json() as { ok?: boolean; error?: string };
    if (!result.ok) throw new Error(result.error || `${line.target}: light command failed`);
  }
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      if (signal.aborted) { resolve(); return; }
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  private async run(script: LightScript, endpoint: URL, signal: AbortSignal, loop: boolean): Promise<void> {
    const touched = new Map<LightTarget, LightAction>();
    try {
      do {
        for (let index = 0; index < script.lines.length && !signal.aborted; index++) {
          const line = script.lines[index]!;
          this.state.line = index + 1;
          if (!line.actions.length) {
            await this.wait(line.durationMs, signal);
            continue;
          }
          // Each selected light has its own timeline. Await all outstanding work
          // before cleanup, including when another light fails or Stop is pressed.
          const results = await Promise.allSettled(line.actions.map(async action => {
            touched.set(action.target, action);
            try {
              if (action.mode === "steady") {
                await this.set(endpoint, action, true);
                if (!signal.aborted) await this.wait(action.durationMs, signal);
                return; // No off command between lines or loop iterations.
              }
              for (let flash = 0; flash < action.flashes && !signal.aborted; flash++) {
                await this.set(endpoint, action, true);
                if (!signal.aborted) await this.wait(action.durationMs, signal);
                await this.set(endpoint, action, false);
                if (!signal.aborted) await this.wait(action.durationMs, signal);
              }
            } catch (error) { this.cancel?.abort(); throw error; }
          }));
          const failure = results.find(result => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      } while (loop && !signal.aborted);
    } catch (error) { this.state.error = error instanceof Error ? error.message : String(error); }
    finally {
      for (const line of touched.values()) {
        try { await this.set(endpoint, line, false); }
        catch (error) { this.state.error += `${this.state.error ? "; " : ""}Could not turn off ${line.target}: ${String(error)}`; }
      }
      this.state.running = false;
      this.state.looping = false;
      this.cancel = null;
    }
  }
}
