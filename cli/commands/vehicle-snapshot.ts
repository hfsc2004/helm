import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { emit, log } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";

/**
 * Pull a single JPEG snapshot from a vehicle's camera sidecar.
 *
 * Hits the camera's /capture endpoint directly. NOTE: most ESP32-S3 camera
 * firmwares (esp32-camera, Elegoo) are single-threaded HTTP — if the
 * Helm-UI Drive view is open holding the /stream connection, /capture
 * will time out until the stream client disconnects. The right way to
 * snapshot while the UI is live is via the Electron IPC bridge
 * (`window.helm.vehicle.cameraSnapshot`), which siphons frames out of the
 * shared cache. The CLI is a standalone process and can't reach that
 * cache, so it falls back to /capture — works fine when Helm-UI is
 * closed.
 *
 * Default: writes the JPEG to `<cwd>/<slug>-<iso-timestamp>.jpg` and emits a
 * structured handle on stdout so an agent gets a path + size + content-type
 * without scraping stderr.
 *
 * Flags:
 *   --out <path>   write the JPEG to a specific path
 *   --base64       emit { base64, bytes, contentType } instead of writing
 *   --stdout       pipe the raw JPEG bytes to stdout, no JSON wrapping
 */

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "vehicle"
  );
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "Z");
}

function isoNow(): string {
  return new Date().toISOString();
}

const vehicleSnapshot: RuntimeCommand = {
  def: {
    name: "vehicle-snapshot",
    summary:
      "Fetch one JPEG frame from a vehicle's camera sidecar and either write it to disk, emit it as base64, or stream it on stdout.",
    args: [
      {
        name: "id",
        kind: "string",
        required: true,
        description: "Vehicle id (from vehicle-list) or vehicle name.",
      },
    ],
    flags: [
      {
        name: "out",
        kind: "string",
        description:
          "Path to write the JPEG. Default: <cwd>/<slug>-<iso-ts>.jpg. Ignored when --base64 or --stdout is set.",
      },
      {
        name: "base64",
        kind: "boolean",
        default: false,
        description: "Emit { base64, bytes, contentType } on stdout instead of writing a file.",
      },
      {
        name: "stdout",
        kind: "boolean",
        default: false,
        description: "Pipe the raw JPEG bytes to stdout. No JSON wrapping. Use with shell redirection.",
      },
      {
        name: "timeout-ms",
        kind: "number",
        default: 5000,
        description: "HTTP timeout for the snapshot fetch.",
      },
    ],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      2: COMMON_EXIT_CODES[2]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args, flags }) {
    const idOrName = String(args["id"] ?? "").trim();
    if (!idOrName) {
      emit({ error: "vehicle-snapshot requires <id>." });
      return 64;
    }
    const vehicle =
      registry.get(idOrName) ?? registry.findByName(idOrName);
    if (!vehicle) {
      emit({ error: `No vehicle with id or name ${idOrName}.` });
      return 1;
    }
    if (!vehicle.camera) {
      emit({
        error: `Vehicle ${vehicle.name} has no camera sidecar configured. Attach one with: helm vehicle-camera-set ${vehicle.id} http://<host>:<port>`,
      });
      return 1;
    }

    const base = vehicle.camera.baseUrl.replace(/\/$/, "");
    const path = vehicle.camera.snapshotPath ?? "/capture";
    const url = `${base}${path}`;

    const timeoutMs = Math.max(100, Number(flags["timeout-ms"] ?? 5000));
    const wantStdout = flags["stdout"] === true || flags["stdout"] === "true";
    const wantBase64 = flags["base64"] === true || flags["base64"] === "true";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let bytes: Buffer;
    let contentType: string;
    let httpStatus: number;
    try {
      const res = await fetch(url, { method: "GET", signal: controller.signal });
      httpStatus = res.status;
      if (res.status < 200 || res.status >= 300) {
        emit({
          ok: false,
          error: `Camera returned HTTP ${res.status} at ${url}`,
          httpStatus,
          url,
        });
        return 2;
      }
      contentType = res.headers.get("content-type") ?? "application/octet-stream";
      const arrayBuf = await res.arrayBuffer();
      bytes = Buffer.from(arrayBuf);
    } catch (err) {
      emit({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        url,
      });
      return 2;
    } finally {
      clearTimeout(timer);
    }

    if (wantStdout) {
      // Pipe raw bytes — no JSON wrapping. Status to stderr so an agent
      // redirecting stdout still sees what happened.
      process.stdout.write(bytes);
      log(
        `vehicle-snapshot: ${bytes.length} bytes (${contentType}) from ${url}`
      );
      return 0;
    }

    if (wantBase64) {
      emit({
        ok: true,
        vehicleId: vehicle.id,
        vehicleName: vehicle.name,
        url,
        bytes: bytes.length,
        contentType,
        capturedAt: isoNow(),
        base64: bytes.toString("base64"),
      });
      return 0;
    }

    // Default: write to disk.
    const explicitOut = String(flags["out"] ?? "").trim();
    const outPath = explicitOut
      ? isAbsolute(explicitOut)
        ? explicitOut
        : resolve(process.cwd(), explicitOut)
      : join(process.cwd(), `${slugify(vehicle.name)}-${timestamp()}.jpg`);
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, bytes);
    } catch (err) {
      emit({
        ok: false,
        error: `Saved snapshot fetch but failed to write ${outPath}: ${err instanceof Error ? err.message : String(err)}`,
        url,
        bytes: bytes.length,
      });
      return 2;
    }

    emit({
      ok: true,
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      url,
      path: outPath,
      bytes: bytes.length,
      contentType,
      capturedAt: isoNow(),
    });
    return 0;
  },
};

register(vehicleSnapshot);
