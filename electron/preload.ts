import { contextBridge, ipcRenderer } from "electron";
import type { HelmAPI } from "../shared/ipc-channels.js";

const api: HelmAPI = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:get-version"),
  },
};

contextBridge.exposeInMainWorld("helm", api);
