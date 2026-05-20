import { ipcMain, BrowserWindow } from "electron";

import { IPC } from "../../shared/ipc-channels.js";
import type {
  DriveRequest,
  DriveStreamEvent,
  FlashStartRequest,
  FlashStreamEvent,
  FlashTemplateSummary,
  StateStreamEvent,
  StateStreamRequest,
  VehicleAddRequest,
  VehicleCmdRequest,
  VehicleRemoveRequest,
  VehicleCameraSnapshotRequest,
  VehicleCameraSnapshotResponse,
  VehicleCameraStreamOpenRequest,
  VehicleSetAudioRequest,
  VehicleSetCameraRequest,
  VehicleSetDriveRequest,
  VehicleSetFlashConfigRequest,
  VehicleSetWifiRequest,
  VehicleStopRequest,
} from "../../shared/ipc-channels.js";
import type {
  DriveFlashConfig,
  VideoFlashConfig,
} from "../../shared/vehicle-contract.js";

import * as registry from "../../core/vehicles/registry.js";
import * as adapter from "../../core/vehicles/ground-skidsteer.js";
import * as cameraStream from "../../core/vehicles/camera-stream.js";
import * as ollamaManager from "../../core/llm/ollama/manager.js";
import { plan, DEFAULT_PLANNER_MODEL } from "../../core/llm/planner.js";
import { listSerialPorts } from "../../core/serial/index.js";
import {
  detectHardware,
  classifyForInference,
  selectNvidiaGpu,
} from "../../core/hardware/index.js";
import {
  flash,
  listTemplates as listFlashTemplates,
} from "../../core/firmware-flash/index.js";
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

  ipcMain.handle(IPC.vehicle.add, async (_e, req: VehicleAddRequest) => {
    try {
      const v = registry.add({
        name: req.name,
        host: req.host,
        port: req.port,
        kind: req.kind,
      });
      return { ok: true, vehicle: v };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(IPC.vehicle.remove, async (_e, req: VehicleRemoveRequest) => {
    const removed = registry.remove(req.vehicleId);
    return removed
      ? { ok: true }
      : { ok: false, error: `no vehicle ${req.vehicleId}` };
  });

  ipcMain.handle(IPC.vehicle.setCamera, async (_e, req: VehicleSetCameraRequest) => {
    const updated = registry.setCamera(req.vehicleId, req.camera);
    return updated
      ? { ok: true, vehicle: updated }
      : { ok: false, error: `no vehicle ${req.vehicleId}` };
  });

  ipcMain.handle(IPC.vehicle.setAudio, async (_e, req: VehicleSetAudioRequest) => {
    const updated = registry.setAudio(req.vehicleId, req.audio);
    return updated
      ? { ok: true, vehicle: updated }
      : { ok: false, error: `no vehicle ${req.vehicleId}` };
  });

  ipcMain.handle(IPC.vehicle.setDrive, async (_e, req: VehicleSetDriveRequest) => {
    const updated = registry.setDrive(req.vehicleId, req.drive);
    return updated
      ? { ok: true, vehicle: updated }
      : { ok: false, error: `no vehicle ${req.vehicleId}` };
  });

  ipcMain.handle(IPC.vehicle.setWifi, async (_e, req: VehicleSetWifiRequest) => {
    const updated = registry.setWifi(req.vehicleId, req.board, req.wifi);
    return updated
      ? { ok: true, vehicle: updated }
      : { ok: false, error: `no vehicle ${req.vehicleId}` };
  });

  ipcMain.handle(IPC.vehicle.setFlashConfig, async (_e, req: VehicleSetFlashConfigRequest) => {
    const updated =
      req.board === "drive"
        ? registry.setFlash(req.vehicleId, "drive", req.flash as DriveFlashConfig | null)
        : registry.setFlash(req.vehicleId, "video", req.flash as VideoFlashConfig | null);
    return updated
      ? { ok: true, vehicle: updated }
      : { ok: false, error: `no vehicle ${req.vehicleId}` };
  });

  // ---------- camera stream cache ----------
  //
  // Renderer holds a long-lived handle for the lifetime of the Drive view.
  // Other in-process consumers (CLI helpers, future planner) acquire
  // additional handles. The first acquire opens one upstream connection
  // to /stream; subsequent acquires share it. The Elegoo / esp32-camera
  // firmware can only serve one HTTP client at a time, so this is the
  // only safe pattern.

  const cameraConsumers = new Map<string, { release: () => Promise<void> }>();

  function consumerId(): string {
    return `cam_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  ipcMain.handle(
    IPC.vehicle.cameraStreamOpen,
    async (event, req: VehicleCameraStreamOpenRequest) => {
      const vehicle = registry.get(req.vehicleId);
      if (!vehicle) throw new Error(`no vehicle ${req.vehicleId}`);
      const handle = cameraStream.acquire(vehicle);
      if (!handle) throw new Error(`vehicle ${req.vehicleId} has no camera configured`);
      const id = consumerId();
      cameraConsumers.set(id, { release: () => handle.release() });

      // Auto-release if the renderer window closes without telling us.
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        win.once("closed", () => {
          const entry = cameraConsumers.get(id);
          if (entry) {
            cameraConsumers.delete(id);
            void entry.release().catch(() => undefined);
          }
        });
      }
      return { consumerId: id, vehicleId: req.vehicleId };
    }
  );

  ipcMain.handle(IPC.vehicle.cameraStreamClose, async (_e, consumerIdArg: string) => {
    const entry = cameraConsumers.get(consumerIdArg);
    if (!entry) return { closed: false };
    cameraConsumers.delete(consumerIdArg);
    await entry.release();
    return { closed: true };
  });

  ipcMain.handle(
    IPC.vehicle.cameraSnapshot,
    async (_e, req: VehicleCameraSnapshotRequest): Promise<VehicleCameraSnapshotResponse> => {
      const vehicle = registry.get(req.vehicleId);
      if (!vehicle) return { ok: false, error: `no vehicle ${req.vehicleId}` };
      if (!vehicle.camera) {
        return { ok: false, error: "vehicle has no camera sidecar configured" };
      }
      const timeoutMs = Math.max(100, req.timeoutMs ?? 8000);

      // Preferred path: the renderer already has a stream open. Reuse it.
      const existing = cameraStream.peek(vehicle.id);
      if (existing) {
        const handle = cameraStream.acquire(vehicle);
        if (!handle) {
          return { ok: false, error: "failed to acquire camera stream handle" };
        }
        try {
          const frame = await handle.waitForFirstFrame(timeoutMs);
          return {
            ok: true,
            base64: Buffer.from(frame.bytes).toString("base64"),
            bytes: frame.bytes.length,
            contentType: frame.contentType,
            capturedAt: frame.capturedAt,
            source: "cache",
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        } finally {
          await handle.release();
        }
      }

      // Fallback: nothing's holding the stream right now (no Drive view
      // open). Hit /capture directly. Same code path that the standalone
      // CLI uses when no main process is around.
      const base = vehicle.camera.baseUrl.replace(/\/$/, "");
      const path = vehicle.camera.snapshotPath ?? "/capture";
      const url = `${base}${path}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: "GET", signal: ac.signal });
        if (!res.ok) {
          return { ok: false, error: `camera returned HTTP ${res.status} at ${url}` };
        }
        const contentType = res.headers.get("content-type") ?? "image/jpeg";
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          ok: true,
          base64: buf.toString("base64"),
          bytes: buf.length,
          contentType,
          capturedAt: Date.now(),
          source: "direct",
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    }
  );

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
    // Default 2000ms. The drive board is a single-threaded ESP32 — at the
    // old 500ms cadence, telemetry polls competed with /cmd hold-drive
    // pulses (180–250ms) for the firmware's HTTP loop and pushed round-trip
    // times into hundreds of ms. The state readout doesn't need >0.5Hz.
    const intervalMs = Math.max(100, req.intervalMs ?? 2000);
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

  // ---------- serial (one-shot) ----------
  ipcMain.handle(IPC.serial.list, async () => {
    return { ports: listSerialPorts() };
  });

  // ---------- hardware (one-shot) ----------
  ipcMain.handle(IPC.hardware.detect, async () => {
    const hw = await detectHardware(process.cwd());
    const classification = classifyForInference(hw);
    const nvidiaSelection =
      classification.accelerationType === "nvidia"
        ? selectNvidiaGpu(classification)
        : null;
    return { hardware: hw, classification, nvidiaSelection };
  });

  // ---------- ollama (one-shot) ----------
  ipcMain.handle(IPC.ollama.status, async () => {
    return ollamaManager.status();
  });

  // ---------- flash (one-shot: list) ----------
  ipcMain.handle(IPC.flash.listTemplates, async () => {
    const templates: FlashTemplateSummary[] = listFlashTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      target: t.target,
      fqbn: t.fqbn,
      vehicleKind: t.vehicleKind,
      vars: t.vars.map((v) => ({
        key: v.key,
        type: v.type,
        required: v.required,
        default: v.default,
        label: v.label,
      })),
    }));
    return { templates };
  });

  // ---------- flash (long-lived → BMOC session) ----------
  ipcMain.handle(IPC.flash.start, async (event, req: FlashStartRequest) => {
    const senderId = `window-${event.sender.id}`;

    // Filled in by the flash() call below. The subscription's closer pulls
    // .cancel through this slot so closeByStreamId actually kills the
    // arduino-cli child.
    const controller: { cancel: () => void } = { cancel: () => undefined };

    const handle = openSubscription({
      kind: "flash",
      consumerId: senderId,
      metadata: {
        templateId: req.templateId,
        port: req.port,
        dryRun: req.dryRun === true,
      },
      closer: () => {
        controller.cancel();
      },
    });

    const channel = IPC.flash.eventPrefix + handle.info.streamId;
    const send = (payload: FlashStreamEvent) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send(channel, payload);
    };

    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.once("closed", () => {
        void handle.close();
      });
    }

    // Run the flash in the background; resolve the open call immediately so
    // the renderer can attach its listener before the first event fires.
    void (async () => {
      try {
        await flash(
          {
            templateId: req.templateId,
            port: req.port,
            vars: req.vars,
            dryRun: req.dryRun === true,
            board: req.board,
            fqbnOverride: req.fqbnOverride,
            buildProperties: req.buildProperties,
            eraseBeforeUpload: req.eraseBeforeUpload,
            captureRuntimeSerialMs: req.captureRuntimeSerialMs,
            monitorBaudRate: req.monitorBaudRate,
          },
          (ev) => {
            send({ streamId: handle.info.streamId, ...ev });
          },
          controller
        );
      } catch (err) {
        send({
          streamId: handle.info.streamId,
          stage: "error",
          message: "flash threw",
          reason: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await handle.close();
      }
    })();

    return handle.info;
  });

  ipcMain.handle(IPC.flash.cancel, async (_e, streamId: string) => {
    await closeByStreamId(streamId);
    return { closed: true };
  });
}
