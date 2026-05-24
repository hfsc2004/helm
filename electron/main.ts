// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { app, BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as bmoc from "../core/bmoc/index.js";
import * as controlPlane from "../core/control-plane/server.js";
import { registerIpcHandlers } from "./ipc/index.js";

const isDev = !app.isPackaged;
const DEV_URL = "http://localhost:5173";

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0f1419",
    title: "PSF Helm",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox stays on in packaged builds (defense-in-depth against a
      // compromised renderer), but in dev we want native clipboard paste
      // in DevTools — sandbox blocks the synchronous clipboard path the
      // dev-tools context menu uses. The threat model doesn't apply when
      // the developer is the one typing into their own console.
      sandbox: !isDev,
    },
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
    if (process.env["HELM_DEVTOOLS"] === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

void app.whenReady().then(async () => {
  // Initialize BMOC first so anything spawned/registered later goes through it.
  bmoc.initialize(__dirname);
  registerIpcHandlers({ version: readVersion() });

  // Local control plane: bound to 127.0.0.1 only. Lets the standalone
  // `helm` CLI talk to this Helm-UI instance so cross-process consumers
  // (CLI snapshot, future planner calls) share the same camera cache.
  // Failure to start is non-fatal — the UI still works without it.
  try {
    const desc = await controlPlane.start();
    // eslint-disable-next-line no-console
    console.log(`[helm] control plane listening on 127.0.0.1:${desc.port}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[helm] control plane failed to start:",
      err instanceof Error ? err.message : err
    );
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", async (event) => {
  // Reap every BMOC-tracked session (subscriptions, child processes) before
  // the process exits.
  event.preventDefault();
  try {
    await controlPlane.stop();
  } catch {
    // best-effort
  }
  try {
    await bmoc.closeAllSessions();
  } catch {
    // Best effort; never block shutdown indefinitely.
  }
  app.exit(0);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
