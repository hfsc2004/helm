# LLM

llama.cpp lifecycle management and the natural-language → vehicle-command pipeline.

## Planned modules

- `llamacpp-manager.ts` — spawn, monitor, and shut down a local `llama-server` process
- `planner.ts` — turn a user utterance ("go forward 2 seconds") into a validated vehicle command, given the active vehicle's capabilities and contract
- `prompts/` — system prompts parameterized by vehicle kind

## Design

The planner is the app's analogue to PSF Core's IRG: model proposes, validator gates, executor runs. The vehicle's contract defines what commands are even possible to propose.
