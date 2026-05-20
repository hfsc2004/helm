<div align="center">
  <img src="public/logo.png" alt="PSF Helm" width="360">
  <p><em>The natural-language helm for your robot — or your drone.</em></p>
</div>

PSF Helm is a local-first desktop app for controlling robots and drones. Talk to your vehicle in plain English, click a D-pad, or send direct commands — the planning runs on your own machine through your own LLM, the firmware runs on your own microcontroller, and nothing leaves your network unless you ask it to.

Cross-platform target: Linux, macOS, Windows. Linux x64 is what currently works end-to-end.

## Status

Working end-to-end on Linux x64:

- ✅ Drive an ESP32 skid-steer truck over WiFi (CLI and UI)
- ✅ **Dual-board vehicles**: separate drive ESP32 + ESP32-S3 camera-and-video board, each with its own IP, Wi-Fi credentials, static-IP block, and flash params — mirrors the PSF Core Relay "Gateway Card" shape
- ✅ **Configure-and-flash from the UI**: click a detected board → pick a template → fill in Wi-Fi / camera params → flash with live arduino-cli output
- ✅ **Drive-tuning panel** per vehicle: action map (rotate intents 90/180° without re-flashing), swap-sides, invert-left/right
- ✅ **Three input devices** for driving: Keyboard WASD (with QEZC diagonals), Keyboard NumPad (8/4/2/6 + 7/9/1/3), or Game Controller (left-stick tank mix); pick from the Devices tab
- ✅ **Drive-speed slider** on the Drive view with +/- step buttons and keyboard shortcuts; live during a held drive
- ✅ Plan commands from natural language via a local LLM (Ollama, isolated)
- ✅ Download HF models with HF-token support, register them with Ollama
- ✅ Detect USB/serial devices (Pi Pico, Pico 2, ESP32, ESP32-S3) and host GPUs
- ✅ Manage the arduino-cli + mpremote toolchains
- ✅ Compile + upload sketch templates with strict variable validation (ground-skidsteer ESP32 + ESP32-S3 video camera)
- ✅ MJPEG camera sidecar — vehicle's S3 streams `/stream` / `/capture` / `/health` directly to the Drive view; nothing transits the cloud
- ✅ Shared camera-stream cache — one upstream connection per vehicle; the live UI and `helm vehicle-snapshot` see the same frames. Works around single-threaded ESP32 camera firmwares (which can only serve one HTTP client at a time)
- ✅ Loopback control plane on 127.0.0.1 — running Helm-UI exposes a token-authed local-only HTTP surface so the standalone `helm` CLI (and, eventually, an LLM agent) can siphon frames out of the live cache without fighting the camera for a connection
- ✅ Roving microphone sidecar — vehicle audio over chunked HTTP, played host-side
- 🚧 In progress: Pico/mpremote flash backend, voice install/runtime, native gamepad button remap, packaging, macOS/Windows ports

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

- **`helm-ui`** — Electron desktop app. Three tabs: **Drive** (camera, STOP, intent bar, input pad, speed slider, live state, activity log), **Vehicles** (per-vehicle cards with drive-tuning panel and sidecar config), and **Devices** (driver-input picker, USB/serial enumeration, GPU info, Ollama status). Launch with `./start.sh` or `npm run helm-ui`.
- **`helm`** — CLI. Agent-first: structured JSON output by default, NDJSON event streams, distinct exit codes, `helm describe` emits the full command schema for introspection. Every UI control has a matching CLI command. Run with `npm run helm -- <command>`.

Both surfaces consume `core/` — neither owns business logic.

## End-to-end: drive a truck by talking to it

```bash
# 1. Register the truck — drive ESP32 at .15, ESP32-S3 camera board at .16
npm run helm -- vehicle-add 172.20.0.15 --name truck-01
ID=$(npm run helm -- vehicle-list | jq -r '.vehicles[0].id')
npm run helm -- vehicle-camera-set $ID http://172.20.0.16:81

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

Or do all of that from the desktop app — Add Vehicle includes an optional "Video board (ESP32-S3)" section that wires the camera at create time.

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
                    (vehicle, vehicle-drive, vehicle-wifi, vehicle-flash-config,
                    vehicle-camera, vehicle-audio, flash, drive, state, ...)
electron/           Electron main process + preload + IPC handlers
src/                Svelte renderer
  components/       Numpad, Gamepad, SpeedSlider, CameraFeed, AudioFeed,
                    VehicleCard, AddVehicleDialog, IntentBar, ActivityLog, ...
  views/            DriverView, VehiclesView, DevicesView, ConfigureBoardView
  stores/           fleet, inputMode, driveSpeed, activity, devicesScreen, view
shared/             types used by every surface (vehicle contract, IPC channels, llm)
firmware/           ESP32 / microcontroller sketches
  ground-skidsteer/ drive-board firmware (current)
  templates/        templated sketches with {{var}} placeholders
    ground-skidsteer-esp32/  drive ESP32 + L298N
    video-esp32-s3/          ESP32-S3 camera streamer (3 pin profiles:
                             esp32s3_eye / ai_thinker_s3 / elegoo_s3)
  raw-from-core-ce/ unconverted PSF Core sketches awaiting templatization
install/            one-time dependency installers
public/             static assets (logo, etc.)
docs/               design notes, conversion-todo, mockups
```

Each non-trivial subsystem has its own `README.md` documenting its rules and design.

## Drive view

The Drive tab is what you use day-to-day:

- **Camera** — live MJPEG from the ESP32-S3 video board; nothing transits the cloud.
- **STOP** — always-visible; firmware-side deadman (800 ms) backs it up.
- **Input pad** — Numpad-style 3×3 grid that doubles as touch/click buttons. The keyboard half is gated by the input mode you picked in the Devices tab:
  - **Keyboard WASD** — W/A/S/D for cardinals, Q/E/Z/C for diagonals (all hold-drive). R = CW 180°. X = stop.
  - **Keyboard NumPad** — 8/4/2/6 for cardinals, 7/9/1/3 for diagonals. 5 = CW 180°. 0 = stop. Digit row 0–9 works too for laptops.
  - **Game Controller** — left stick (tank-mix, with deadzone). South button (A on Xbox / X on PS) = stop. North button (Y / △) = CW 180°.
- **Speed slider** — sets the PWM ceiling for fwd/rev/turn and the gamepad stick. `+`/`−` step by 10 (`=`/`-` keys, or the numpad `+`/`-`). Click the track or drag the thumb. Each vehicle seeds from its saved tuning so it starts at "its" speed.
- **Vehicle state** — left/right motor PWM, deadman age, Wi-Fi RSSI.
- **Activity log** — every intent, every wire-level command, every reject.

## Vehicles tab

Per-vehicle cards. Each one shows endpoint, capabilities, and sidecars (camera / mic) with inline add/edit. Expand **Drive tuning** for the action map (rotate intents 90/180° to match a rotated chassis without re-flashing), the default speed, swap-sides, and invert-left/right. A `customized` badge appears when the vehicle has any tuning saved.

## Devices tab

Bench surface for inspecting and configuring hardware:

- **Driver input** — pick Keyboard WASD / Keyboard NumPad / Game Controller. Saved across restarts via localStorage. Gamepad detection is live while the tab is open.
- **USB / Serial** — live list of attached microcontrollers with friendly board hints (Raspberry Pi Pico, ESP32, etc.). Click a detected board to open the **Configure Board** screen: template picker → board-type override (ESP32 drive / ESP32-S3 video / Pi Pico) → Wi-Fi + camera params → live flash output. Per-board flash params (FQBN override, `--build-property` for USB-CDC and pin profile, erase-before-upload, post-upload serial capture) are all exposed; the ESP32-S3 video template offers three pin profiles out of the box (`esp32s3_eye` / `ai_thinker_s3` / `elegoo_s3`).
- **Inference hardware** — detected GPUs with the headless-first NVIDIA selection (a P4 dedicated to inference wins over an M5000 driving the desktop, automatically).
- **LLM backend** — private Ollama install state, port, models dir, disk used.

The flash flow is also driveable from the CLI:

```bash
npm run helm -- toolchain-status              # what's available (arduino-cli, mpremote)
npm run helm -- flash-templates               # what we can program
npm run helm -- flash-render --template video-esp32-s3 \
  --var "wifi.ssid=MyNet,wifi.password=secret,camera.pinProfile=elegoo_s3"
npm run helm -- flash /dev/ttyACM0 \
  --template video-esp32-s3 \
  --var "wifi.ssid=MyNet,wifi.password=secret,wifi.staticIp=172.20.0.16" \
  --board video --erase --capture-runtime-serial-ms 20000
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
| ESP32-S3 camera sidecar (PSF-original streamer; 3 pin profiles) | Flash-ready, live MJPEG into Drive view |
| Dual-board truck (drive ESP32 + ESP32-S3 video, separate IPs) | Driving end-to-end |
| Roving microphone sidecar | Vehicle streams I2S mic to host, host-side playback |
| ESP32 obstacle-avoidance autonomous variants | Sketches imported, not yet templated |
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

Helm does also bind one **loopback-only** listener: when Helm-UI is running, it exposes a tiny HTTP control plane on `127.0.0.1` (ephemeral port, bearer-token authenticated, descriptor written to `<dataDir>/control-plane.json` mode `0600`). This is how the standalone `helm` CLI shares the camera cache with the live UI. Nothing on the LAN can reach it; nothing leaves your machine.

---

<sub>Copyright © 2026 Pseudo Science Fiction</sub>
