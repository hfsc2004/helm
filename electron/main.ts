import { app, BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as bmoc from "../core/bmoc/index.js";
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
      sandbox: true,
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

void app.whenReady().then(() => {
  // Initialize BMOC first so anything spawned/registered later goes through it.
  bmoc.initialize(__dirname);
  registerIpcHandlers({ version: readVersion() });
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
    await bmoc.closeAllSessions();
  } catch {
    // Best effort; never block shutdown indefinitely.
  }
  app.exit(0);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
