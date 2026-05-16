# Changelog

All notable changes to PSF Helm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Foundation work in progress on a single day. Linux x64 is the only platform
currently exercised end-to-end. The features below ship as a coherent v0.1
once cross-platform polish, packaging, and documentation lands.

### Added

#### App shell + UI
- Electron desktop app with Svelte 5 + Vite + strict TypeScript
- Two surfaces over one core: `helm-ui` (desktop app) and `helm` (agent-first CLI)
- Three-tab navigation with browser-style tabs that bleed into the content area:
  **Drive** (camera, STOP, intent bar, D-pad, live state, activity log, audio feed),
  **Vehicles** (per-vehicle cards), **Devices** (USB/serial, GPU, Ollama)
- Logo capsule in the header with a slow center-pulse ripple effect

#### Driving
- ESP32 skid-steer vehicle adapter (HTTP/WiFi). Truck firmware in `firmware/ground-skidsteer/`
- Vehicle registry: persistent `~/.local/share/psf-helm/registry.json`,
  capped at 64 vehicles
- Live state stream from a vehicle to the UI (BMOC-tracked subscription)
- Big red STOP button (always visible), arrow-key + spacebar driving from
  the keyboard, on-screen D-pad
- Camera sidecar — MJPEG stream rendered in `<img>` element, friendly placeholder when unattached
- Audio sidecar — roving microphone, host-side playback with pulsing red
  "LISTENING" indicator, audio stays on the LAN
- Activity log: human / local / remote roles, color-coded events
- Vehicle cards: per-vehicle settings (camera + mic toggles with inline edit), Drive button, remove

#### Natural-language planning
- `helm drive <vehicleId> "<intent>"` — intent → planner → validator → execute
- Strict JSON-mode validation; one retry on invalid output, fail-loud on second
- Default planner model: `qwen2.5-vl-7b` (vision-capable)
- Override per-call with `--model <name>`, `--dry-run`, `--no-retry`, `--temperature`
- Streaming NDJSON events: `plan` → `validate` → `execute` → `complete` (or `error`)

#### LLM backend (private Ollama)
- Hard isolation from any system Ollama: private port (52450), private models dir,
  private binary, four-variable env contract, `lsof`+cmdline-based stale-process
  cleanup that only ever touches Helm-spawned processes
- One-time download from `ollama.com` to `<dataDir>/ollama/`
- BMOC-registered process; window-close + app-quit reap it cleanly
- CLI: `ollama-status`, `ollama-install --confirm`, `ollama-start`, `ollama-stop`,
  `ollama-uninstall --confirm`

#### Models
- HF-aware downloader with Bearer-auth support for gated models
- HF token storage in `.env` (mode 0600, git-ignored, never logged)
- GGUF wrap-for-Ollama: SHA-256 the file, POST to `/api/blobs`, register via Modelfile
- Multi-shard `.gguf` reassembly via `llama-gguf-split` when needed
- CLI: `model-download <url>`, `model-list`, `model-remove <name>`, `hf-token-set/status/clear`
- Recommended starter models documented: Qwen2.5-VL-7B (non-gated), Gemma 3 4B (gated)

#### Hardware detection
- Verbatim port from PSF Core (~2,000 lines): GPU detection on
  Linux x64 / ARM64, macOS Intel / ARM, Windows x64 / ARM64
- Headless-first NVIDIA GPU selection — the inference workload picks
  the GPU not driving a display, even when both have equal VRAM
  (validated on host: Tesla P4 wins over Quadro M5000)
- Apple Silicon, Mali, VideoCore, NPU classification
- Surfaced in the Devices tab and via `helm hardware`

#### Toolchains for microcontroller flashing
- arduino-cli: download from `downloads.arduino.cc`, isolated env
  (Helm never touches `~/.arduino15`), managed-then-system fallback
- mpremote: detect-only (system `mpremote`, then `python3 -m mpremote`)
- CLI: `toolchain-status`, `toolchain-install --target <arduino-cli|mpremote>`,
  `toolchain-uninstall`

#### Firmware flashing
- Sketch template loader: `firmware/templates/<id>/{template.json, sketch.ino}`
- Strict variable validator: typed (string/secret/number/boolean), missing
  required → loud failure, unknown keys → loud failure, `.octets` derivation
  for IPv4 strings used in Arduino's `IPAddress()` constructor
- Compile + upload pipeline via arduino-cli, BMOC-tracked subprocesses,
  streaming NDJSON progress (`prepare` → `render` → `core-install` →
  `compile` → `upload` → `complete`)
- Auto-installs the relevant Arduino core (e.g. `esp32:esp32`) on first flash
- First template: `ground-skidsteer-esp32` (the truck firmware) with 9 typed
  vars covering WiFi, static IP, motor trims, motor inversions
- Raw sketches imported from PSF Core for future templating: skid-steer
  calibration, three obstacle-avoidance variants, Elegoo ESP32-S3 camera kit
- Firmware/templates/TODO.md documents per-template difficulty + open
  schema extensions (cloned-libs, post-flash verification, prebuilt-bin
  flash path, Pico/mpremote target)
- CLI: `flash-templates`, `flash-template-show <id>`, `flash-render`, `flash <port> --template <id> --var ...`

#### Devices tab
- USB/serial enumeration (verbatim from PSF Core): Linux + macOS today;
  recognizes Pi Pico (RP2040, RP2350) and ESP32 by USB descriptor
- Live device list with friendly board hints, refresh button
- Inference hardware: detected GPUs with the headless-first selection
  highlighted, all GPUs listed when multi-GPU
- LLM backend status: installed/running/port/disk-used + actionable
  hints when not configured

#### CLI surface (machine-readable, agent-first)
- `helm describe` emits the full schema as JSON for agent introspection
- `helm privacy` emits the privacy posture as JSON, including the canary
  statement, all four declared outbound destinations, voice + LLM + audio
  posture blocks
- `helm version`, `helm hardware`, `helm vehicle-list/add/remove/health`,
  `helm vehicle-camera-set/clear`, `helm vehicle-audio-set/clear`,
  `helm cmd <id> <action>`, `helm state <id> --follow`, `helm stop <id>`,
  `helm serial-list`, etc. Output is JSON by default; long-running events
  emit NDJSON; logs go to stderr to keep stdout parseable.

#### Process + IPC lifecycle (BMOC)
- Verbatim port from PSF Core's session-manager (~560 lines): generic
  process lifecycle authority. Service-specific Ollama/WebUI/AnythingLLM
  modules deliberately not copied (Helm's customers register through BMOC themselves)
- Architectural rule: nothing in Helm spawns or kills its own processes;
  every subsystem registers through BMOC
- Companion rule: long-lived IPC subscriptions (state, drive lifecycle,
  audio) are sessions too — window-close + app-quit reap them
- BMOC initialized at app startup; `before-quit` blocks until
  `closeAllSessions()` finishes

#### Storage discipline
- Centralized limits in `core/storage/limits.ts` — no category of stored
  data grows unbounded
- Model files cap (50 GB), staging cap (20 GB), state log cap (10 MB
  per vehicle, rolling), command-history cap (1000 entries per vehicle),
  trace bytes/files caps, intent length cap (2 KB), command rate limit
  (20/sec per vehicle)
- OS-appropriate paths via `core/paths.ts` (Linux, macOS, Windows
  conventions)

#### Voice subsystem (scaffolded only)
- `core/voice/` types, install state, uninstall flow
- CLI: `voice-status`, `voice-install`, `voice-uninstall`
- Install path stubbed — runtime not yet wired (whisper.cpp + piper, opt-in,
  binaries from GitHub releases)

#### Privacy posture
- Machine-readable via `helm privacy`
- Four opt-in outbound destinations, all explicitly user-triggered:
  - `ollama.com` — one-time, on `ollama-install`
  - `github.com` — one-time, on `voice-install` (when voice ships)
  - `huggingface.co` — per-model, on `model-download`. HF token sent only
    here, only as Bearer auth
  - `downloads.arduino.cc` — one-time, on `toolchain-install --target arduino-cli`
- Local-only declarations for voice, LLM inference (Ollama loopback), and
  audio (LAN-only, never persisted)
- Three "🐤" canary statements in README pinned to distinct claims

#### Architecture + dev experience
- Strict TypeScript everywhere. Verbatim `.js` imports from PSF Core
  (BMOC, hardware, download, serial enum) wrapped in thin TS surfaces;
  `docs/conversion-todo.md` documents the opportunistic file-by-file
  conversion plan
- TypeScript build picks up `core/**/*.js` so verbatim siblings make it
  to `dist-electron/`
- `start.sh` launches the app; `npm run helm` runs the CLI; first-time
  install via `install/RUN_ONCE_MAC_LINUX.sh`
- `docs/mockups/` git-ignored holding area for UI sketches

### Fixed
- Electron startup: removed `"type": "module"` from package.json (Electron
  main process needs CJS), `vite.config.ts` → `vite.config.mts` to keep
  Vite's ESM-only plugin loading; `svelte.config.js` → `.mjs`. DevTools
  no longer auto-opens (HELM_DEVTOOLS=1 env var to enable; F12 / Ctrl+Shift+I
  still toggles)
- TS compile output: include `core/**/*.js` so verbatim sibling files copy
  to `dist-electron/` alongside compiled `.ts`. Without this, BMOC's
  compiled `index.js` couldn't `require()` its `.js` siblings at runtime

### Notes
- Linux x64 is the only platform exercised end-to-end. macOS and Windows
  ports of serial enum, Ollama download, and arduino-cli download are
  follow-up work
- Devices tab "Program…" button (the UI surface for the working flash
  backend) is not yet built — flashing today is CLI-only
- Pico/mpremote flashing is detect-only — no flash backend yet
- Raw sketches in `firmware/raw-from-core-ce/` (calibration, obstacle
  avoidance, Elegoo ESP32-S3 camera, ESP32 mic sidecar) are starter
  material, not yet templatized. The mic sidecar firmware is untested
  on hardware
