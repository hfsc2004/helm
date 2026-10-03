# Microphone restoration investigation

## Observed evidence

Operator measured DATA approximately 81 mV during clock-only and slave RX
phases, then approximately 3.0 V after normal capture was restored. Both
phases used the same continuous LEDC clock and GPIO14 input-only, pulls off.
A subsequent read-only `/mic-gpio` query on the installed firmware reported
GPIO14 **pullUp=true** both immediately after normal PDM enable and currently;
pullDown=false, inputEnable=true, outputEnable=false, matrix input signal 25.
This differs from the pull-free diagnostic snapshots. It explains a possible
bias source without establishing the first physical voltage transition.

Espressif ESP-IDF v5.5.2 `gpio_reset_pin()` enables the pull-up, disables the
pull-down, disables input/output, selects GPIO IO_MUX, and revokes pin ownership.
Reference: https://github.com/espressif/esp-idf/blob/v5.5.2/components/esp_driver_gpio/src/gpio.c
The normal restoration calls this API on GPIO14. The subsequent PDM driver
`i2s_gpio_check_and_set()` input path only selects the GPIO function, enables
input, and connects the input matrix; it does **not** disable either pull. Thus
a reset-enabled pull-up can persist into normal capture. Reference:
https://github.com/espressif/esp-idf/blob/v5.5.2/components/esp_driver_i2s/i2s_common.c
Do not fix/remove the reset call until the operator measures the checkpoints.

## Actual restoration call order

From the end of Phase 2, the normal restoration sequence is:

1. `cancelMicrophoneComparison()`:
   - `i2s_channel_disable(micComparisonRx)`.
   - `i2s_del_channel(micComparisonRx)`; discard the deleted handle.
2. `ledcDetach(GPIO21)` if the independent clock is active. This stops that clock.
3. `gpio_reset_pin(GPIO21)`.
4. `gpio_reset_pin(GPIO14)`.
5. Clear diagnostic software flags.
6. `initMicrophones()`:
   - `setPinsPdmRx(GPIO21, GPIO14)` (stores wrapper pin selections).
   - `setTimeout(1000)` (Stream timeout).
   - `begin(PDM_RX, 16000, 16bit, stereo)` invokes `initPDMrx()`:
     - `perimanClearPinBus(GPIO21)`, then `perimanClearPinBus(GPIO14)`.
       These can invoke prior owner detach callbacks; the old wrapper channel
       was already ended when the comparison began.
     - Register PDM RX CLK and DIN0 detach callbacks via `perimanSetBusDeinit()`.
     - `i2s_new_channel()`, AUTO port, MASTER role, six DMA descriptors, 240 frames.
     - Assign wrapper sample rate/data width/slot mode.
     - `i2s_channel_init_pdm_rx_mode()` with wrapper defaults: 8S/1.024 MHz,
       16-bit stereo, CLK GPIO21, DIN0 GPIO14, unused DIN1-3 = -1.
       The driver configures slots, GPIO/matrix, clocks, DMA, and PDM conversion.
     - `i2s_channel_enable()`.
     - `perimanSetPinBus(GPIO21, PDM_RX_CLK)`, then
       `perimanSetPinBus(GPIO14, PDM_RX_DIN0)`.
     - Return from `begin()`.
   - `i2s_channel_get_info()` (read-only port/info query).
   - Construct default clock config for 16000 PCM, set 16S decimation.
   - `i2s_channel_disable()`.
   - `i2s_channel_reconfig_pdm_rx_clock()` (16S / 2.048 MHz).
   - `i2s_channel_enable()`.
   - Save the post-enable GPIO14 snapshot; update readiness; log result.
7. Return from normal initialization/restoration.

Source for the wrapper: Arduino ESP32 3.3.7 ESP_I2S. The instrumented copy has
identical initialization defaults and call order, adds hooks after each relevant
API operation, and uses a distinct class name. The SDK and speaker stay untouched.
Normal firmware boot, captures, and restores never pause unless tracing is opted in.
The driver API calls are atomic checkpoints; this does not claim to pause inside
Espressif's precompiled driver internals. If a change first appears after a driver
API call, the raw register diff identifies which part needs finer investigation.

## Remotely stepped procedure

Flash the instrumentation once. Start from normal capture:

```bash
helm vehicle-mic-clock Truck trace-start
helm vehicle-mic-clock Truck compare-status # measurement phases only
helm vehicle-mic-clock Truck trace-status
helm vehicle-mic-clock Truck trace-next --step 0
helm vehicle-mic-clock Truck trace-status
helm vehicle-mic-clock Truck trace-abort
```

`trace-start` runs the two 30-second phases with 100 ms initial settling. At the
end of Phase 2 it starts a core-1 restoration task and pauses BEFORE restoration
as checkpoint 0. It then waits indefinitely at each subsequent checkpoint.
Record the voltage and operation at every step. `trace-next --step N` advances
only the current checkpoint, after at least one second; no stale/double advance
can skip a checkpoint. The next step can be retrieved with `trace-status`.
No automatic advancement occurs during tracing. Abort resumes the remaining
original restore operations without pauses; poll until `aborted-restored` or
`restore-failed`. Other microphone mutation commands are rejected during tracing.
HTTP remains responsive; sensor scheduling continues independently.

Each checkpoint includes GPIO14 and GPIO21 hardware direction, enables, pulls,
raw IO_MUX/GPIO/output-matrix registers, all assigned input matrix signals,
I2S0 RX/PDM/master-slave/slot/clock registers and decoded fields, source and
divider details, driver role/mode/enabled state, configured sample rate/slots/
clock pins, and wrapper settings. The channel state is represented by public
API initialization/enabled fields plus the hardware RX_START bit; it does not
pretend to read the driver's inaccessible private state enum. Raw clock-source
selectors use the installed ESP32-S3 register definition (XTAL/PLL240/PLL160/external).
Snapshots are retained in a bounded 40-checkpoint log, with operation return values.
The HTTP log is streamed rather than building a second large copy in RAM.

HTTP: POST `/mic-restore-trace`, GET `/mic-restore-trace`,
POST `/mic-restore-trace-next?step=N`, POST `/mic-restore-trace-abort`.
Build/checks passed. Mock CLI routing/advance validation passed without robot
requests, and stripping the wrapper hooks reproduces upstream algorithms exactly.
Hardware measurements identified checkpoint 5 (`gpio_reset_pin(GPIO14)`) as the
first sustained rise to about 3 V: the reset enables the pull-up. Checkpoint 1
(disable diagnostic RX with the independent clock still running) briefly showed
variable 1.2–1.5 V, then fell to about 92 mV. No microphone restore fix is applied.

## Hold checkpoint 1 and count DATA activity

`helm vehicle-mic-clock Truck activity-start` runs the two comparison phases,
arms hardware pulse counters before RX is disabled, records a 100 ms baseline,
and advances only to checkpoint 1. It then holds indefinitely, with the continuous
2.048 MHz clock running and RX disabled. There is no automatic restoration.

`activity-status` returns both-edge DATA counts and rising-edge clock counts,
actual window durations, RX state, cumulative totals, and timestamps/counts
immediately before and after the RX-disable call. The first roughly five seconds
use 10 ms windows and are retained; subsequent windows use 100 ms intervals,
with the latest 128 retained. Counters run continuously between reads. Very long
runs clear counters before signed overflow; affected windows are marked, and
counts spanning those tiny counter-clear gaps are lower bounds.

PCNT input routing is attached through virtual channels and GPIO matrix taps,
avoiding the PCNT driver's physical-pin setup that enables a pull-up. GPIO14
configuration is logged before/after attachment and checked for unchanged pulls,
direction, and IO_MUX selection. Clock counts provide a control for continued
clock activity. DATA edges alone do not establish valid audio or PDM content.

`activity-stop` stops only logging/counters and leaves the held checkpoint and
clock intact. `trace-next --step 1` explicitly advances restoration;
`trace-abort` explicitly restores normal capture. This monitor requires the new
firmware build to be flashed before use.


Observed held-checkpoint-1 run: the first five seconds had zero DATA transitions
while clock counts matched 2.048 MHz. By about 30 seconds, 68 DATA edges had
occurred, with the last active window around 7.8 seconds after RX disable.
This did not reproduce sustained PDM activity or valid audio. The subsequent
concurrent speaker/LED firmware flash resets the diagnostic; the robot is no
longer held at this checkpoint after reboot.
