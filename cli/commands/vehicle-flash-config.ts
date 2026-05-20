import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";
import type {
  BoardRole,
  DriveFlashConfig,
  VideoFlashConfig,
} from "../../shared/vehicle-contract.js";

const VALID_BOARDS: BoardRole[] = ["drive", "video"];

function parseBoard(value: unknown): BoardRole | { error: string } {
  const s = String(value ?? "").trim().toLowerCase();
  if (!VALID_BOARDS.includes(s as BoardRole)) {
    return { error: `--board must be one of: ${VALID_BOARDS.join(", ")}` };
  }
  return s as BoardRole;
}

type FlagsMap = Record<string, string | number | boolean>;

function flagBool(flags: FlagsMap, name: string): boolean | undefined {
  if (!(name in flags)) return undefined;
  const v = flags[name];
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return undefined;
}

function flagNumber(flags: FlagsMap, name: string): number | undefined {
  if (!(name in flags)) return undefined;
  const v = flags[name];
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const flashConfigSet: RuntimeCommand = {
  def: {
    name: "vehicle-flash-config-set",
    summary:
      "Set per-board flash params (FQBN, profile, library path, USB CDC, erase, runtime serial).",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id." },
    ],
    flags: [
      { name: "board", kind: "string", description: "Which board: drive | video." },
      { name: "fqbn", kind: "string", description: "Arduino FQBN (e.g. esp32:esp32:esp32 or esp32:esp32:esp32s3)." },
      // drive-only
      { name: "sketch-name", kind: "string", description: "(drive) Sketch name for compile staging." },
      { name: "compile-timeout-ms", kind: "number", description: "(drive) Compile timeout in ms." },
      { name: "upload-timeout-ms", kind: "number", description: "(drive) Upload timeout in ms." },
      { name: "monitor-baud", kind: "number", description: "(drive) Serial monitor baud rate." },
      // video-only
      { name: "board-profile", kind: "string", description: "(video) Board profile (e.g. elegoo-esp32s3-camera-v1)." },
      { name: "pin-profile", kind: "string", description: "(video) Camera pin profile override." },
      { name: "library-path", kind: "string", description: "(video) Alt esp32-camera library path." },
      { name: "usb-cdc-on-boot", kind: "boolean", description: "(video) Enable USB CDC on boot." },
      { name: "erase-before-upload", kind: "boolean", description: "(video) Erase flash before upload." },
      { name: "capture-runtime-serial", kind: "boolean", description: "(video) Capture serial after upload." },
      { name: "runtime-serial-capture-ms", kind: "number", description: "(video) ms to capture serial after upload." },
      { name: "sta-enabled", kind: "boolean", description: "(video) Join the LAN as STA (vs AP-only)." },
    ],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args, flags }) {
    const id = String(args["id"] ?? "").trim();
    if (!id) {
      emit({ error: "vehicle-flash-config-set requires <id>." });
      return 64;
    }
    const board = parseBoard(flags["board"]);
    if (typeof board !== "string") {
      emit({ error: board.error });
      return 64;
    }
    const fqbn = String(flags["fqbn"] ?? "").trim();
    if (!fqbn) {
      emit({ error: "vehicle-flash-config-set requires --fqbn." });
      return 64;
    }

    if (board === "drive") {
      const cfg: DriveFlashConfig = {
        fqbn,
        sketchName: String(flags["sketch-name"] ?? "psf_helm_drive"),
      };
      const ct = flagNumber(flags, "compile-timeout-ms");
      if (ct !== undefined) cfg.compileTimeoutMs = ct;
      const ut = flagNumber(flags, "upload-timeout-ms");
      if (ut !== undefined) cfg.uploadTimeoutMs = ut;
      const baud = flagNumber(flags, "monitor-baud");
      if (baud !== undefined) cfg.monitorBaudRate = baud;
      const updated = registry.setFlash(id, "drive", cfg);
      if (!updated) {
        emit({ error: `No vehicle with id ${id}.` });
        return 1;
      }
      emit({ vehicle: updated });
      return 0;
    }

    // board === "video"
    const cfg: VideoFlashConfig = { fqbn };
    const profile = String(flags["board-profile"] ?? "").trim();
    if (profile) cfg.boardProfile = profile;
    const pin = String(flags["pin-profile"] ?? "").trim();
    if (pin) cfg.pinProfile = pin;
    const lib = String(flags["library-path"] ?? "").trim();
    if (lib) cfg.libraryPath = lib;
    const usb = flagBool(flags, "usb-cdc-on-boot");
    if (usb !== undefined) cfg.usbCdcOnBoot = usb;
    const erase = flagBool(flags, "erase-before-upload");
    if (erase !== undefined) cfg.eraseBeforeUpload = erase;
    const cap = flagBool(flags, "capture-runtime-serial");
    if (cap !== undefined) cfg.captureRuntimeSerial = cap;
    const capMs = flagNumber(flags, "runtime-serial-capture-ms");
    if (capMs !== undefined) cfg.runtimeSerialCaptureMs = capMs;
    const sta = flagBool(flags, "sta-enabled");
    if (sta !== undefined) cfg.staEnabled = sta;

    const updated = registry.setFlash(id, "video", cfg);
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

const flashConfigClear: RuntimeCommand = {
  def: {
    name: "vehicle-flash-config-clear",
    summary: "Remove the saved flash params for one board of a vehicle.",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id." },
    ],
    flags: [
      { name: "board", kind: "string", description: "Which board: drive | video." },
    ],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args, flags }) {
    const id = String(args["id"] ?? "").trim();
    if (!id) {
      emit({ error: "vehicle-flash-config-clear requires <id>." });
      return 64;
    }
    const board = parseBoard(flags["board"]);
    if (typeof board !== "string") {
      emit({ error: board.error });
      return 64;
    }
    const updated =
      board === "drive"
        ? registry.setFlash(id, "drive", null)
        : registry.setFlash(id, "video", null);
    if (!updated) {
      emit({ error: `No vehicle with id ${id}.` });
      return 1;
    }
    emit({ vehicle: updated });
    return 0;
  },
};

register(flashConfigSet);
register(flashConfigClear);
