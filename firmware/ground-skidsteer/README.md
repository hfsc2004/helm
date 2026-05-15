# Ground Skid-Steer Firmware

ESP32 + L298N skid-steer robot. HTTP control on port 8080 with an 800ms deadman timer.

## What it does

Joins your WiFi (DHCP or static), runs an HTTP server, accepts drive commands at `/cmd?...`, exposes `/health` and `/telemetry`. If no command arrives within 800ms the firmware stops the motors itself — you cannot accidentally leave it running by closing the app.

## HTTP API

```
GET /             help text
GET /health       JSON: ok, mode, ip, gateway, subnet, dns1, dns2, port
GET /telemetry    JSON: left, right, deadmanMs, lastCmdAgeMs, wifiRssi, ip, ...
GET /cmd?fwd=160              forward at speed 0..255
GET /cmd?rev=140              reverse at speed 0..255
GET /cmd?turn=120             turn (positive = right, negative = left)
GET /cmd?left=120&right=90    tank-style independent wheel control
GET /cmd?stop=1               emergency stop
```

All `/cmd?...` paths optionally accept `&ms=<100..5000>` to run the action for a bounded duration.

## Wiring

L298N motor driver:
```
ENA  = GPIO 12  (left PWM)
IN1  = GPIO 13  (left direction A)
IN2  = GPIO 14  (left direction B)
ENB  = GPIO 25  (right PWM)
IN3  = GPIO 26  (right direction A)
IN4  = GPIO 27  (right direction B)
```

## Configuration

Edit the top of `Robot_WiFi_Remote_Control_v1.ino` before flashing:

```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

const bool USE_STATIC_IP = false;  // true for fixed IP
const IPAddress STATIC_IP(192, 168, 1, 50);
// ...
```

## Calibration

If the robot drifts when driving straight, use the calibration sketch in `../ground-skidsteer-calibration/` and adjust `LEFT_TRIM` / `RIGHT_TRIM` in the main sketch.

## Flashing

Standard ESP32 Arduino IDE / arduino-cli flow:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 Robot_WiFi_Remote_Control_v1.ino
arduino-cli upload --fqbn esp32:esp32:esp32 --port /dev/ttyUSB0 Robot_WiFi_Remote_Control_v1.ino
```
