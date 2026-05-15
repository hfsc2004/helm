<div align="center">
  <h1>PSF Helm</h1>
  <p><em>The natural-language helm for your robot — or your drone.</em></p>
</div>

PSF Helm is a local-first desktop app that pairs natural-language control with any llama.cpp model, runs entirely on your machine, and stays out of the cloud. Drive your robot truck, or fly your drone, by telling it what you want.

Cross-platform: Linux, macOS, Windows.

## Status

Early development. Foundation phase.

## What It Does

- Pair with a robot or drone over your local network
- Drive or fly it with plain English ("go forward 2 seconds", "turn left", "hover")
- Or drive it directly with on-screen controls / keyboard / gamepad
- Bring your own llama.cpp-compatible model (`.gguf`); drop it in and go
- Camera feed front and center when the vehicle has one
- Big red STOP — always one click away

## Design Principles

- **Local-first.** No cloud accounts. No telemetry. Your robot, your laptop, your network.
- **Two surfaces, one app.** A simple driver view for "I just want to drive my thing," and an advanced workbench view for users who want to configure pipelines, models, and policies.
- **Vehicle-neutral.** Ground robots first; drones and other vehicles slot in without rewriting the app.
- **Safety by default.** Firmware deadman timer, app-side command bounds, always-visible emergency stop.
- **Bring your own model.** Any `.gguf` runs via llama.cpp. No vendor lock-in.

## Supported Vehicles

| Vehicle | Status |
|---|---|
| ESP32 skid-steer ground robot (HTTP/WiFi) | In progress |
| ESP32-S3 + Pico 2 quadcopter with SNN/STDP flight control | Planned |

## Requirements

- Node.js (LTS)
- Electron
- A llama.cpp-compatible `.gguf` model
- A supported vehicle on your local WiFi

## Repository Layout

To be defined as the project takes shape.

## License

Apache-2.0 (planned). See `LICENSE`.

## Family

PSF Helm is part of the PSF product family alongside [PSF Core](https://github.com/hfsc2004/) and other tools. Helm is the consumer-facing driving app; the larger industrial orchestration platform lives elsewhere.
