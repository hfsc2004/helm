# CLI (`helm`)

The agent-first command-line surface for PSF Helm. Subcommands are designed for frontier models and scripts, not primarily for humans.

## Design rules

- Output is JSON by default. `--pretty` produces human-readable output.
- Streaming commands emit NDJSON (newline-delimited JSON) on stdout.
- Logs go to stderr; stdout stays clean for event streams.
- Every command supports `--timeout <ms>`, `--trace-id <id>`, `--dry-run` where mutating.
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
