# Vehicles

Per-vehicle adapter modules and the vehicle registry.

## What's here

- `registry.ts` — persistent vehicle list under `<dataDir>/registry.json`. Capped at `STORAGE_LIMITS.registryVehicles` (64).
- `ground-skidsteer.ts` — adapter for the ESP32 skid-steer firmware. HTTP/WiFi transport. Typed `SkidSteerAction` commands.

## Adding a new vehicle type

1. Add the kind/capability values to `shared/vehicle-contract.ts`
2. Create `core/vehicles/<kind>-<variant>.ts` with `health()`, `getState()`, `sendCommand()`, `emergencyStop()` at minimum
3. CLI consumers route to the right adapter based on the vehicle's declared `kind` and `capabilities`

The vehicle contract is intentionally narrow (no abstract base class, no plugin loader). Adapters are concrete modules; the dispatch happens at the call site by reading `vehicle.kind`.
