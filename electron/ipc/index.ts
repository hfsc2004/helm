import { ipcMain, BrowserWindow } from "electron";

import { IPC } from "../../shared/ipc-channels.js";
import type {
  StateStreamEvent,
  StateStreamRequest,
  VehicleCmdRequest,
  VehicleStopRequest,
} from "../../shared/ipc-channels.js";

import * as registry from "../../core/vehicles/registry.js";
import * as adapter from "../../core/vehicles/ground-skidsteer.js";
import * as ollamaManager from "../../core/llm/ollama/manager.js";
import {
  closeByStreamId,
  openSubscription,
} from "./subscriptions.js";

/**
 * IPC registration. Plain Electron — the dispatch is whatever Electron does.
 *
 * Long-lived streams open through openSubscription(), which registers them
 * with BMOC so shutdown reaps them. One-shot calls do not need that.
 */

export function registerIpcHandlers(opts: { version: string }): void {
  // ---------- app ----------
  ipcMain.handle(IPC.app.getVersion, async () => opts.version);

  // ---------- vehicle (one-shot) ----------
  ipcMain.handle(IPC.vehicle.list, async () => {
    return { vehicles: registry.list() };
  });

  ipcMain.handle(IPC.vehicle.cmd, async (_e, req: VehicleCmdRequest) => {
    const vehicle = registry.get(req.vehicleId);
    if (!vehicle) return { ok: false, error: `no vehicle ${req.vehicleId}` };
    try {
      const ack = await adapter.sendCommand(vehicle, req.action);
      return { ok: ack.ok, ack };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(IPC.vehicle.stop, async (_e, req: VehicleStopRequest) => {
    const vehicle = registry.get(req.vehicleId);
    if (!vehicle) return { ok: false, error: `no vehicle ${req.vehicleId}` };
    try {
      const ack = await adapter.emergencyStop(vehicle);
      return { ok: ack.ok, ack };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ---------- vehicle state stream (long-lived → BMOC session) ----------
  ipcMain.handle(IPC.vehicle.streamStateOpen, async (event, req: StateStreamRequest) => {
    const vehicle = registry.get(req.vehicleId);
    if (!vehicle) {
      throw new Error(`no vehicle ${req.vehicleId}`);
    }
    const intervalMs = Math.max(100, req.intervalMs ?? 500);
    const senderId = `window-${event.sender.id}`;

    let timer: ReturnType<typeof setInterval> | null = null;

    const handle = openSubscription({
      kind: "state-stream",
      consumerId: senderId,
      metadata: { vehicleId: req.vehicleId, intervalMs },
      closer: () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      },
    });

    const channel = IPC.vehicle.streamEventPrefix + handle.info.streamId;

    const tick = async () => {
      try {
        const state = await adapter.getState(vehicle);
        if (event.sender.isDestroyed()) {
          await handle.close();
          return;
        }
        const payload: StateStreamEvent = {
          streamId: handle.info.streamId,
          t: Date.now(),
          state: state as StateStreamEvent["state"],
        };
        event.sender.send(channel, payload);
      } catch (err) {
        if (!event.sender.isDestroyed()) {
          const payload: StateStreamEvent = {
            streamId: handle.info.streamId,
            t: Date.now(),
            state: null,
            error: err instanceof Error ? err.message : String(err),
          };
          event.sender.send(channel, payload);
        }
      }
    };

    // Kick the first reading immediately so the UI doesn't sit blank.
    void tick();
    timer = setInterval(() => void tick(), intervalMs);

    // Tear down when the renderer window goes away.
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.once("closed", () => {
        void handle.close();
      });
    }

    return handle.info;
  });

  ipcMain.handle(IPC.vehicle.streamStateClose, async (_e, streamId: string) => {
    await closeByStreamId(streamId);
    return { closed: true };
  });

  // ---------- ollama (one-shot) ----------
  ipcMain.handle(IPC.ollama.status, async () => {
    return ollamaManager.status();
  });
}
