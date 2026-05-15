import { app, BrowserWindow } from "electron";
import { join } from "node:path";

const isDev = !app.isPackaged;
const DEV_URL = "http://localhost:5173";

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
    // DevTools only when explicitly requested (HELM_DEVTOOLS=1).
    // F12 / Ctrl+Shift+I still toggles it on demand.
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
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
