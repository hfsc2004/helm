# PSF Sensor Board v1.3 — first firmware

This is the first **bench bring-up** image for the ESP32-S3-CAM mounted on the
GSN Robotics / PSF Sensor Board v1.3. It keeps the existing Helm camera API and
adds diagnostics that remain reachable while MJPEG is streaming. It does not
provide a drive endpoint or motor controls; no separate drive ESP32 is assumed
for this v1.3 bring-up configuration.

## Implemented

- Camera on port 81: `GET /health`, `GET /capture`, `GET /stream`.
  The optional `camera.hmirror` flash setting applies the camera sensor's
  horizontal mirror control at boot. Port 82 also provides
  `POST /camera/mirror?enabled=0|1` for a live orientation check without
  reflashing; `/health` reports the applied `cameraMirrored` state. The
  Freenove replacement camera currently needs this setting enabled, while
  the original GOOUUU camera used the default (disabled).
- ELEGOO Smart Robot Car V4.0 Uno UART bridge on port 82: GPIO44 receives
  Uno TX through the 5 V-to-3.3 V divider, while GPIO43 transmits to Uno RX,
  at 9600 baud.
  On mounted hardware, the Uno has acted on RGB-off and reverse motor commands,
  but the ESP has received no reply bytes; Uno TX / ESP RX remains unresolved.
  The ESP releases its UART0 debug console before attaching UART1 to those
  pins. `GET /uno/status` is passive; `POST /uno/baud?baud=9600|19200|38400|57600|115200`
  changes the listening speed at runtime. For UART bring-up, `POST /uno/pins?rx=44&tx=43`
  restores the default ESP pin roles without another flash; boot defaults to
  RX44/TX43, matching the traced TX/RX wiring and voltage divider. Earlier
  firmware builds mistakenly booted with RX43/TX44.
  `GET /uno/ultrasonic` sends ELEGOO
  `N21,D1=2`; `GET /uno/line` sends `N22,D1=0..2` for left/middle/right.
  `POST /uno/servo?channel=1|2&angle=...` sends `N5` to servo 1 (D10,
  10..170°) or servo 2 (D11, 30..110°), rounded to the stock sketch's
  ten-degree resolution. The D10 range stays within 80° of the 90° center,
  below the mounted board's ±90° cable limit.
  `POST /uno/motor-pulse?direction=left|right|forward|reverse&speed=0..160&ms=100..800`
  sends the stock firmware's timed `N2` command, waits for completion, then
  sends `N110` stop; `POST /uno/stop` sends the same stop immediately. The
  keyboard-only Drive view uses `POST /uno/drive` with the same bounded speed
  and duration, and `POST /uno/drive-stop`. These return promptly after the
  ESP writes to UART, so holding a key can refresh an Uno-timed pulse; a local
  ESP timer also sends `N110` when pulses cease. `sent: true` does not mean
  the Uno acknowledged the command. The Drive view checks
  `driveCommandVersion: 1` from `GET /uno/status` before enabling the keys.
  No on-screen keypad is added for v1.3. The four physical motors are wired
  as left and right pairs by the ELEGOO shield,
  not individually addressable wheels. `POST /uno/rgb-off` sends `N8` with
  zero RGB values; it does not control a hardwired Uno power LED. After the
  ESP boots, it sends Uno stop/clear and shield RGB-off three times, one
  second apart, to cover boot-order differences. This is not a persistent
  change to the Uno: an independent Uno-only reset can relight the LED until
  the command is sent again or the ESP restarts. These commands assume the
  stock ELEGOO V4 serial protocol; a different Uno sketch may not respond.
  Do not treat the silent Uno return path as valid distance telemetry.
- Diagnostics on port 82: `GET /diagnostics` lists I²C addresses, reads back
  the TCA9534 output/configuration registers, and reports whether the ToF
  default address and IMU address respond. The expander is initialized after
  Wi-Fi setup so the sensor rail has time to settle. Address presence is
  **not** a working distance or motion measurement. The three ToFs share
  `0x29` only before the two narrow devices receive their new addresses.
- Narrow ranging on port 82: `GET /ranges` uses the VL53L1CB histogram
  driver, rather than the VL53L1X driver. The devices are assigned `0x30` and
  `0x31` at startup. Measurements run continuously; HTTP requests read cached
  results and never trigger a blocking ranging cycle. `distanceMm` is returned
  only for a fresh, valid result. `ageMs` and `driverError` expose stale frames
  and I²C/driver failures. Each sensor alternates a full-field ranging phase
  with a four-region scan (the four 8×8-SPAD quadrants). The full field starts
  in Medium mode, and the quadrants always use Short mode. Each region reports
  its latest raw targets, age, and a distance confirmed by two similar valid
  samples. Confirmed values persist but their age keeps increasing; consumers
  must not treat stale values as current obstacle readings. After about two
  seconds without new frames, a scan watchdog restarts that sensor in the
  full-field phase; `/ranges` exposes its `recoveryCount`. After about two
  seconds without a valid full-field return, automatic fallback tries Long,
  then Short, then Medium. A valid return holds the full-field mode. With the
  CB Ranging preset, Medium is ST's maximum-distance setting; Long favors
  lower power. The `full` result is the strongest valid target over the whole
  field, not a directional center-only measurement.
  `GET /tof-mode` reports the active modes; `POST /tof-mode?mode=auto|short|medium|long&sensor=front|rear|both`
  changes them without reflashing. A pinned mode lasts until changed or rebooted.
  `/ranges` also reports Wi-Fi RSSI in dBm so the Drive readout does not need
  to poll the camera server while MJPEG is streaming. Helm's Drive view shows
  all five regions for front and rear, plus an approximate front-quadrant
  overlay on the separate VL53L5CX 8×8 map. The CB quadrants and wide pixels
  are not calibrated to one another, and chip ROI left/right orientation has
  not yet been verified on the mounted board.
- Wide ranging on port 82: `GET /wide-range` returns the latest VL53L5CX
  8×8 frame as 64 raw millimeter distances and 64 target-status values,
  with its age in milliseconds. The sensor remains at `0x29`. Live frames
  were received on the bench; raw values are not collision decisions.
- IMU on port 82: `GET /imu` serves the latest ICM-42607-C sample of three
  accelerometer and three gyro axes, plus die temperature. It reports both raw
  counts and nominal g / degrees-per-second values at 100 Hz, ±2 g and
  ±250 dps settings. Live chip ID `0x61` and repeat samples were verified;
  a stationary, box-leaning board measured about 1 g in vector magnitude
  and near-zero angular rate. The first sample showed transient `-1` values
  on several axes, so consumers should not treat every single sample as
  calibrated truth. When placed flat on its back, two samples measured
  approximately X = -0.116 g, Y = -0.008 g, Z = +1.003 g, with near-zero
  angular rate. The earlier leaning sample was approximately Y = -0.839 g,
  Z = +0.550 g; this confirms the expected shift toward chip +Z when laid
  flat. Those two vectors differ by roughly 57 degrees, so the earlier
  estimated 80–85 degree physical angle is not yet a calibration reference.
  Axes are in the chip's frame, not a verified truck-forward frame; no
  mounting correction is applied. Firmware now samples continuously near
  50 Hz, discards implausible I²C samples, and averages 80 stationary samples
  after startup to measure gyro bias and set the boot pose to roll/pitch/yaw
  zero. A quaternion integrates gyro motion between Helm polls and uses gravity
  for roll/pitch correction. `orientationDeg` reports the estimated pose
  relative to that boot reference; yaw remains relative and slowly drifts
  without a compass. `POST /imu/zero` resets the reference to a fresh,
  stationary pose without reflashing. `orientationReady` remains false until
  startup calibration completes.
- Experimental stereo PDM capture on port 82: `GET /mic-levels` samples both
  channels for 128 ms and reports DC mean, AC RMS and peak counts;
  `GET /mic-capture.wav` returns a one-second, 16 kHz, 16-bit stereo WAV.
  The schematic routes the shared PDM clock to GPIO21 and data to GPIO14,
  with opposite microphone L/R straps. `GET /mic-pin-test` samples the two
  GPIO pads to help distinguish a missing clock from a stuck data line.
  `GET /mic-line-test` briefly stops PDM capture, reads GPIO14 with weak
  internal pull-up and pull-down, then restores capture.
  `GET /mic-raw-clock-test` instead stops PDM capture, generates an independent
  2.048 MHz clock on GPIO21, reads GPIO14 as plain GPIO for highs/transitions
  with no pull and with a weak pull-up, then restores PDM capture. This
  separates microphone DATA activity from the I²S receiver configuration.
  `GET /mic-pcnt-test` uses the same independent clock but counts GPIO14
  rising edges in hardware over 5 ms, avoiding software-polling aliasing.
  It also counts GPIO21 edges as a clock/control check; a zero DATA count
  is meaningful only if the clock count is nonzero. The endpoint restores
  PDM capture before responding.
  For a DC multimeter check, `POST /mic-clock-low` or
  `POST /mic-clock-high` stops microphone I²S and holds GPIO21 as an output
  at 0 or 3.3 V until `POST /mic-clock-restore` (or a reboot) restores the
  normal PDM clock. Microphone capture is unavailable while held.
  `GET /mic-clock-edges` counts GPIO21 rising edges over 5 ms while held,
  distinguishing a static level from a clock the DC meter would average.
  Helm exposes these as `helm vehicle-mic-clock <id> low|high|edges|restore`;
  use the vehicle's registered camera
  host automatically, or pass `--base-url http://<board-ip>:82`.
  `GET /mic-live-pull-test` leaves the PDM clock running, briefly applies
  a weak internal pull-up to GPIO14, and removes it after sampling.
  The ESP32-S3 PDM RX decimation is set to 16S, producing a configured
  2.048 MHz PDM clock while retaining 16 kHz stereo PCM output;
  `/mic-levels` reports this as `configuredPdmClockHz`.
  `microphonesReady` means only that the ESP32 I²S peripheral initialized;
  it does **not** mean sound has been received. There is no continuous audio
  stream or voice filtering in this bring-up firmware. These endpoints are
  accessible to devices on the board's local network and should not be
  exposed to an untrusted network.
- Speaker test on port 82: `POST /speaker-test` writes a 350 ms, 660 Hz,
  low-amplitude tone to both I²S slots and then stops writing audio. Rev 1.3
  routes MAX98357A DIN to GPIO47, BCLK to GPIO41, and LRCLK to GPIO42.
  Its SD_MODE# pin is driven by TCA9534 P4, which must be configured as an
  output-high to enable the amplifier. The first live speaker test was silent
  even though the I²S writes succeeded: bring-up-8 left P4 as an input.
  Bring-up-9 drives P4 high at initialization and verifies the input-port
  reading before playback; `speakerAmpEnabled` reports that pin state, not
  acoustic output. After flashing bring-up-9, the expander reported P4
  output-high (`expanderConfig=224`, `expanderInput=23`), the 100 KiB sample
  streamed successfully, and the user heard it. The tone endpoint also
  returned success, though its audibility was not separately confirmed.
  The current template changes that startup order: it holds P4 low while the
  ToF devices and speaker I²S initialize (with an early best-effort shutdown
  as soon as I²C starts), writes silence to establish the
  audio clocks, then enables P4 and plays `PSF_Chime.wav` once at boot. Just
  before the chime, the RGBW LEDs chase over one second: lower right, upper
  left, then upper right (truck-forward perspective), starting dark blue at
  roughly 2.5% brightness and shifting to a 50/50 blue-white mix at roughly
  5%. All three light together when the chime starts, transition to white
  during its opening, then return to dim dark blue during the decay before
  turning off at the end. `POST /startup-sequence` replays the full LED-and-
  chime sequence for live tuning without rebooting.
  The bundled `startup_chime.h` is the 1.55-second source converted from
  44.1 kHz stereo to 16 kHz mono PCM; playback duplicates the samples into
  both I²S slots at 22.5% gain with short fades. Regenerate the header with
  `node firmware/templates/sensor-board-v1-3-esp32s3/generate-startup-chime.mjs`.
  Helm stages the header with the sketch on every flash. The boot chime now
  plays before allocating the 32 KiB streaming queue, preserving heap during
  its first I²S writes. If the expander or speaker I²S is unavailable,
  the chime is skipped. The signed PCM fix and final LED/chime sequence were
  verified by listening on the live board. An intermittent expander-init
  failure can still skip the sequence on some resets; power cycling restored
  the board during bench testing. `/health` and
  `/diagnostics` report `startupChimePlayed` so a missed boot sound can be
  distinguished from an initialization failure.
  `POST /speaker-chime` replays the same embedded PCM after boot and reports
  the playback stage, bytes written, and I²S error. Comparing its sound with
  the automatic boot chime separates audio-data problems from boot timing.
  `POST /speaker-pcm` accepts a multipart form file (field name `file`) of
  16 kHz, signed 16-bit, little-endian, stereo interleaved PCM. It writes
  incoming chunks into a 32 KiB board-side playback queue, prebuffers about
  half of it, and drains the queue to I²S from a dedicated task. The upload
  pauses when the queue is full, so it does not load the whole file into ESP32
  RAM. A separate four-byte buffer aligns stereo frames at chunk boundaries.
  Helm's `vehicle-speaker-play` command
  decodes the source file with local `ffmpeg` and streams that PCM to the
  board. The 10 KiB, 100 KiB, and 500 KiB MP3 samples are all suitable; the
  board has no file-size-specific upload cap. From the repository root:

  ```sh
  curl -X POST http://172.20.0.191:82/speaker-test
  npm run helm -- vehicle-speaker-play <vehicle-id> sample-10kb.mp3
  ```

  The Helm command derives the sensor-board host from the configured camera
  URL and uses port 82; `--base-url http://<board-ip>:82` overrides that.
  `speakerReady` confirms only I²S initialization, not audible output. The
  tone and PCM endpoints are bench-only and accessible to other devices on
  the board's LAN; there is no speech synthesis or authenticated playback
  service. The Helm command requires `ffmpeg` on the computer.
- RGBW test on port 82: `GET /led?index=0&r=0&g=0&b=0&w=0`. Index is 0–2;
  channels are 0–255. All LEDs start off. The SK6812 wire order is GRBW.
  On the tested board, index 0 is upper right, index 1 is upper left, and
  index 2 is lower right from the truck's forward-facing perspective (looking
  away from the observer).
- The TCA9534 uses P0–P1 for the two VL53L1CB XSHUT lines, P2 for VL53L5CX
  LPn, P3 for VL53L5CX I2C_RST, and P4 for the speaker amplifier SD_MODE#.
  P0–P4 are outputs; P5–P7 remain inputs. On the bring-up-9 bench flash,
  all three ToF readiness flags were true after startup.
- Wi-Fi STA with DHCP or static IP; `<name>.local` mDNS when available.

## Still to bring up

IMU axis-orientation and bias calibration, working stereo PDM capture, speaker
volume/quality evaluation, IR emitter control, and motor/control integration remain. `/diagnostics` returns
`null` for its legacy distance and IMU sample fields; use `/ranges`,
`/wide-range`, and `/imu` for sensor readings.

On the first microphone bench test, the PDM clock on GPIO21 toggled
(approximately half of 10,000 pad samples high), but GPIO14 stayed low for
all 10,000 samples. Both channels in the captured WAV were a constant
`-30935` PCM count and `/mic-levels` reported zero AC RMS. This is **not a
working microphone result**. A follow-up flash changed the clock from the
Arduino default 1.024 MHz to 2.048 MHz, within the microphone's specified
standard-performance range. GPIO14 still stayed low in all 10,000 samples,
and both channels still returned `-30935` with zero AC RMS. With the
clock stopped, the no-probe `/mic-line-test` saw GPIO14 high for all 1,000
pull-up samples and low for all 1,000 pull-down samples, then restored
capture successfully. This rules out a permanent hard-low at the ESP32 pad,
but GPIO14 still read low for all 10,000 samples with capture running.
The user then measured approximately 3.3 V at both microphone decoupling
capacitors. With PDM running, `/mic-live-pull-test` read GPIO14 high in all
10,000 samples while the weak pull-up was enabled, versus low in all 1,000
baseline samples. The pull-up was removed successfully, but GPIO14 then
remained high in subsequent GPIO sampling while `/mic-levels` still returned
constant `-30935` audio with zero AC RMS. This argues against a strong
clock-dependent short and leaves either absent microphone data at the pad or
an ESP32 PDM input-routing/capture fault to distinguish next.
Bring-up-10 isolated that distinction further: after stopping PDM I²S, a
separate LEDC clock ran at 2.048 MHz on GPIO21 (5,101 of 10,000 clock-pad
samples high). GPIO14, read as ordinary GPIO without pulls, was high 0 of
10,000 times with zero transitions; a weak pull-up then made it high 10,000
of 10,000 times. PDM capture was restored, but both PCM channels remained
fixed at `-30935` with zero AC RMS. This points to no driven microphone DATA
reaching the ESP32 pad during the test, rather than only a PDM-to-PCM driver
configuration problem. It does **not** establish whether clock reaches the
actual microphone pins, whether their solder joints/data trace are intact,
or whether both microphone ICs are producing data. Those require a physical
signal check at a microphone or another independent observation point.
On a fresh boot, I²S PDM RX allocated port 0, excluding accidental I²S1
selection. The subsequent independent PCNT test counted 0 GPIO14 DATA
rising edges in each of three 5 ms windows, while GPIO21 CLK counted
10,245–10,246 rising edges per window at 2.048 MHz. Both counters reported
`ESP_OK`, and PDM capture was restored after each test. `/mic-levels` still
reported both channels fixed at `-30935` with zero AC RMS. Hardware edge
counting removes software-polling aliasing as an explanation for the zero
DATA transitions. It confirms the clock at the ESP32 pin, not at the
microphone packages; a clock-path, DATA-path, solder, or microphone-power
fault remains possible.
For a multimeter check at the module-side GPIO21 point, normal PDM clock
read about 1.64 V DC and a commanded high hold read 3.27 V. Two commanded
low holds read about 1.7–1.8 V on the user's meter even though ESP32
digital readback was low. A follow-up hardware PCNT count during the held-low
state found **zero GPIO21 rising edges in 5 ms** (`ESP_OK`), then restored
PDM capture. Thus a full-swing 2.048 MHz clock still running at the ESP32
pad is not supported; the analog midrail reading at the probe point remains
unexplained. Do not infer a specific bad trace or component from this alone.
The ESP32-S3-CAM module was then replaced with another module of the same
type and flashed with the same firmware. On the replacement, Wi-Fi joined at
`172.20.0.178` and remained reachable after a USB reset. Microphone capture
was unchanged: both channels stayed at `-30935` with zero AC RMS. The
independent PCNT test counted 0 DATA rising edges on GPIO14 and 10,244 CLK
rising edges on GPIO21 in 5 ms, then restored PDM capture. This makes a fault
unique to the original ESP32-S3-CAM module unlikely; it does not yet locate
the fault on the sensor board or prove the clock reaches either microphone.
With the replacement module installed, the west socket GPIO21 contact read
about 1.64 V DC under the normal clock, but 2.2 V when Helm held GPIO21
low. At that same time the ESP32 reported digital pad level 0 and PCNT
counted zero rising edges in 5 ms. The clock was restored afterward.
Because the west socket voltage disagrees with a commanded static low on
both modules, inspect the module-to-socket contact and board-side net before
inferring microphone failure. A power-off continuity check from the module's
GPIO21 solder/pin to the west socket contact would directly test that path.

On these later flashes the shared I²C bus was also intermittent: IMU configuration reads
occasionally failed and one `/imu` burst returned implausible all-`-1` axes.
Do not treat `imuReady` alone as proof of a valid live sample on an unstable
power/bus setup. `/diagnostics` now reports the IMU's configuration-register
readbacks to help distinguish an absent chip from failed configuration.
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
**GSN Robotics - PSF Sensor Board v1.3 (bring-up)**. The camera pin map matches
the tested GOOUUU and Freenove ESP32-S3-CAM modules; do not select an unrelated
pin profile. The Sensor Board's own USB-C socket is power-only. Use the
ESP32-S3-CAM module's programming connector for flashing, after confirming
the module and serial port.

The default FQBN is `esp32:esp32:esp32s3:PSRAM=opi,PartitionScheme=no_ota`,
used for both tested modules, including the Freenove N16R8 replacement. The
2 MB app partition fits the CB driver even on a 4 MB module; it does not
support OTA updates. Set `camera.hmirror=true` for the tested Freenove camera.
The VL53L1CB driver is bundled under `src/` from STM32duino VL53L1 2.1.0,
with a bounded, error-reporting ESP32 I²C adapter and its license in
`VL53L1-LICENSE.md`. Helm installs Adafruit VL53L5CX 1.0.1 during a normal
flash if needed. The template can be rendered without upload:

```bash
npm run helm -- flash-render --template sensor-board-v1-3-esp32s3 \
  --var 'wifi.ssid=Bench,wifi.password=placeholder'
```

The hardware-reference PDFs, photos, and pinout are kept locally and are not
included in this repository.
GPIO4 is shared with the camera SCCB connection; leave the IR switch in its
default expander-controlled position while the camera is active. The speaker
terminals are differential; neither is ground.
