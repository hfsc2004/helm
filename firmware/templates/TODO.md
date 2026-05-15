# Template TODO

Sketches imported from PSF Core but not yet converted into Helm templates. Raw sources live at `firmware/raw-from-core-ce/`. The format we're targeting is documented in `core/firmware-flash/README.md`.

## How to convert a raw sketch into a template

1. Create `firmware/templates/<id>/`.
2. Copy the raw `.ino` to `firmware/templates/<id>/sketch.ino`.
3. Decide which constants in the source should be **template variables** (per-user / per-deployment) vs. **baked-in** (board-standard, never tune). Replace the chosen constants with `{{key}}` placeholders. For IPv4 strings, place `{{key.octets}}` where Arduino's `IPAddress(a, b, c, d)` constructor expects comma-separated octets — the renderer auto-derives this from a `{{key}}` of the form `"a.b.c.d"`.
4. Write `template.json` next to it. Required fields:
   - `id` — must match the directory name
   - `name`, `description` — for UI / `flash-templates` listing
   - `target` — `esp32`, `esp32s3`, `pico`, `pico2`
   - `fqbn` — full arduino-cli FQBN (with extras for boards that need them, e.g. `esp32:esp32:esp32s3:PSRAM=opi,FlashMode=qio,...`)
   - `core` — arduino-cli core (e.g. `esp32:esp32`)
   - `vars[]` — array of `{ key, type, required?, default?, label? }` where `type` is `string | secret | number | boolean`
5. Smoke-test:
   - `npm run helm -- flash-template-show <id>` — manifest loads cleanly
   - `npm run helm -- flash-render --template <id> --var key=value,...` — renders without errors, sketch looks right
   - (with hardware) `npm run helm -- flash <port> --template <id> --var ... --dry-run` — staging file is valid C++

## Pending templates

### `ground-skidsteer-calibration` — Robot_SkidSteer_Calibration.ino

**Difficulty: easy (~15 min).**

Bench-test sketch for tuning left/right motor balance. Run with the wheels off the ground. Adjust `LEFT_BASE` / `RIGHT_BASE` and `INVERT_*` until both wheels turn at matched speed. Then transfer those numbers into the main truck firmware.

Likely vars:
- `motor.leftBase` (number, default 170, range 0..255) — base PWM for left motor
- `motor.rightBase` (number, default 170, range 0..255) — base PWM for right motor
- `motor.invertLeft` (boolean, default false)
- `motor.invertRight` (boolean, default false)

Same FQBN/core as the truck (`esp32:esp32:esp32`).

### `ground-skidsteer-obstacle-avoidance` — Robot_Obstacle_Avoidance_calibrated.ino

**Difficulty: medium (~30-45 min).**

Standalone autonomous obstacle avoidance using IR proximity sensors. No remote control — the robot drives and avoids on its own. Useful for "set it down, watch it explore" demos.

`_calibrated` is the canonical variant. The other two (`_geometry_v3`, `_stable_v2`) are kept in raw-from-core-ce for reference but probably should not become templates.

Likely vars (from reading the source — needs verification):
- `motor.leftTrim` (number)
- `motor.rightTrim` (number)
- `motor.invertLeft` / `motor.invertRight` (boolean)
- `sensor.activeHigh` (boolean) — true if larger ADC = closer object
- `threshold.close` / `threshold.medium` / `threshold.far` (number)
- `speed.full` / `speed.turn` / `speed.slow` / `speed.reverse` (number)
- `timing.reverseMs` / `timing.turnMs` (number)

Same FQBN/core as the truck.

### `esp32s3-camera-elegoo` — ESP32_CameraServer_AP_2023_V1.3.ino

**Difficulty: hard (~1-2 hours).** This one has real wrinkles.

The Elegoo ESP32-S3-Camera-V1.0 board's MJPEG / snapshot / health firmware. Used as the camera sidecar that the truck (and the eventual drone) report through.

Hardware-specific notes (from the existing `docs/elegoo_esp32s3_camera_relay_instructions.md`):
- FQBN must include `:PSRAM=opi,FlashMode=qio,FlashSize=8M,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=default_8MB`
- Requires the cloned `esp32-camera` library (NOT shipped with arduino-esp32 3.3.7)
- GPIO46 power-cycle dance before `esp_camera_init()` or you get `0x106 ESP_ERR_NOT_SUPPORTED`
- `server.send_P()` must be used for binary frames (not `server.send()` + `client.write()`)

**Real wrinkles for templating:**

1. **External library dependency.** This sketch needs `https://github.com/espressif/esp32-camera` cloned and passed to `arduino-cli compile --libraries <path>`. Our `template.json` schema does not yet model `requiredLibs` or `requiredClonedLibs`. **This is a real schema extension, not just a templating exercise.** Two paths:
   - Add `requiredClonedLibs: [{repo, refOrTag, localPath}]` to `template.json`. The flash flow `git clone`s the repo into `<dataDir>/firmware-libs/` on first use, then passes `--libraries` to arduino-cli.
   - Or: commit the `esp32-camera` library into `firmware/libs/esp32-camera/` (~10MB) and reference it locally. Simpler at the cost of repo size.
2. **Many decisions on what's a var.** WiFi creds yes. Static IP yes. AP mode vs STA yes. JPEG quality probably (10-30 range). Frame size probably (FRAMESIZE_SVGA default). The OV3660 pin map should be **baked-in** — it's hardware, not user choice.
3. **The pre-compiled .bin is in raw-from-core-ce.** That's a known-good image. Question for later: do we offer a "flash this prebuilt .bin instead of compile-from-source" path? Saves the user from arduino-cli + esp32-camera library setup if they just want a working camera. Different flash backend (esptool not arduino-cli).

Likely vars (initial guess, needs verification):
- `wifi.ssid` (secret, required)
- `wifi.password` (secret, required)
- `wifi.useStatic` (boolean)
- `wifi.staticIp` (string)
- `camera.jpegQuality` (number, default 10, range 4-63)
- `camera.frameSize` (string enum: SVGA / VGA / QVGA / HD)

## Other things to settle before this list is done

- **Schema extension for required cloned libraries** (blocker for the camera template — see above).
- **Schema extension for required-installed libraries** (for any sketch using `arduino-cli lib install <name>` packages).
- **Schema extension for pre-flash hooks** (e.g. `esptool.py erase_flash` before upload, for boards that need it).
- **Post-flash verification** — open the serial port at the configured baud, look for an expected boot token (e.g. truck firmware prints `HTTP control server running on port 8080` after WiFi connects). Right now we trust arduino-cli's exit code only.
- **Pre-built `.bin` flash path** — for the camera, an alternative "no compile" route using esptool directly.
- **Pico / Pico 2 templates** via mpremote. Different toolchain, different format (no compile step, just push a `.py` file). Will need a separate `target: pico` family of templates and a different code path in `core/firmware-flash/flash.ts` that dispatches to mpremote instead of arduino-cli.

## Repo hygiene

- `firmware/raw-from-core-ce/ESP32-S3-WROOM-1-Camera/` includes a 2.96 MB pre-compiled `.bin` and ~1.7 MB of PDFs. Decision deferred: keep them for reference, move to a release-asset bucket, or `.gitignore` the .bin specifically. Not blocking.
