# Changelog

All notable changes to PSF Helm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.10] - 2026-10-02

### Added
- Add a persistent Audio library below the Driver panel controls: search, add
  local files, remove library entries without deleting originals, and play
  sounds through the selected Sensor Board v1.3 robot's speaker.
- Add an LED script library beneath Audio with New, Edit, Delete, Play,
  Play Loop, and Stop. Open a separate editor window for named multi-line shows.
- Program multiple lights concurrently per line, with independent RGBW colors,
  white-channel intensity, Steady on/Flash behavior, flash count, and duration.
  Add timed No Action lines, reorder steps, and preserve older single-light scripts.
- Add a single IR bank target and firmware endpoint for expander P5; all three
  emitters share one driver. ESP32 LED targets require verified GPIO mappings.
- Add persistent microphone DATA/CLK high, low, floating-input and clock-only
  tests, two-phase RX comparison, hardware register dumps, and an opt-in restore
  trace with individual checkpoints held until explicitly advanced or aborted.
- Add continuous DATA/clock edge counting around RX disable, preserving GPIO14
  configuration and holding checkpoint 1 indefinitely for multimeter measurements.

### Fixed
- Keep Steady on lights illuminated across script lines and loop repeats;
  Stop and show completion attempt to turn off every light the show touched.
- Recover keyboard driving when the board reconnects after a flash, retry
  bridge status, and show connection or command errors in the Driver panel.
- Separate speaker streaming onto a dedicated core-0 HTTP task on port 83 so
  light commands and sensor polling on core 1 can continue during audio uploads.
  Serialize speaker ownership and I2C preparation; retain legacy port-82 playback.
  Helm and the CLI discover the new endpoint automatically.

### Validation
- Desktop type checks and production builds passed. Mocked checks cover library
  persistence, independent concurrent light timelines, steady headlights,
  loops/Stop/error cleanup, timed pauses, old scripts, and drive reconnection.
- Real WAV decoding and multipart uploads passed against a local test server;
  source audio remained unchanged. Dedicated speaker discovery/fallback passed.
- Sensor-board firmware compiled and was flashed to the original ESP32-S3
  with flash hashes verified. Concurrent sound/light operation after this flash
  remains to be checked on the robot.
- User confirmed multiple sound effects played. Restore checkpoints isolated
  GPIO14's sustained ~3 V to `gpio_reset_pin()`, which enabled its pull-up.
  The held RX-off test counted a 2.048 MHz clock, no DATA edges in its first five
  seconds, then 68 sparse edges around 7.8 seconds followed by inactivity.

### Known issues
- Microphone audio remains unresolved; sparse DATA edges do not demonstrate
  valid PDM. The normal restore path is instrumented, not repaired.
- Onboard RGB LEDs sharing GPIO48 with the sensor-board chain cannot be
  isolated through script target selection alone; module wiring needs verification.
- IR control requires the updated firmware and SW1 in expander positions 1–2.
  ESP32-LED4/LED5 playback is unavailable until their GPIO mappings are established.
- Restart Helm after updating its main/preload processes.

## [0.3.9] - 2026-10-02

### Added
- Add SR Front VL53L5CX profiles with runtime 4×4/8×8 switching, rate selection,
  strongest-target ordering, and Inspect signal/ambient/target-count diagnostics.
  Expose settings and cached frames through `helm vehicle-wide-tof` and the UI.
- Name the UI profiles Extended Reach, Far Detail, Balanced Detail, Close Detail,
  and Low Power, with the robot's observed test ranges shown beside them.
- Add regression coverage for profile requests, frequency bounds, frame dimensions,
  distance colors, invalid returns, and stale-frame expiry.

### Changed
- Boot SR Front into Low Power: 4×4 at 2 Hz, autonomous ranging, 5 ms integration.
- Place camera delivery, Wi-Fi, TCP/IP, and network events on core 0; retain
  sensor polling and response packaging on core 1 with compile-time affinity checks.
- Poll the SR heat map independently of LR/IMU reads: 100 ms after each request
  in Fast/Navigation, 200 ms in Detail/Inspect, and 500 ms in Low Power.
- Remove the ELEGOO Uno test panel from Drive; keyboard driving remains available.

### Fixed
- Recompute heat-map colors and validity when indexed measurements change,
  and expire stale colors through a separate 100 ms UI clock.
- Send dropdown profile/rate changes from the event's selected value rather
  than relying on bound state that can still contain the previous selection.
- Clear old SR frames during profile changes and reject mismatched dimensions.

### Verified on hardware
- Flash the core-affinity and SR profile firmware on the ESP32-S3; switch all
  five profiles through the CLI, receive 16-zone Idle and 64-zone Detail/Inspect
  frames, and expose Inspect diagnostic arrays. Flash the Low Power boot default.
- Record user-reported SR ranges at the default profile rates: Extended Reach
  6 ft, Far Detail 5 ft, Balanced Detail 4 ft, Close Detail 3 ft, Low Power 3 ft.
  These are observations, not calibrated obstacle thresholds or guaranteed limits.

### Known issues
- Microphone retesting still returns constant `-30935` PCM with zero AC RMS
  on both channels; hardware counting sees clock edges but no DATA edges.
- Intermittent sensor-board I²C startup failure may require a full power cycle.
  LR sensor recovery and stale confirmed measurements remain follow-up work.
- Restart Helm after updating the preload/main process to load new IPC controls.

## [0.3.8] - 2026-10-01

### Added
- Add keyboard-only WASD and NumPad driving for Sensor Board v1.3 through the
  ELEGOO Uno. Bounded motor pulses are refreshed while a key is held; key
  release, Space, and focus loss send stop. No on-screen keypad is added.
- Add nonblocking Uno drive/stop endpoints with the Uno's timed motor command
  and an independent ESP-side stop deadline. Report UART writes separately
  from Uno acknowledgments, which are not yet received.
- Have the ESP send Uno stop/clear and shield RGB-off after startup, with a few
  bounded retries. This does not change the Uno's own power-on firmware.

### Fixed
- Correct the Sensor Board v1.3 Uno UART default: ESP GPIO43 transmits to Uno
  RX; divided Uno TX reaches ESP GPIO44 RX. Preserve the Freenove camera's
  tested horizontal mirror setting and expose a live mirror toggle.

### Known issues
- The Uno acts on LED and motor commands but ESP GPIO44 has received no reply
  bytes, so ultrasonic and line-sensor queries remain unavailable. A separate
  Uno-only reset may relight the shield RGB LED until the ESP is restarted or
  the RGB-off command is sent again. Microphone capture remains unresolved.

## [0.3.7] - 2026-09-26

### Added
- Show live Sensor Board v1.3 ToF and IMU data in the Drive sidebar, including
  an 8×8 distance map, Wi-Fi RSSI, and IMU die temperature. Distance readouts
  switch from mm to cm at 100 mm and to m at 1,000 mm.
- Add `helm vehicle-tof-mode` for agents to inspect, pin, or restore automatic
  Short/Medium/Long modes independently on the two single-zone ToF sensors.
  Persistent invalid returns trigger a mode retry about every two seconds
  while `/ranges` is polled; valid returns hold the working mode. No user-facing
  mode selector or reflashing is needed for runtime changes.

### Changed
- Preserve the last good IMU and Wi-Fi readouts across transient request
  failures, labeling old samples as stale instead of briefly blanking them.
  Wi-Fi RSSI now comes from the diagnostic port rather than competing with
  MJPEG traffic on the camera server.
- Distinguish weak ToF returns and timeouts from valid distances in the Drive
  panel instead of displaying an unexplained dash.

### Known issues
- IMU I²C reads can still fail intermittently; held readouts are marked stale
  until a fresh sample succeeds. Microphone audio remains under investigation.

## [0.3.6] - 2026-09-26

### Fixed
- Preserve negative PCM samples when scaling the embedded Sensor Board v1.3
  startup chime; unsigned fade arithmetic had made boot playback sound heavily
  distorted even though Helm-streamed playback was clean. A compile-time
  assertion guards the signed calculation.

### Changed
- Set the boot chime to the hardware-tested 30% level and add a synchronized
  RGBW startup sequence: a one-second lower-right, upper-left, upper-right
  chase, then all LEDs lighting as the chime starts, shifting to white and back
  to dim blue during its decay, and switching off at the end.
- Add `/speaker-chime` and `/startup-sequence` diagnostic endpoints for
  replaying the embedded audio or full sequence without a power cycle.

### Known issues
- The I²C expander occasionally fails initialization on the first reset after
  flashing, which can skip the boot sound and sensor initialization. A power
  cycle restored it in bench testing; root cause remains open.

## [0.3.5] - 2026-09-26

### Added
- Bundle `PSF_Chime.wav` as the Sensor Board v1.3 boot sound at 50% playback
  level, with a reproducible generator for its flash-resident PCM header.
- Stage auxiliary firmware headers during Helm flash and add a microphone-clock
  diagnostic command for the ongoing GPIO14/GPIO21 bring-up.

### Changed
- Increase the board-side streamed-audio queue from 8 KiB to 32 KiB and mute
  the amplifier while reconfiguring I²S before each stream.
- Play the boot chime before allocating the streaming queue, and report its
  playback stage and I²S error in diagnostics.

### Known issues
- PDM microphone data remains flat on the tested board; the physical or
  firmware cause has not been confirmed.

## [0.3.4] - 2026-09-25

### Added
- Read ICM-42607-C accelerometer, gyroscope, and temperature samples from the
  PSF Sensor Board v1.3 through `/imu`; expose configuration readbacks for
  intermittent I²C diagnosis.
- Add stereo PDM microphone capture and GPIO/clock diagnostic endpoints. Audio
  capture is still nonfunctional on the tested board: both channels returned
  constant PCM with zero AC RMS. The independent 2.048 MHz clock test found no
  driven data at the ESP32 GPIO14 pad; the physical cause remains unresolved.
- Add `vehicle-speaker-play` to decode local audio with `ffmpeg` and stream
  16 kHz stereo PCM to the board's 8 KiB buffered I²S playback queue.

### Verified on hardware
- Enabling the MAX98357A through TCA9534 P4 restored audible speaker playback
  of the 100 KiB sample. All three ToF devices remained available after that
  expander change. IMU samples changed with board orientation, although later
  I²C reads were occasionally intermittent.

## [0.3.3] - 2026-09-25

### Added
- Bring up all three PSF Sensor Board v1.3 ToF devices concurrently: assign
  the front/rear VL53L1CB sensors distinct I²C addresses and stream raw 8×8
  VL53L5CX depth frames with per-zone target status on `/wide-range`.
- Install each firmware template's pinned Arduino sensor libraries before
  compiling in Helm's flash flow.

### Verified on hardware
- Front and rear single-zone ranges, 8×8 depth frames, RGBW LEDs, and camera
  capture on the ESP32-S3-CAM. The rear sensor's near-zero reading was with
  the board leaning against a box. Raw ToF values are not collision rules.

## [0.3.2] - 2026-09-25

### Fixed
- Serve CLI snapshots from the shared camera cache without also opening a
  redundant `/capture` request to the board.
- Reconnect a stalled UI camera stream without overlapping it with direct
  capture requests. On the PSF Sensor Board v1.3 hardware, Helm again held
  one camera connection and ping showed no packet loss during the live test.

## [0.3.1] - 2026-09-25

### Fixed
- Treat PSF Sensor Board v1.3 as a single camera/sensor board during bring-up:
  no nonexistent drive-board telemetry poll, motor controls, or misleading
  "Vehicle unreachable" warning. New v1.3 registrations are camera-only.
- Recover stalled camera streams and serialize UI snapshot polls so a lost
  connection does not leave the last few images frozen indefinitely.
- Check the v1.3 camera endpoint for `vehicle-health` and omit drive telemetry
  from camera-only snapshots.

### Notes
- First hardware test confirmed Wi-Fi camera capture and MJPEG streaming.
  The I²C scan found no devices; ToF/IMU/audio are still bring-up work.
- On networks where `.local` resolution is intermittent, use the board's
  current IP for the camera URL or reserve its address on the router.

## [0.3.0] - 2026-09-25

### Added
- GSN Robotics / PSF Sensor Board v1.3 ESP32-S3-CAM bring-up template with
  camera streaming, I²C presence diagnostics, and RGBW LED test control.
  ToF ranging, IMU samples, audio, and drive-board collision rules remain
  follow-up work; the new image is not yet validated on hardware.
- Per-vehicle PSF Sensor Board revision setting (v1.1, v1.3, or none) in the
  Vehicles UI and `vehicle-sensor-board-set` CLI command. Flashing the v1.3
  template attaches its camera and records v1.3 for that vehicle.

### Fixed
- A generic ESP32 USB descriptor no longer silently selects the classic
  ESP32 target. The Configure Board wizard requires an explicit ESP32 versus
  ESP32-S3 choice before compiling or flashing.

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
