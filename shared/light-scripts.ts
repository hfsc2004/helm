// SPDX-License-Identifier: Apache-2.0
export const LIGHT_TARGETS = ["LED1", "LED2", "LED3", "ESP32-LED4", "ESP32-LED5", "IR"] as const;
export type LightTarget = typeof LIGHT_TARGETS[number];
export interface LightAction { target: LightTarget; mode?: "steady" | "flash"; r: number; g: number; b: number; w: number; flashes: number; durationMs: number; }
// Empty actions represent a No Action line, using durationMs as its pause.
export interface LightLine { actions: LightAction[]; durationMs: number; }
export interface LightScript { id: string; name: string; lines: LightLine[]; }
export interface LightPlayback { running: boolean; looping: boolean; scriptId: string | null; line: number; error: string; }
export function lightLineDuration(line: LightLine): number {
  return line.actions.length ? Math.max(...line.actions.map(action => action.mode === "steady" ? action.durationMs : action.flashes * action.durationMs * 2)) : line.durationMs;
}
export function validateLightScript(value: LightScript): LightScript {
  if (!value || typeof value.name !== "string" || !/^[\w .-]{1,80}$/.test(value.name.trim()) || value.name.includes("..")) throw new Error("Use a filename of 1–80 letters, numbers, spaces, dots, dashes or underscores.");
  if (!Array.isArray(value.lines) || !value.lines.length || value.lines.length > 200) throw new Error("A script needs 1–200 lines.");
  const lines = value.lines.map((line, index) => {
    if (!line || typeof line !== "object") throw new Error(`Line ${index + 1}: invalid line.`);
    // Read older single-light scripts without losing their timing or colors.
    const legacy = line as LightLine & Partial<Omit<LightAction, "target">> & { target?: string };
    const rawActions = Array.isArray(line.actions) ? line.actions : legacy.target === "No Action" ? [] : legacy.target ? [legacy] : null;
    if (!rawActions || rawActions.length > LIGHT_TARGETS.length) throw new Error(`Line ${index + 1}: select lights or No Action.`);
    const seen = new Set<string>();
    const actions = rawActions.map(action => {
      if (!action || !LIGHT_TARGETS.includes(action.target as LightTarget)) throw new Error(`Line ${index + 1}: select a valid light.`);
      if (action.mode !== undefined && action.mode !== "steady" && action.mode !== "flash") throw new Error(`Line ${index + 1}: select Steady on or Flash.`);
      if (seen.has(action.target!)) throw new Error(`Line ${index + 1}: a light may appear only once.`);
      seen.add(action.target!);
      for (const channel of [action.r, action.g, action.b, action.w]) if (!Number.isInteger(channel) || channel! < 0 || channel! > 255) throw new Error(`Line ${index + 1}: color channels must be 0–255.`);
      if (action.mode !== "steady" && (!Number.isInteger(action.flashes) || action.flashes! < 1 || action.flashes! > 1000)) throw new Error(`Line ${index + 1}: flashes must be 1–1000.`);
      if (!Number.isInteger(action.durationMs) || action.durationMs! < 100 || action.durationMs! > 60000) throw new Error(`Line ${index + 1}: duration must be 100–60000 ms.`);
      return { target: action.target as LightTarget, mode: action.mode ?? "flash", r: action.r!, g: action.g!, b: action.b!, w: action.w!, flashes: action.mode === "steady" ? 1 : action.flashes!, durationMs: action.durationMs! };
    });
    const durationMs = line.durationMs ?? 500;
    if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 60000) throw new Error(`Line ${index + 1}: pause duration must be 100–60000 ms.`);
    return { actions, durationMs };
  });
  if (lines.reduce((total, line) => total + lightLineDuration(line), 0) > 3600000) throw new Error("A show must finish within one hour.");
  return { id: typeof value.id === "string" ? value.id : "", name: value.name.trim(), lines };
}
