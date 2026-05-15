/**
 * Serial subsystem — TypeScript surface over the verbatim Core-CE adapter.
 *
 * Verbatim source: gateway-adapters.js (from PSF Core's moe-gateway-adapters).
 * Cross-platform USB/serial enumeration with friendly board hints
 * (raspberry-pi-pico, esp32, etc.) by scanning /dev on Linux/macOS and
 * (currently no-op) on Windows.
 *
 * Helm uses this for serial discovery only in v0.1. The actual *driving*
 * of serial-attached vehicles (mpremote, raw REPL, etc.) lands in a later
 * branch when we add a serial vehicle adapter.
 */

const adapters = require("./gateway-adapters.js") as {
  listSerialPorts(): SerialPort[];
  resolveSerialPort(
    serialSource: { port?: string; baudRate?: number } | undefined,
    availablePorts?: SerialPort[] | null
  ): { resolvedPort: string; mode: "explicit" | "auto" | "none"; reason?: string };
};

export type SerialKind = "usb" | "virtual" | "serial";

export type BoardHint = "raspberry-pi-pico" | "esp32" | "";

export interface SerialPort {
  path: string;
  label: string;
  kind: SerialKind;
  boardHint: BoardHint;
}

export function listSerialPorts(): SerialPort[] {
  return adapters.listSerialPorts();
}

export function resolveSerialPort(
  serialSource?: { port?: string; baudRate?: number },
  availablePorts?: SerialPort[]
): { resolvedPort: string; mode: "explicit" | "auto" | "none"; reason?: string } {
  return adapters.resolveSerialPort(serialSource, availablePorts ?? null);
}
