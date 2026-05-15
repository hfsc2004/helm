# Serial

USB / serial port enumeration. Cross-platform, no extra dependencies.

## Verbatim from PSF Core

`gateway-adapters.js` is imported verbatim from PSF Core's `moe-gateway-adapters` module. It enumerates serial devices on Linux (via `/dev/serial/by-id/` symlinks + `/dev/tty{USB,ACM,...}` fallback) and macOS (via `/dev/cu.*`, `/dev/tty.*`). Windows is a no-op stub for now.

Each result includes a `boardHint` (`raspberry-pi-pico`, `esp32`, or empty) inferred from the device's USB descriptor / device path.

**Do not modernize this file.** Same policy as `core/hardware/` and `core/bmoc/`. If you find a real bug, fix it in place.

## TypeScript surface

`index.ts` exposes typed `listSerialPorts()` and `resolveSerialPort()`. The rest of Helm imports from here, never directly from the `.js`.

## What this branch ships

Discovery only. `helm serial-list` returns the JSON; the UI can show it. **No driving of serial devices yet** — that's a vehicle-adapter problem and lands in a follow-up branch when we add `core/vehicles/ground-pico-serial.ts` (or similar).
