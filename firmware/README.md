# Firmware

ESP32 / microcontroller firmware that runs on the physical vehicles PSF Helm controls.

Firmware lives in this repo (not a separate one) so the app and the firmware version together.

## Planned

- `ground-skidsteer/` — Arduino sketch for ESP32 + L298N skid-steer robot. HTTP control on port 8080 with deadman timer.
- `ground-skidsteer-calibration/` — bench-test sketch for tuning left/right motor balance.
- `ground-obstacle-avoidance/` — standalone autonomous obstacle-avoidance sketch (no remote control).
