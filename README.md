<div align="center">
  <img src="public/logo.png" alt="PSF Helm" width="360">
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
| ESP32 skid-steer ground robot (HTTP/WiFi) | Wire-level driving in v0.1 |
| ESP32-S3 + Pico 2 quadcopter with SNN/STDP flight control | Planned |

## Models

PSF Helm downloads `.gguf` model files directly and registers them with its private Ollama. The Hugging Face token (if you need one for gated models) lives in your project's `.env` file — git-ignored, mode 0600, and only sent to `huggingface.co` as Bearer auth.

```bash
# Optional: store your HF token (read from env var so it never hits shell history)
export HF_TOKEN="hf_..."
npm run helm -- hf-token-set --from-env HF_TOKEN

# Check whether a token is configured (never echoes the value)
npm run helm -- hf-token-status

# Download a model. Helm fetches, verifies, and registers with Ollama.
npm run helm -- model-download \
  https://huggingface.co/unsloth/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf \
  --name qwen2.5-vl-7b

# Or a gated model (requires HF token + accepted Gemma TOS):
npm run helm -- model-download \
  https://huggingface.co/google/gemma-3-4b-it-qat-q4_0-gguf/resolve/main/gemma-3-4b-it-q4_0.gguf \
  --name gemma-3-4b

# List models known to Helm's private Ollama
npm run helm -- model-list

# Remove a model
npm run helm -- model-remove qwen2.5-vl-7b
```

### Recommended starter models

| Model | Size | Vision? | Gated? | URL |
|---|---|---|---|---|
| Qwen2.5-VL-7B-Instruct (Q4_K_M) | ~4.7 GB | Yes | No | [download](https://huggingface.co/unsloth/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf?download=true) |
| Gemma 3 4B Instruct (Q4_0 QAT) | ~3 GB | Yes | Yes (HF account + TOS) | [download](https://huggingface.co/google/gemma-3-4b-it-qat-q4_0-gguf/resolve/main/gemma-3-4b-it-q4_0.gguf?download=true) |

You can drop any `.gguf` from Hugging Face in via `model-download <url>`. The two above are the ones Helm tests against.

## Inference Backend

PSF Helm runs its own private Ollama instance. It does **not** touch the system Ollama daemon (port 11434). Helm's Ollama lives on a private port (52450), uses a private models directory, and is fully isolated by four environment variables — see `core/llm/ollama/README.md`. This is a deliberate "single source of truth" design choice imported from PSF Core's experience.

```bash
# One-time install (downloads from ollama.com)
npm run helm -- ollama-install --confirm

# Start / stop Helm's private Ollama
npm run helm -- ollama-start
npm run helm -- ollama-stop

# Check what's running (without touching system Ollama)
npm run helm -- ollama-status

# Remove
npm run helm -- ollama-uninstall --confirm
```

## Driving by intent (CLI, v0.1)

Once your private Ollama is running (`helm ollama-start`) and a model is downloaded (`helm model-download <url>`), you can drive by talking to the planner:

```bash
# Default model is qwen2.5-vl-7b (recommended); override with --model
npm run helm -- drive <vehicle-id> "go forward 2 seconds"
npm run helm -- drive <vehicle-id> "turn left then stop"
npm run helm -- drive <vehicle-id> "drive in a circle at half speed"

# Plan only; don't actually move the robot
npm run helm -- drive <vehicle-id> "go forward 2 seconds" --dry-run

# Override model
npm run helm -- drive <vehicle-id> "stop" --model gemma-3-4b
```

The planner emits NDJSON events (`plan`, `validate`, `execute`, `complete`) so agents can observe the full lifecycle. Invalid output gets one retry with the validator error in context; a second failure exits non-zero rather than guessing.

## Driving (CLI, v0.1)

The CLI works today with the ESP32 skid-steer firmware in `firmware/ground-skidsteer/`.

```bash
# Register your robot
npm run helm -- vehicle-add 172.20.0.15 --name truck-01

# List registered vehicles
npm run helm -- vehicle-list

# Check it's reachable
npm run helm -- vehicle-health <vehicle-id>

# Watch live state (streaming NDJSON; Ctrl-C to stop)
npm run helm -- state <vehicle-id> --follow

# Drive
npm run helm -- cmd <vehicle-id> fwd --speed 160 --ms 2000
npm run helm -- cmd <vehicle-id> turn --speed -120 --ms 400
npm run helm -- cmd <vehicle-id> tank --left 120 --right -90

# Stop now
npm run helm -- stop <vehicle-id>
```

The natural-language path (`helm drive <id> "go forward 2 seconds"`) is planned for v0.2 — it needs the LLM planner.

## Requirements

- Node.js (LTS)
- Electron
- A llama.cpp-compatible `.gguf` model
- A supported vehicle on your local WiFi

## Surfaces

PSF Helm has two surfaces over one shared core:

- **`helm-ui`** — the desktop app. What most users will use. Launch with `./start.sh` or `npm run helm-ui`.
- **`helm`** — the CLI. Agent-first, structured output, NDJSON streams, machine-introspectable. Useful for scripting, automation, and frontier-model control. Run with `npm run helm -- <command>`.

Both share `core/` for all logic — vehicles, planner, state streaming, storage. Neither owns business logic.

## Repository Layout

```
core/         — business logic (vehicles, llm, state, storage). No UI.
cli/          — `helm` CLI entrypoint and commands.
electron/     — `helm-ui` Electron main process and preload.
src/          — `helm-ui` Svelte renderer.
shared/       — types used by every surface.
firmware/     — ESP32 / microcontroller sketches.
install/      — one-time dependency installers.
public/       — static assets.
docs/         — design notes.
```

## License

Apache-2.0 (planned). See `LICENSE`.

## Family

PSF Helm is part of the PSF product family alongside [PSF Core](https://github.com/hfsc2004/) and other tools. Helm is the consumer-facing driving app; the larger industrial orchestration platform lives elsewhere.

## What PSF Helm does NOT do

Nothing in PSF Helm phones home. No analytics, no error reporting, no user tracking, no cloud accounts. Vehicle state ("telemetry" in robotics terminology) refers to data the vehicle reports about itself — battery voltage, motor speed, signal strength — and stays on your machine. If a future version ever adds any outbound network traffic of any kind, it will be opt-in and disclosed prominently. 🐤

Voice (STT) runs locally via whisper.cpp. Your speech is never transmitted; it's transcribed on your machine and discarded after the command is executed. 🐤

Voice is optional. If you choose to install it, Helm makes one-time outbound connections to GitHub to fetch the whisper.cpp and piper engine binaries. After install, no further outbound calls. Remove voice any time from Settings or with `helm voice-uninstall --confirm`. 🐤

---

<sub>Copyright © 2026 Pseudo Science Fiction</sub>
