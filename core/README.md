# Core

The business logic of PSF Helm. No UI, no Electron, no CLI.

Both surfaces (`helm` CLI and `helm-ui` desktop app) import from here. Neither owns logic; they translate user input into core calls and present core output.

## Modules

- `vehicles/` — per-vehicle adapter modules implementing the contract in `shared/vehicle-contract.ts`
- `llm/` — llama.cpp lifecycle + natural-language → command pipeline
- `state/` — vehicle state streaming (data the *vehicle* reports about itself; stays local)
- `storage/` — the single owner of all disk I/O; enforces every storage cap
- `paths.ts` — OS-appropriate data/config directories
- `schema.ts` — the introspectable command schema consumed by `helm describe`
