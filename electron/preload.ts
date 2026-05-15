import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload runs in a sandboxed context where only `electron` and `node:*`
 * built-ins are importable. Channel names are inlined here rather than
 * imported from shared/ipc-channels.ts (which is the source of truth on
 * both the main and renderer sides). Keep these constants in sync with
 * the IPC export in shared/ipc-channels.ts.
 */
const CH = {
  appGetVersion: "app:get-version",
  vehicleList: "vehicle:list",
  vehicleCmd: "vehicle:cmd",
  vehicleStop: "vehicle:stop",
  vehicleStreamStateOpen: "vehicle:stream-state-open",
  vehicleStreamStateClose: "vehicle:stream-state-close",
  vehicleStreamEventPrefix: "vehicle:stream-event:",
  ollamaStatus: "ollama:status",
};

const api = {
  app: {
    getVersion: () => ipcRenderer.invoke(CH.appGetVersion),
  },
  vehicle: {
    list: () => ipcRenderer.invoke(CH.vehicleList),
    cmd: (req: unknown) => ipcRenderer.invoke(CH.vehicleCmd, req),
    stop: (req: unknown) => ipcRenderer.invoke(CH.vehicleStop, req),
    streamState: async (req: unknown, onEvent: (e: unknown) => void) => {
      const handle = (await ipcRenderer.invoke(CH.vehicleStreamStateOpen, req)) as {
        streamId: string;
        bmocSessionId: string;
      };
      const channel = CH.vehicleStreamEventPrefix + handle.streamId;
      const listener = (_event: unknown, payload: unknown) => onEvent(payload);
      ipcRenderer.on(channel, listener);
      return {
        handle,
        stop: async () => {
          ipcRenderer.removeListener(channel, listener);
          await ipcRenderer.invoke(CH.vehicleStreamStateClose, handle.streamId);
        },
      };
    },
  },
  ollama: {
    status: () => ipcRenderer.invoke(CH.ollamaStatus),
  },
};

contextBridge.exposeInMainWorld("helm", api);
