// SPDX-License-Identifier: Apache-2.0
import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "../../core/paths.js";
import * as registry from "../../core/vehicles/registry.js";
import { LightPlayer } from "../../core/lights/player.js";
import { validateLightScript, type LightScript } from "../../shared/light-scripts.js";
import { IPC } from "../../shared/ipc-channels.js";

const manifest = join(paths.data, "light-scripts.json");
function load(): LightScript[] { return existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as LightScript[]).map(validateLightScript) : []; }
function save(scripts: LightScript[]): void {
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(manifest + ".tmp", JSON.stringify(scripts, null, 2));
  renameSync(manifest + ".tmp", manifest);
}
const player = new LightPlayer();
const editors = new Map<string, BrowserWindow>();
export async function stopLightShows(): Promise<void> { await player.stop(); }
export function registerLightHandlers(): void {
  ipcMain.handle(IPC.lights.list, () => load().sort((a, b) => a.name.localeCompare(b.name)));
  ipcMain.handle(IPC.lights.get, (_event, id: string) => {
    const script = load().find(item => item.id === id);
    if (!script) throw new Error("Script no longer exists.");
    return script;
  });
  ipcMain.handle(IPC.lights.save, (_event, value: LightScript) => {
    const script = validateLightScript(value);
    const scripts = load();
    if (scripts.some(item => item.id !== script.id && item.name.toLowerCase() === script.name.toLowerCase())) throw new Error("A script with that filename already exists.");
    if (script.id && !scripts.some(item => item.id === script.id)) throw new Error("Script was deleted. Create a new script to save these lines.");
    script.id ||= randomUUID();
    save([...scripts.filter(item => item.id !== script.id), script]);
    return script;
  });
  ipcMain.handle(IPC.lights.remove, (_event, id: string) => {
    if (player.status().running && player.status().scriptId === id) throw new Error("Stop the show before deleting its script.");
    save(load().filter(item => item.id !== id));
  });
  ipcMain.handle(IPC.lights.editor, (event, id?: string) => {
    const key = id || "new";
    const existing = editors.get(key);
    if (existing && !existing.isDestroyed()) { existing.focus(); return; }
    const parent = BrowserWindow.fromWebContents(event.sender) || undefined;
    const window = new BrowserWindow({ width: 1000, height: 750, minWidth: 760, minHeight: 500, parent,
      title: "LED script editor", backgroundColor: "#0f1419",
      webPreferences: { preload: join(__dirname, "..", "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    editors.set(key, window);
    window.on("closed", () => editors.delete(key));
    const hash = "led-editor" + (id ? `?id=${encodeURIComponent(id)}` : "");
    if (!app.isPackaged) void window.loadURL(`http://localhost:5173/#${hash}`);
    else void window.loadFile(join(app.getAppPath(), "dist", "index.html"), { hash });
  });
  ipcMain.handle(IPC.lights.play, async (_event, req: { vehicleId: string; scriptId: string; loop?: boolean }) => {
    const vehicle = registry.get(req.vehicleId);
    if (vehicle?.sensorBoardRevision !== "1.3" || !vehicle.camera) throw new Error("Select a v1.3 sensor-board robot.");
    const script = load().find(item => item.id === req.scriptId);
    if (!script) throw new Error("Script no longer exists.");
    const endpoint = new URL(vehicle.camera.baseUrl); endpoint.port = "82";
    if (endpoint.protocol !== "http:") throw new Error("Light shows require HTTP.");
    await player.start(script, endpoint, req.loop === true);
  });
  ipcMain.handle(IPC.lights.stop, () => player.stop());
  ipcMain.handle(IPC.lights.status, () => player.status());

}
