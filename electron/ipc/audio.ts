// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { app, dialog, ipcMain } from "electron";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "../../core/paths.js";
import * as registry from "../../core/vehicles/registry.js";
import { playSpeakerFile } from "../../core/vehicles/speaker.js";
import { IPC } from "../../shared/ipc-channels.js";

interface Entry { id: string; name: string; path: string; }
const manifest = join(paths.data, "audio-library.json");
const supported = /\.(wav|mp3|ogg|flac|m4a|aac)$/i;
function save(entries: Entry[]): void {
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(manifest + ".tmp", JSON.stringify(entries, null, 2));
  renameSync(manifest + ".tmp", manifest);
}
function load(): Entry[] {
  if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8"));
  const directory = join(app.getAppPath(), "Sensor_Board_v1.3", "audio");
  const entries = existsSync(directory) ? readdirSync(directory, { withFileTypes: true })
    .filter(file => file.isFile() && supported.test(file.name))
    .map(file => ({ id: randomUUID(), name: file.name, path: join(directory, file.name) })) : [];
  save(entries);
  return entries;
}
function publicList(entries: Entry[]) {
  return { entries: entries.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) };
}
let playing = false;
export function registerAudioHandlers(): void {
  ipcMain.handle(IPC.audio.list, () => publicList(load()));
  ipcMain.handle(IPC.audio.add, async () => {
    const result = await dialog.showOpenDialog({ title: "Add audio to library", properties: ["openFile", "multiSelections"],
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "flac", "m4a", "aac"] }] });
    const entries = load();
    if (!result.canceled) {
      for (const path of result.filePaths) {
        if (supported.test(path) && !entries.some(entry => entry.path === path))
          entries.push({ id: randomUUID(), name: basename(path), path });
      }
      save(entries);
    }
    return publicList(entries);
  });
  ipcMain.handle(IPC.audio.remove, (_event, id: string) => {
    const entries = load().filter(entry => entry.id !== id);
    save(entries); // Library references only: never delete or alter source audio.
    return publicList(entries);
  });
  ipcMain.handle(IPC.audio.play, async (_event, req: { vehicleId: string; audioId: string }) => {
    if (playing) throw new Error("Audio is already playing. Wait for it to finish.");
    const vehicle = registry.get(req.vehicleId);
    if (vehicle?.sensorBoardRevision !== "1.3" || !vehicle.camera) throw new Error("Select a connected v1.3 sensor-board robot.");
    const entry = load().find(item => item.id === req.audioId);
    if (!entry || !existsSync(entry.path)) throw new Error("Audio file is missing. Remove the entry and add the file again.");
    const endpoint = new URL("/speaker-pcm", vehicle.camera.baseUrl);
    endpoint.port = "82";
    if (endpoint.protocol !== "http:") throw new Error("Speaker playback requires HTTP.");
    playing = true;
    try { await playSpeakerFile(endpoint, entry.path); }
    finally { playing = false; }
  });
}
