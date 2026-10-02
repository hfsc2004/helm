# CLI (`helm`)

The agent-first command-line surface for PSF Helm. Subcommands are designed for frontier models and scripts, not primarily for humans.

## Design rules

- Output is JSON by default. `--pretty` produces human-readable output.
- Streaming commands emit NDJSON (newline-delimited JSON) on stdout.
- Logs go to stderr; stdout stays clean for event streams.
- Every command supports `--timeout <ms>`, `--trace-id <id>`, `--dry-run` where mutating.
- `helm vehicle-uno <id> status|ultrasonic|line|servo|motor|stop|rgb-off|baud`
  uses the v1.3 board's port-82 ELEGOO UART bridge. `motor` requires
  `--direction`, `--speed`, and `--ms`; it sends only a bounded 100–800 ms
  pulse. `servo` requires `--angle 10..170`. Start with `status` and the
  sensor queries; do not test motors until the wheels are clear of the ground.
- Exit codes are distinct (0 success, 1 command failure, 2 transport failure, 3 safety abort, 64 usage error).
- `helm describe` emits the full command schema as JSON so agents can introspect without parsing help text.

## Layout

- `helm.ts` — entry point, argument parser, command dispatcher
- `commands/` — one file per subcommand; each registers a `CommandDef` and an execute function
- `output.ts` — JSON / NDJSON / pretty output helpers; stdout discipline

## PSF Sensor Board v1.3 speaker

With `ffmpeg` installed on the Helm computer, play a local audio file through
the v1.3 board's speaker:

```bash
npm run helm -- vehicle-speaker-play <vehicle-id> <audio-file>
```

Helm decodes to 16 kHz signed 16-bit stereo PCM and streams it to the board's
port-82 `/speaker-pcm` endpoint. The board buffers 32 KiB and applies
backpressure; the entire audio file is not loaded into board memory. By
default the command derives the host from the vehicle's camera URL; use
`--base-url http://<board-ip>:82` if that address differs. The vehicle must be
registered as Sensor Board v1.3. See the [firmware bench notes](../firmware/templates/sensor-board-v1-3-esp32s3/README.md).

## PSF Sensor Board v1.3 ToF modes

The board starts both single-zone ToF sensors in automatic mode. While Helm's
Drive panel (or another client) polls `/ranges`, an invalid return lasting
about two seconds makes that sensor try Short, Medium, and Long in sequence.
A valid return holds its current mode. Agents can inspect or override the
mode without reflashing:

```bash
npm run helm -- vehicle-tof-mode Truck status
npm run helm -- vehicle-tof-mode Truck long --sensor front
npm run helm -- vehicle-tof-mode Truck auto --sensor front
```

`--sensor` also accepts `rear` or `both` (the default). An explicit mode
disables automatic fallback for the selected sensor until `auto` is restored
or the board reboots. The 8×8 wide sensor is unaffected.

## SR Front VL53L5CX profiles

The SR Front sensor supports runtime 4×4/8×8 switching. It is separate from
the LR Front and Rear VL53L1CB sensors controlled by `vehicle-tof-mode`.

| Profile | Helm display name | Grid | Default / allowed Hz | Observed range at default Hz | Ranging |
| --- | --- | --- | --- | --- | --- |
| `detail` | Balanced Detail | 8×8 | 10 | ~4 ft | Continuous, strongest target |
| `navigation` | Close Detail | 8×8 | 15 / 10–15 | ~3 ft | Continuous, strongest target |
| `fast` | Extended Reach | 4×4 | 30 / 30–60 | ~6 ft | Continuous, strongest target |
| `idle` | Low Power | 4×4 | 2 / 1–2 | ~3 ft | Autonomous, 5 ms integration |
| `inspect` | Far Detail | 8×8 | 5 / 5–10 | ~5 ft | Continuous, plus signal/ambient/target diagnostics |

Display names reflect the user-reported SR Front tests on 2026-10-02.
Observed ranges are not guaranteed limits and do not apply to other rates.
CLI and firmware identifiers remain unchanged.

```bash
npm run helm -- vehicle-wide-tof Truck status
npm run helm -- vehicle-wide-tof Truck detail
npm run helm -- vehicle-wide-tof Truck navigation --hz 15
npm run helm -- vehicle-wide-tof Truck fast --hz 60
npm run helm -- vehicle-wide-tof Truck idle --hz 1
npm run helm -- vehicle-wide-tof Truck inspect
npm run helm -- vehicle-wide-tof Truck frame
```

`4x4` aliases `fast`; `8x8` aliases `detail`. `frame` returns the latest
cached frame and its age, resolution, profile, requested frequency, frame
sequence, and last captured-frame interval. Inspect frames also contain
per-zone `signalKcpsPerSpad`, `ambientKcpsPerSpad`, `targetCount`, and the
usual `targetStatus`. These are driver-reported values, not calibrated
obstacle decisions. Capture throughput may fall below the requested sensor
rate because of I²C, scheduling, or HTTP load.

Agents should select Detail when stopped/observing, Navigation for normal
travel, Fast for faster motion, Idle when unused, and Inspect for diagnosing
returns. Profiles are explicit choices; motor commands do not change them.
The board boots into Low Power (`idle`): 4×4 at 2 Hz, autonomous ranging,
with a 5 ms integration time. Runtime changes last until changed or rebooted.
Updated sensor-board firmware is required; Helm does not flash it automatically.

## PSF Sensor Board v1.3 relative orientation

`GET /imu` includes boot-relative roll, pitch, and yaw after the board has
collected 80 stationary samples for gyro-bias calibration. Roll and pitch are
corrected toward gravity; yaw has no compass reference and can drift. An agent
can set the current stationary pose as zero without reflashing:

```bash
npm run helm -- vehicle-imu-zero Truck
```
