# Toolchains

Helm's private toolchains for flashing microcontrollers.

## Architectural rule

Like Helm's private Ollama, toolchains here are **isolated** — they don't share state with whatever the user has on their machine.

- **arduino-cli** runs against `<dataDir>/toolchains/arduino-cli/{config,data,downloads,user}` via `ARDUINO_*` env vars. It never reads or writes `~/.arduino15`.
- **mpremote** is detected from the user's system Python (no isolation needed; mpremote itself doesn't keep persistent state).

## Targets

| Toolchain | Used for | Status |
|---|---|---|
| `arduino-cli` | ESP32, ESP32-S3 (Arduino sketches) | Linux x64; downloads from downloads.arduino.cc |
| `mpremote` | Pi Pico, Pi Pico 2 (MicroPython) | Detect-only; user installs Python + `pip install mpremote` |

## What this layer does NOT do

It detects, installs, and resolves toolchain *commands*. It does not flash anything — that's the job of `core/firmware-flash/` (next branch).
