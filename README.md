<div align="center">
  <img src="public/logo.png" alt="PSF Helm" width="360">
  <p><em>The natural-language helm for your robot — or your drone.</em></p>
</div>

PSF Helm is a local-first desktop app for controlling robots and drones. Talk to your vehicle in plain English, click a D-pad, or send direct commands — the planning runs on your own machine through your own LLM, the firmware runs on your own microcontroller, and nothing leaves your network unless you ask it to.

Cross-platform target: Linux, macOS, Windows. Linux x64 is what currently works end-to-end.

## Status

Working end-to-end on Linux x64:

- ✅ Drive an ESP32 skid-steer truck over WiFi (CLI and UI)
- ✅ Plan commands from natural language via a local LLM (Ollama, isolated)
- ✅ Download HF models with HF-token support, register them with Ollama
- ✅ Detect USB/serial devices (Pi Pico, Pico 2, ESP32, ESP32-S3) and host GPUs
- ✅ Manage the arduino-cli + mpremote toolchains
- ✅ Compile + upload sketch templates with strict variable validation
- 🚧 In progress: UI for the flashing flow, Pico/mpremote flash backend, voice install/runtime, packaging, macOS/Windows ports

## Quick start

```bash
# One-time
./install/RUN_ONCE_MAC_LINUX.sh

# Desktop app
./start.sh

# CLI (same logic, different surface)
npm run helm -- describe        # full machine-readable command schema
npm run helm -- version
```

## Two surfaces, one core

PSF Helm exposes the same logic two ways:

- **`helm-ui`** — Electron desktop app. Two tabs: **Drive** (camera, STOP, intent bar, D-pad, live state, activity log) and **Devices** (USB/serial enumeration, GPU info, Ollama status). Launch with `./start.sh` or `npm run helm-ui`.
- **`helm`** — CLI. Agent-first: structured JSON output by default, NDJSON event streams, distinct exit codes, `helm describe` emits the full command schema for introspection. Run with `npm run helm -- <command>`.

Both surfaces consume `core/` — neither owns business logic.

## End-to-end: drive a truck by talking to it

```bash
# 1. Register the truck (ESP32 firmware in firmware/ground-skidsteer/, on your WiFi)
npm run helm -- vehicle-add 172.20.0.15 --name truck-01

# 2. Install + start Helm's private Ollama (port 52450, isolated from any system Ollama)
npm run helm -- ollama-install --confirm
npm run helm -- ollama-start

# 3. Download the default vision model (any .gguf works; this is the recommended one)
npm run helm -- model-download \
  https://huggingface.co/unsloth/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf \
  --name qwen2.5-vl-7b

# 4. Drive
npm run helm -- drive truck-01 "go forward 2 seconds"
npm run helm -- drive truck-01 "turn left then stop"

# Or drive directly (no LLM)
npm run helm -- cmd truck-01 fwd --speed 160 --ms 2000
npm run helm -- stop truck-01

# Live state stream
npm run helm -- state truck-01 --follow
```

Or do all of that from the desktop app.

## What lives where

```
core/
  bmoc/             process + IPC-subscription lifecycle authority
  vehicles/         per-vehicle adapters + registry; ground-skidsteer adapter today
  llm/              private Ollama isolation, planner, prompts
  download/         HF-aware model downloader + GGUF wrap-for-Ollama
  hardware/         GPU detection (NVIDIA headless-first selection, Apple Silicon, etc.)
  serial/           USB / serial enumeration with board hints (pico, esp32, ...)
  toolchains/       arduino-cli + mpremote install + isolated env
  firmware-flash/   sketch template loader, validator, compile + upload
  voice/            optional whisper.cpp + piper engines (scaffolded; install pending)
  storage/          centralized disk-write caps; nothing on disk grows unbounded
  paths.ts          OS-appropriate data + config dirs
  privacy.ts        machine-readable privacy posture; powers `helm privacy`
  schema.ts         introspectable command schema; powers `helm describe`
  secrets.ts        .env-backed token store (mode 0600)

cli/                helm CLI: commands as registered modules
electron/           Electron main process + preload + IPC handlers
src/                Svelte renderer (Driver view, Devices view, components, stores)
shared/             types used by every surface (vehicle contract, IPC channels, llm)
firmware/           ESP32 / microcontroller sketches
  ground-skidsteer/ truck firmware (current)
  templates/        templated sketches with {{var}} placeholders
  raw-from-core-ce/ unconverted PSF Core sketches awaiting templatization
install/            one-time dependency installers
public/             static assets (logo, etc.)
docs/               design notes, conversion-todo, mockups
```

Each non-trivial subsystem has its own `README.md` documenting its rules and design.

## Devices tab

Bench surface for inspecting and configuring hardware:

- **USB / Serial** — live list of attached microcontrollers with friendly board hints (Raspberry Pi Pico, ESP32, etc.)
- **Inference hardware** — detected GPUs with the headless-first NVIDIA selection (a P4 dedicated to inference wins over an M5000 driving the desktop, automatically)
- **LLM backend** — private Ollama install state, port, models dir, disk used

The next iteration adds a **"Program…"** button per detected board, opening a template picker + variable form + live flash progress. The CLI surface for that already works:

```bash
npm run helm -- toolchain-status              # what's available (arduino-cli, mpremote)
npm run helm -- flash-templates               # what we can program
npm run helm -- flash-render --template ground-skidsteer-esp32 \
  --var "wifi.ssid=MyNet,wifi.password=secret"  # render only; inspect
npm run helm -- flash /dev/ttyUSB0 \
  --template ground-skidsteer-esp32 \
  --var "wifi.ssid=MyNet,wifi.password=secret"  # full compile + upload
```

## Bring your own model

Any llama.cpp-compatible `.gguf` works. Drop the URL into `helm model-download` and Helm fetches it, verifies it, and registers it with the private Ollama via blob upload + Modelfile creation. HF token (for gated models) lives in `.env`, mode 0600, sent only to `huggingface.co` as Bearer auth, never echoed.

| Recommended starter | Size | Vision? | Gated? |
|---|---|---|---|
| [Qwen2.5-VL-7B-Instruct (Q4_K_M)](https://huggingface.co/unsloth/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf?download=true) | ~4.7 GB | Yes | No |
| [Gemma 3 4B Instruct (Q4_0 QAT)](https://huggingface.co/google/gemma-3-4b-it-qat-q4_0-gguf/resolve/main/gemma-3-4b-it-q4_0.gguf?download=true) | ~3 GB | Yes | Yes (HF account + Gemma TOS) |

Both are vision-capable (the agent will eventually be able to see the camera feed). Vision is idle until wired into the planner — costs nothing today.

## Supported vehicles

| Vehicle | Status |
|---|---|
| ESP32 skid-steer ground robot (HTTP/WiFi) | Driving end-to-end |
| ESP32 obstacle-avoidance autonomous variants | Sketches imported, not yet templated |
| Elegoo ESP32-S3 camera sidecar | Sketch imported, not yet templated (license review pending) |
| ESP32-S3 + Pico 2 quadcopter (with SNN/STDP flight control) | Planned |

## Design principles

- **Local-first.** No cloud accounts. No analytics. Your robot, your laptop, your network. The few opt-in outbound destinations are documented below.
- **Two surfaces over one core.** The CLI and the UI are peers. Either can do anything the other can.
- **Vehicle-neutral.** Ground robots first; drones and other vehicles slot in by adding a `core/vehicles/<kind>.ts` adapter and a `target` value, not by rewriting anything.
- **Safety by default.** Firmware deadman timer (800 ms on the truck), strict app-side command bounds, always-visible STOP. Validators reject malformed model output rather than guessing at it.
- **One authority for child processes.** Everything Helm spawns (Ollama, arduino-cli, mpremote, future voice engines, flash subprocesses) registers with BMOC. App-quit reaps every child. No orphans.
- **One authority for IPC subscriptions.** Long-lived streams (state, drive lifecycle) are sessions too. Window-close reaps them.
- **Bring your own model.** Any `.gguf`. No vendor lock-in.
- **Cap everything on disk.** No category of stored data grows unbounded.

## Requirements

- Node.js LTS (22.x or newer recommended)
- Linux x64 today; macOS and Windows in the next round of polish
- For the Drive view: a vehicle on your local WiFi (the ESP32 truck firmware is in `firmware/ground-skidsteer/`)
- For the planner: any HF-hosted `.gguf` model (Qwen2.5-VL-7B recommended)
- For the Devices flash flow: arduino-cli (Helm installs it on demand) for ESP32 / ESP32-S3; Python 3 + `pip install mpremote` for Pi Pico / Pico 2

## License

Apache-2.0 (planned). See `LICENSE`.

## Family

PSF Helm is part of the PSF product family alongside [PSF Core](https://github.com/hfsc2004/) and other tools. Helm is the consumer-facing driving app; the larger industrial orchestration platform lives elsewhere.

## What PSF Helm does NOT do

Nothing in PSF Helm phones home. No analytics, no error reporting, no user tracking, no cloud accounts. Vehicle state ("telemetry" in robotics terminology) refers to data the *vehicle* reports about itself — battery voltage, motor speed, signal strength — and stays on your machine. 🐤

Voice (when implemented) will run locally via whisper.cpp + piper. Audio is never transmitted; transcription happens on your machine and the audio is discarded after the command runs. 🐤

Helm makes outbound network connections only to opt-in destinations, only when you trigger them. The current list (also available as JSON via `helm privacy`):

| Host | Purpose | Triggered by |
|---|---|---|
| `ollama.com` | Helm's private Ollama binary install | `helm ollama-install --confirm` |
| `github.com` | Voice engine binaries (when voice ships) | `helm voice-install --confirm` |
| `huggingface.co` | Model `.gguf` downloads (HF token sent only here, only as Bearer auth) | `helm model-download <url>` |
| `downloads.arduino.cc` | arduino-cli toolchain install | `helm toolchain-install --target arduino-cli --confirm` |

If a future version ever adds any other outbound network traffic, it will be opt-in and documented prominently. 🐤

---

<sub>Copyright © 2026 Pseudo Science Fiction</sub>
