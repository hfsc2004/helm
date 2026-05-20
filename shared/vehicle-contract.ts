/**
 * Vehicle contract — the shape of "a thing PSF Helm can control."
 *
 * Design notes:
 * - The data model is fleet-shaped from day one. The simple driver view
 *   renders fleets of size 1 without exposing fleet concepts in the UI.
 * - Vehicles declare their `kind` and `capabilities` so the UI and the
 *   LLM planner can adapt without hardcoding per-vehicle logic.
 * - `lossOfCommsBehavior` is informational at the app layer; firmware
 *   is responsible for actually enforcing it (deadman timer, RTH, etc.).
 * - The command shape is a tagged union per `Action`. Each vehicle's
 *   capabilities determine which actions it accepts.
 *
 * Dual-board layout (drive + video):
 * - `transport` is the *drive* board (typically an ESP32) — its own IP/port
 *   on the LAN, its own Wi-Fi creds in `wifi.drive`, its own flash params
 *   in `flash.drive`.
 * - `camera` is the *video* board (typically an ESP32-S3) — its own IP/port,
 *   its own creds in `wifi.video`, its own flash params in `flash.video`.
 * - The two boards run independently; either can be present without the
 *   other. The runtime endpoints (`transport`, `camera`) are what Helm
 *   talks to at drive time; `wifi.*` and `flash.*` are install-time config
 *   the user supplied so we can re-flash or document the vehicle later.
 */

export type VehicleKind = "ground" | "air";

export type VehicleCapability =
  | "drive.skidsteer"
  | "camera.mjpeg"
  | "audio.pcm"
  | "state.basic"
  | "fly.quad"; // future

export type CoordinateFrame =
  | "raw"
  | "body-velocity"
  | "local-ned"
  | "global";

export type LossOfCommsBehavior = "stop" | "hover" | "rth" | "land";

/** Which of a vehicle's two boards a given config block applies to. */
export type BoardRole = "drive" | "video";

export interface StaticIpConfig {
  ip: string;
  cidr: number;
  gatewayEnabled: boolean;
  gateway: string;
}

export interface WifiBoardConfig {
  ssid: string;
  password: string;
  /** Omit/null for DHCP. */
  static?: StaticIpConfig;
}

/** Flash-time params for the drive board (ESP32 classic). */
export interface DriveFlashConfig {
  fqbn: string;
  sketchName: string;
  compileTimeoutMs?: number;
  uploadTimeoutMs?: number;
  monitorBaudRate?: number;
}

/** Flash-time params for the video board (ESP32-S3 camera). */
export interface VideoFlashConfig {
  fqbn: string;
  /** e.g. "elegoo-esp32s3-camera-v1". Selects pin/sensor profile. */
  boardProfile?: string;
  /** Optional explicit override of camera pin profile. */
  pinProfile?: string;
  /** Path to an alternate esp32-camera library (advanced). */
  libraryPath?: string;
  usbCdcOnBoot?: boolean;
  eraseBeforeUpload?: boolean;
  /** Capture serial output for N ms after upload so the user can see the
   *  vehicle's first-boot logs (IP it acquired, sensor init, etc.). */
  captureRuntimeSerial?: boolean;
  runtimeSerialCaptureMs?: number;
  /** If false, the camera board acts only as an AP — it does not join the LAN. */
  staEnabled?: boolean;
}

/** Drive-side runtime tuning (lifted from core-ce Gateway Card "wifiDrive*"). */
export interface DriveTuning {
  /** Default forward/reverse speed magnitude (0..255). */
  speed: number;
  swapSides: boolean;
  invertLeft: boolean;
  invertRight: boolean;
  /** Maps incoming logical actions to the wire-level action the firmware expects.
   *  Some chassis are wired with flipped motors or rotated frames; this lets
   *  the user re-label without re-flashing. */
  map: {
    forward: DriveMapTarget;
    reverse: DriveMapTarget;
    left: DriveMapTarget;
    right: DriveMapTarget;
  };
  /** Show on-screen number controls in the driver view. */
  numControlsEnabled: boolean;
  /** Front-ultrasonic stop threshold, mm. 0 disables. */
  obstacleFrontThreshold: number;
  /** Autonomous "AI drive" loop config. Off by default; opt-in only. */
  aiDrive?: {
    enabled: boolean;
    agentId: string;
    objective: string;
    tickMs: number;
  };
}

export type DriveMapTarget =
  | "fwd"
  | "rev"
  | "turn_left"
  | "turn_right"
  | "stop";

export interface Vehicle {
  id: string;
  name: string;
  kind: VehicleKind;
  capabilities: VehicleCapability[];
  /** Drive board runtime endpoint. */
  transport: {
    host: string;
    port: number;
  };
  /** Optional camera sidecar (MJPEG / JPEG snapshot endpoints). */
  camera?: {
    /** e.g. "http://172.20.0.16:81" — without path. */
    baseUrl: string;
    /** Default "/stream". MJPEG multipart endpoint. */
    streamPath?: string;
    /** Default "/capture". One-shot JPEG endpoint. */
    snapshotPath?: string;
    /** Default "/health". Camera-board health probe. */
    flashStatusPath?: string;
  };
  /**
   * Optional audio sidecar (roving microphone — vehicle streams its own
   * I2S mic to Helm over chunked HTTP). Audio stays on the LAN; nothing
   * is uploaded anywhere.
   */
  audio?: {
    /** e.g. "http://172.20.0.17:82" — without path. */
    baseUrl: string;
    /** Default "/audio". Chunked PCM (16kHz mono 16-bit) over HTTP. */
    streamPath?: string;
  };
  /** Drive-side tuning. Optional — defaults applied client-side if absent. */
  drive?: DriveTuning;
  /** Per-board Wi-Fi credentials (install-time, used by the flash flow). */
  wifi?: {
    drive?: WifiBoardConfig;
    video?: WifiBoardConfig;
  };
  /** Per-board flash params (install-time, used by the flash flow). */
  flash?: {
    drive?: DriveFlashConfig;
    video?: VideoFlashConfig;
  };
  coordinateFrame: CoordinateFrame;
  lossOfCommsBehavior: LossOfCommsBehavior;
  addedAt: number;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type SkidSteerAction =
  | { kind: "stop" }
  | { kind: "fwd"; speed: number; durationMs?: number }
  | { kind: "rev"; speed: number; durationMs?: number }
  | { kind: "turn"; signed: number; durationMs?: number }
  | { kind: "tank"; left: number; right: number; durationMs?: number };

export type VehicleCommand = SkidSteerAction;

/**
 * Speed/turn values are clamped to [-255, 255] on the wire (matches the
 * firmware's MAX_SPEED guard). Durations clamp to [100, 5000] ms in line
 * with the deadman budget — bigger windows would let the firmware time out
 * mid-action.
 */
export const COMMAND_LIMITS = {
  speedMax: 255,
  speedMin: -255,
  durationMinMs: 100,
  durationMaxMs: 5000,
} as const;

export const DRIVE_TUNING_DEFAULTS: DriveTuning = {
  speed: 170,
  swapSides: false,
  invertLeft: false,
  invertRight: false,
  map: {
    forward: "fwd",
    reverse: "rev",
    left: "turn_left",
    right: "turn_right",
  },
  numControlsEnabled: true,
  obstacleFrontThreshold: 0,
};
