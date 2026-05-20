/**
 * Local control plane.
 *
 * A tiny HTTP server bound to 127.0.0.1 only — never the LAN. Lets the
 * standalone `helm` CLI (a separate Node process) talk to a running
 * Helm-UI's main process, so cross-process consumers can share the same
 * camera-stream cache, BMOC sessions, and registry view.
 *
 * Auth is a bearer token written into the OS-appropriate data dir (mode
 * 0600). The CLI reads the same file. No network exposure beyond loopback;
 * the token guards against another local user on the same host poking at
 * the endpoint.
 *
 * Started by the Electron main process on ready, stopped on quit, and
 * registered with BMOC so a crash still cleans up the listener.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

import * as bmoc from "../bmoc/index.js";
import { paths } from "../paths.js";
import * as registry from "../vehicles/registry.js";
import * as cameraStream from "../vehicles/camera-stream.js";

interface ControlPlaneDescriptor {
  /** Always 127.0.0.1. Recorded so the CLI doesn't have to guess. */
  host: string;
  port: number;
  token: string;
  /** PID of the Helm-UI main process that owns this control plane. */
  pid: number;
  startedAt: number;
  version: 1;
}

let server: Server | null = null;
let descriptor: ControlPlaneDescriptor | null = null;
let sessionId: string | null = null;

function writeDescriptor(d: ControlPlaneDescriptor): void {
  const path = paths.controlPlane();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(d, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600); // defensive — writeFileSync mode is umask-modified on some platforms
  } catch {
    // best-effort
  }
}

function removeDescriptor(): void {
  try {
    rmSync(paths.controlPlane(), { force: true });
  } catch {
    // best-effort
  }
}

function authOk(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  // Constant-time-ish compare. The token is high-entropy, so timing isn't
  // a meaningful attack surface here, but no reason to be sloppy.
  const presented = header.slice(7).trim();
  if (presented.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function handleSnapshot(
  res: ServerResponse,
  vehicleId: string,
  timeoutMs: number
): Promise<void> {
  const vehicle = registry.get(vehicleId) ?? registry.findByName(vehicleId);
  if (!vehicle) {
    json(res, 404, { ok: false, error: `no vehicle with id or name ${vehicleId}` });
    return;
  }
  if (!vehicle.camera) {
    json(res, 400, {
      ok: false,
      error: `vehicle ${vehicle.name} has no camera sidecar configured`,
    });
    return;
  }

  // Prefer the cached frame from the shared stream when something is
  // already holding /stream open (the Drive view, typically).
  const existing = cameraStream.peek(vehicle.id);
  if (existing) {
    const handle = cameraStream.acquire(vehicle);
    if (!handle) {
      json(res, 500, { ok: false, error: "failed to acquire camera stream handle" });
      return;
    }
    try {
      const frame = await handle.waitForFirstFrame(timeoutMs);
      res.writeHead(200, {
        "content-type": frame.contentType,
        "content-length": frame.bytes.length,
        "x-helm-snapshot-source": "cache",
        "x-helm-captured-at": String(frame.capturedAt),
        "x-helm-vehicle-id": vehicle.id,
        "x-helm-vehicle-name": vehicle.name,
      });
      res.end(Buffer.from(frame.bytes));
    } catch (err) {
      json(res, 502, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await handle.release();
    }
    return;
  }

  // No stream open — hit /capture directly.
  const base = vehicle.camera.baseUrl.replace(/\/$/, "");
  const path = vehicle.camera.snapshotPath ?? "/capture";
  const url = `${base}${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, { method: "GET", signal: ac.signal });
    if (!upstream.ok) {
      json(res, 502, {
        ok: false,
        error: `camera returned HTTP ${upstream.status} at ${url}`,
      });
      return;
    }
    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": buf.length,
      "x-helm-snapshot-source": "direct",
      "x-helm-captured-at": String(Date.now()),
      "x-helm-vehicle-id": vehicle.id,
      "x-helm-vehicle-name": vehicle.name,
    });
    res.end(buf);
  } catch (err) {
    json(res, 502, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

function route(req: IncomingMessage, res: ServerResponse, token: string): void {
  // Loopback-only check is enforced by the listen() bind below; refuse
  // anything non-127.0.0.1 just in case a future change to the bind slips.
  const remote = req.socket.remoteAddress ?? "";
  const isLoopback =
    remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLoopback) {
    json(res, 403, { ok: false, error: "loopback only" });
    return;
  }
  if (!authOk(req, token)) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/v1/health") {
    json(res, 200, { ok: true, pid: process.pid, startedAt: descriptor?.startedAt });
    return;
  }

  // GET /v1/vehicles/:idOrName/snapshot
  const snapMatch = url.pathname.match(/^\/v1\/vehicles\/([^/]+)\/snapshot$/);
  if (req.method === "GET" && snapMatch) {
    const idOrName = decodeURIComponent(snapMatch[1]!);
    const timeoutMs = Math.max(
      100,
      Math.min(60000, Number(url.searchParams.get("timeoutMs") ?? "8000"))
    );
    void handleSnapshot(res, idOrName, timeoutMs);
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/vehicles") {
    json(res, 200, { ok: true, vehicles: registry.list() });
    return;
  }

  json(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
}

/** Start the control plane. Idempotent — calling twice is a no-op. */
export async function start(): Promise<ControlPlaneDescriptor> {
  if (descriptor && server) return descriptor;

  const token = randomBytes(32).toString("hex");

  const srv = createServer((req, res) => {
    try {
      route(req, res, token);
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      srv.off("error", reject);
      resolve();
    });
  });

  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("control-plane listen returned no address");
  }

  descriptor = {
    host: "127.0.0.1",
    port: addr.port,
    token,
    pid: process.pid,
    startedAt: Date.now(),
    version: 1,
  };
  writeDescriptor(descriptor);
  sessionId = bmoc.registerSession({
    type: "control-plane",
    pid: process.pid,
    port: addr.port,
  });
  server = srv;
  return descriptor;
}

/** Stop the control plane, remove the descriptor file, close the BMOC session. */
export async function stop(): Promise<void> {
  const s = server;
  server = null;
  descriptor = null;
  if (s) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  if (sessionId) {
    const id = sessionId;
    sessionId = null;
    try {
      await bmoc.closeSession(id);
    } catch {
      // best-effort
    }
  }
  removeDescriptor();
}

export function getDescriptor(): ControlPlaneDescriptor | null {
  return descriptor;
}
