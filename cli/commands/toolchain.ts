import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";

import {
  resolveArduinoCli,
  installArduinoCli,
  uninstallArduinoCli,
  arduinoCliPaths,
} from "../../core/toolchains/arduino-cli/index.js";
import { resolveMpremote } from "../../core/toolchains/mpremote/index.js";

const status: RuntimeCommand = {
  def: {
    name: "toolchain-status",
    summary:
      "Report which microcontroller toolchains are available (arduino-cli, mpremote).",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    const arduino = await resolveArduinoCli();
    const mpremote = await resolveMpremote();
    emit({
      arduinoCli: arduino
        ? {
            available: true,
            source: arduino.source,
            version: arduino.version,
            bin: arduino.bin,
          }
        : {
            available: false,
            hint: "Install with: helm toolchain-install --target arduino-cli --confirm",
            installPath: arduinoCliPaths.bin(),
          },
      mpremote: mpremote
        ? {
            available: true,
            source: mpremote.source,
            version: mpremote.version,
            bin: mpremote.bin,
          }
        : {
            available: false,
            hint: "Install Python 3 and run: pip install mpremote",
          },
    });
    return 0;
  },
};

const install: RuntimeCommand = {
  def: {
    name: "toolchain-install",
    summary:
      "Install a toolchain. arduino-cli is downloaded from downloads.arduino.cc; mpremote is detect-only and prints install instructions if missing.",
    args: [],
    flags: [
      {
        name: "target",
        kind: "string",
        description: "Toolchain to install: arduino-cli or mpremote.",
      },
      {
        name: "confirm",
        kind: "boolean",
        default: false,
        description: "Required for arduino-cli (network operation).",
      },
    ],
    streams: true,
    events: [
      { event: "fetch", description: "Download progress." },
      { event: "extract", description: "Tarball extraction." },
      { event: "verify", description: "Binary verification." },
      { event: "complete", description: "Install complete." },
    ],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ flags }) {
    const target = String(flags["target"] ?? "").trim();
    if (!target) {
      emit({ error: "toolchain-install requires --target arduino-cli or --target mpremote" });
      return 64;
    }

    if (target === "mpremote") {
      const found = await resolveMpremote();
      if (found) {
        emit({ event: "complete", target, ...found });
        return 0;
      }
      emit({
        event: "error",
        message:
          "mpremote not found. Install with: pip install mpremote (requires Python 3).",
      });
      return 1;
    }

    if (target !== "arduino-cli") {
      emit({ error: `unknown target: ${target}` });
      return 64;
    }

    if (flags["confirm"] !== true) {
      emit({
        error:
          "arduino-cli install is a network operation. Re-run with --confirm to download from downloads.arduino.cc.",
      });
      return 64;
    }

    try {
      const result = await installArduinoCli((event) => {
        emit({ event: event.stage, ...event });
      });
      emit({ event: "complete", target: "arduino-cli", result });
      return 0;
    } catch (err) {
      emit({
        event: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return 1;
    }
  },
};

const uninstall: RuntimeCommand = {
  def: {
    name: "toolchain-uninstall",
    summary: "Remove Helm's private arduino-cli install. mpremote is system-managed; not removed.",
    args: [],
    flags: [
      {
        name: "target",
        kind: "string",
        description: "Toolchain to uninstall (currently only arduino-cli).",
      },
      {
        name: "confirm",
        kind: "boolean",
        default: false,
        description: "Required to actually delete files.",
      },
    ],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]!, 64: COMMON_EXIT_CODES[64]! },
  },
  async run({ flags }) {
    const target = String(flags["target"] ?? "").trim();
    if (target !== "arduino-cli") {
      emit({ error: "toolchain-uninstall currently only supports --target arduino-cli" });
      return 64;
    }
    if (flags["confirm"] !== true) {
      emit({
        error:
          "toolchain-uninstall removes files. Re-run with --confirm.",
      });
      return 64;
    }
    const result = await uninstallArduinoCli();
    emit(result);
    return 0;
  },
};

register(status);
register(install);
register(uninstall);
