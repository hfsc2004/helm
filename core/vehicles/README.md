# Vehicles

Per-vehicle adapter modules. Each module implements a common interface defined in `shared/vehicle-contract.ts` and translates the app's neutral commands into whatever protocol the physical vehicle speaks.

## Planned modules

- `ground-skidsteer.ts` — ESP32 + L298N skid-steer ground robot over HTTP/WiFi
- `air-quadcopter.ts` — (future) ESP32-S3 + Pico 2 quadcopter with SNN/STDP flight control

## Adding a new vehicle

1. Create `vehicles/<kind>-<variant>.ts`
2. Implement the vehicle interface
3. Declare capabilities the UI/LLM planner should respect
4. Register the module so the app can list it
