# PSF Sensor Board v1.3 — first firmware

This is the first **bench bring-up** image for the ESP32-S3-CAM mounted on the
GSN Robotics / PSF Sensor Board v1.3. It keeps the existing Helm camera API and
adds diagnostics that remain reachable while MJPEG is streaming. It does not
provide a drive endpoint or motor controls; no separate drive ESP32 is assumed
for this v1.3 bring-up configuration.

## Implemented

- Camera on port 81: `GET /health`, `GET /capture`, `GET /stream`.
- Diagnostics on port 82: `GET /diagnostics` lists I²C addresses, reads back
  the TCA9534 output/configuration registers, and reports whether the ToF
  default address and IMU address respond. The expander is initialized after
  Wi-Fi setup so the sensor rail has time to settle. Address presence is
  **not** a working distance or motion measurement. The three ToFs share
  `0x29` only before the two narrow devices receive their new addresses.
- Single-zone ranging on port 82: `GET /ranges` uses the Pololu VL53L1X
  driver to read front and rear VL53L1CB sensors in short mode. The devices
  are assigned `0x30` and `0x31` at startup; `distanceMm` is returned only
  when the driver reports a valid range.
- Wide ranging on port 82: `GET /wide-range` returns the latest VL53L5CX
  8×8 frame as 64 raw millimeter distances and 64 target-status values,
  with its age in milliseconds. The sensor remains at `0x29`. Live frames
  were received on the bench; raw values are not collision decisions.
- RGBW test on port 82: `GET /led?index=0&r=0&g=0&b=0&w=0`. Index is 0–2;
  channels are 0–255. All LEDs start off. The SK6812 wire order is GRBW.
  On the tested board, index 0 is upper right, index 1 is upper left, and
  index 2 is lower right from the truck's forward-facing perspective (looking
  away from the observer).
- The TCA9534 holds the two VL53L1CB sensors in reset and releases the
  VL53L5CX. Only documented P0–P3 are configured as outputs. P4–P7 remain
  inputs until their board-control roles are confirmed on hardware.
- Wi-Fi STA with DHCP or static IP; `<name>.local` mDNS when available.

## Still to bring up

Calibrated IMU samples, stereo PDM audio, speaker output, IR emitter control,
and motor/control integration remain.
`/diagnostics` returns `null` for its legacy distance and IMU sample fields;
use `/ranges` and `/wide-range` for actual ToF readings.
On the first bench test, the camera streamed successfully over Wi-Fi, while
the I²C scan returned no devices and `expanderReady` was false. Moving
expander initialization until after Wi-Fi setup resolved that initial result.
With the later expander initialization, the live board reports `0x20` and
`0x68`. The first output setting, `0x0C`, held the two narrow ToFs in reset and
also made `0x29` disappear. The isolation probe confirmed that each narrow
ToF responds when released alone, while the wide ToF responds with expander
output `0x04` (P2 high, P3 low), but not `0x0C` (P2/P3 high). All probes
verified their output setting and restored the original output. The template
initializes each narrow device at a distinct address before releasing the
wide sensor.
On the first live `/ranges` test, eight front readings were valid and clustered
at 708–710 mm toward a wall estimated to be about three feet away. With the
truck reversed toward that wall, ten rear readings were valid and clustered at
683–689 mm; the front then reported no valid target. These are uncalibrated
bench observations, not collision thresholds.
The first 8×8 bench test returned 64 distance values and per-zone target
statuses. Many reported distances were roughly 500–850 mm; some zones had no
valid target. The board was leaning against a box during the test, explaining
the rear sensor's near-zero reading. No 8×8 orientation mapping or collision
threshold has been established yet.

The camera server has one streaming connection at a time, as in the existing
video template. It runs in a separate task from the port-82 diagnostics server,
so sensor and LED testing remain available during the stream. Helm-UI's camera
cache should be used for simultaneous UI and CLI viewing.

## Build and bench use

The template appears in Helm's ESP32-S3 Configure Board list as
**GSN Robotics - PSF Sensor Board v1.3 (bring-up)**. Its GOOUUU camera pin
map is fixed by this PCB; do not select an unrelated pin profile. The board's
own USB-C socket is power-only. Use the ESP32-S3-CAM module's programming
connector for a future flash, after confirming the module and serial port.

The default FQBN is `esp32:esp32:esp32s3:PSRAM=opi`, targeting the photographed
GOOUUU ESP32-S3-CAM module. Helm installs the pinned Pololu VL53L1X 1.3.1
and Adafruit VL53L5CX 1.0.1 Arduino libraries during a normal flash, if they
are not already present. The template can be rendered without upload:

```bash
npm run helm -- flash-render --template sensor-board-v1-3-esp32s3 \
  --var 'wifi.ssid=Bench,wifi.password=placeholder'
```

The hardware-reference PDFs, photos, and pinout are kept locally and are not
included in this repository.
GPIO4 is shared with the camera SCCB connection; leave the IR switch in its
default expander-controlled position while the camera is active. The speaker
terminals are differential; neither is ground.
