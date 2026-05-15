# LLM

Inference backend and the natural-language → vehicle-command planner.

## Backend: Ollama (v0.1)

Helm runs its own private Ollama instance. See `ollama/README.md` for the isolation contract.

The choice of Ollama (vs. raw llama.cpp) is documented as a foundation decision: prebuilt binaries, no compiler toolchain on the user's machine, single-domain outbound for install, proven Modelfile + GGUF-wrap support for the v0.2 model UX. A second backend (raw llama.cpp) is planned for a future release and will share the same `InferenceBackend` interface defined here.

## Planner (forthcoming)

Branch 2 (`feat/llm-planner`) adds `planner.ts`: takes a vehicle + an intent string, asks the model for a structured command, validates against the vehicle's contract, returns it. The IRG pattern from PSF Core, scaled down.
