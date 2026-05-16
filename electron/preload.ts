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
  vehicleAdd: "vehicle:add",
  vehicleRemove: "vehicle:remove",
  vehicleSetCamera: "vehicle:set-camera",
  vehicleSetAudio: "vehicle:set-audio",
  vehicleCmd: "vehicle:cmd",
  vehicleStop: "vehicle:stop",
  vehicleStreamStateOpen: "vehicle:stream-state-open",
  vehicleStreamStateClose: "vehicle:stream-state-close",
  vehicleStreamEventPrefix: "vehicle:stream-event:",
  vehicleDriveOpen: "vehicle:drive-open",
  vehicleDriveClose: "vehicle:drive-close",
  vehicleDriveEventPrefix: "vehicle:drive-event:",
  serialList: "serial:list",
  hardwareDetect: "hardware:detect",
  ollamaStatus: "ollama:status",
};

const api = {
  app: {
    getVersion: () => ipcRenderer.invoke(CH.appGetVersion),
  },
  vehicle: {
    list: () => ipcRenderer.invoke(CH.vehicleList),
    add: (req: unknown) => ipcRenderer.invoke(CH.vehicleAdd, req),
    remove: (req: unknown) => ipcRenderer.invoke(CH.vehicleRemove, req),
    setCamera: (req: unknown) => ipcRenderer.invoke(CH.vehicleSetCamera, req),
    setAudio: (req: unknown) => ipcRenderer.invoke(CH.vehicleSetAudio, req),
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
    drive: async (req: unknown, onEvent: (e: unknown) => void) => {
      const handle = (await ipcRenderer.invoke(CH.vehicleDriveOpen, req)) as {
        streamId: string;
        bmocSessionId: string;
      };
      const channel = CH.vehicleDriveEventPrefix + handle.streamId;
      const listener = (_event: unknown, payload: unknown) => onEvent(payload);
      ipcRenderer.on(channel, listener);
      return {
        handle,
        stop: async () => {
          ipcRenderer.removeListener(channel, listener);
          await ipcRenderer.invoke(CH.vehicleDriveClose, handle.streamId);
        },
      };
    },
  },
  serial: {
    list: () => ipcRenderer.invoke(CH.serialList),
  },
  hardware: {
    detect: () => ipcRenderer.invoke(CH.hardwareDetect),
  },
  ollama: {
    status: () => ipcRenderer.invoke(CH.ollamaStatus),
  },
};

contextBridge.exposeInMainWorld("helm", api);
