import { ipcMain, BrowserWindow } from "electron";

import { IPC } from "../../shared/ipc-channels.js";
import type {
  DriveRequest,
  DriveStreamEvent,
  StateStreamEvent,
  StateStreamRequest,
  VehicleCmdRequest,
  VehicleStopRequest,
} from "../../shared/ipc-channels.js";

import * as registry from "../../core/vehicles/registry.js";
import * as adapter from "../../core/vehicles/ground-skidsteer.js";
import * as ollamaManager from "../../core/llm/ollama/manager.js";
import { plan, DEFAULT_PLANNER_MODEL } from "../../core/llm/planner.js";
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

  // ---------- vehicle drive (long-lived → BMOC session) ----------
  ipcMain.handle(IPC.vehicle.driveOpen, async (event, req: DriveRequest) => {
    const vehicle = registry.get(req.vehicleId);
    if (!vehicle) {
      throw new Error(`no vehicle ${req.vehicleId}`);
    }
    const senderId = `window-${event.sender.id}`;
    let cancelled = false;

    const handle = openSubscription({
      kind: "drive",
      consumerId: senderId,
      metadata: { vehicleId: req.vehicleId, intent: req.intent.slice(0, 80) },
      closer: () => {
        cancelled = true;
      },
    });

    const channel = IPC.vehicle.driveEventPrefix + handle.info.streamId;
    const send = (payload: DriveStreamEvent) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send(channel, payload);
    };

    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.once("closed", () => {
        void handle.close();
      });
    }

    // Run the lifecycle in the background; resolve the open call immediately
    // so the renderer can start listening.
    void (async () => {
      try {
        const planResult = await plan({
          vehicle,
          intent: req.intent,
          model: req.model ?? DEFAULT_PLANNER_MODEL,
          temperature: req.temperature ?? 0,
          retryOnInvalid: !req.noRetry,
        });
        if (cancelled) return;

        if (!planResult.ok) {
          send({
            streamId: handle.info.streamId,
            event: "validate",
            ok: false,
            reason: planResult.reason,
            raw: planResult.raw.slice(0, 500),
          });
          send({
            streamId: handle.info.streamId,
            event: "complete",
            ok: false,
            reason: planResult.reason,
          });
          await handle.close();
          return;
        }

        send({
          streamId: handle.info.streamId,
          event: "plan",
          command: planResult.command,
          modelUsed: planResult.modelUsed,
          attempts: planResult.attempts,
        });
        send({ streamId: handle.info.streamId, event: "validate", ok: true });

        if (req.dryRun) {
          send({
            streamId: handle.info.streamId,
            event: "complete",
            ok: true,
            dryRun: true,
          });
          await handle.close();
          return;
        }

        send({
          streamId: handle.info.streamId,
          event: "execute",
          command: planResult.command,
        });
        const ack = await adapter.sendCommand(vehicle, planResult.command);
        if (cancelled) return;
        send({
          streamId: handle.info.streamId,
          event: "complete",
          ok: ack.ok,
          ack,
        });
      } catch (err) {
        send({
          streamId: handle.info.streamId,
          event: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await handle.close();
      }
    })();

    return handle.info;
  });

  ipcMain.handle(IPC.vehicle.driveClose, async (_e, streamId: string) => {
    await closeByStreamId(streamId);
    return { closed: true };
  });

  // ---------- ollama (one-shot) ----------
  ipcMain.handle(IPC.ollama.status, async () => {
    return ollamaManager.status();
  });
}
