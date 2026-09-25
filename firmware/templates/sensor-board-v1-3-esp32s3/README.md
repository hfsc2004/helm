# PSF Sensor Board v1.3 — first firmware

This is the first **bench bring-up** image for the ESP32-S3-CAM mounted on the
GSN Robotics / PSF Sensor Board v1.3. It keeps the existing Helm camera API and
adds diagnostics that remain reachable while MJPEG is streaming. It does not
change drive-board firmware or motor behavior.

## Implemented

- Camera on port 81: `GET /health`, `GET /capture`, `GET /stream`.
- Diagnostics on port 82: `GET /diagnostics` lists I²C addresses and reports
  whether the TCA9534, VL53L5CX address, and IMU address respond. Presence is
  **not** a working distance or motion measurement.
- RGBW test on port 82: `GET /led?index=0&r=0&g=0&b=0&w=0`. Index is 0–2;
  channels are 0–255. All LEDs start off. The SK6812 wire order is GRBW.
- The TCA9534 holds the two VL53L1CB sensors in reset and releases the
  VL53L5CX. Only documented P0–P3 are configured as outputs. P4–P7 remain
  inputs until their board-control roles are confirmed on hardware.
- Wi-Fi STA with DHCP or static IP; `<name>.local` mDNS when available.

## Still to bring up

Distance measurements from all three ToF devices, calibrated IMU samples,
stereo PDM audio, speaker output, IR emitter control, and UART packets to the
drive ESP32 are not implemented. `/diagnostics` returns `null` for distance
and IMU samples so callers cannot mistake I²C presence for valid data.

The camera server has one streaming connection at a time, as in the existing
video template. Port 82 uses a separate task/server so diagnostics and LED
testing remain available during the stream. Helm-UI's camera cache should be
used for simultaneous UI and CLI viewing.

## Build and bench use

The template appears in Helm's ESP32-S3 Configure Board list as
**GSN Robotics - PSF Sensor Board v1.3 (bring-up)**. Its GOOUUU camera pin
map is fixed by this PCB; do not select an unrelated pin profile. The board's
own USB-C socket is power-only. Use the ESP32-S3-CAM module's programming
connector for a future flash, after confirming the module and serial port.

The default FQBN is `esp32:esp32:esp32s3:PSRAM=opi`, targeting the photographed
GOOUUU ESP32-S3-CAM module. The template can be rendered without upload:

```bash
npm run helm -- flash-render --template sensor-board-v1-3-esp32s3 \
  --var 'wifi.ssid=Bench,wifi.password=placeholder'
```

The hardware-reference PDFs, photos, and pinout are kept locally and are not
included in this repository.
GPIO4 is shared with the camera SCCB connection; leave the IR switch in its
default expander-controlled position while the camera is active. The speaker
terminals are differential; neither is ground.
