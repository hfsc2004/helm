# Firmware

ESP32 / microcontroller firmware that runs on the physical vehicles PSF Helm controls.

Firmware lives in this repo (not a separate one) so the app and the firmware version together.

## What's here

- `ground-skidsteer/` — Arduino sketch for the ESP32 + L298N skid-steer robot. HTTP control on port 8080 with an 800 ms deadman timer.
- `ground-skidsteer-calibration/` — bench-test sketch for tuning left/right motor balance before flashing the main firmware.

## Planned

- `ground-obstacle-avoidance/` — standalone autonomous obstacle-avoidance sketch (no remote control)
- `air-quadcopter/` — ESP32-S3 brains + Pico 2 flight controller with SNN/STDP per-blade motor neurons (future)
