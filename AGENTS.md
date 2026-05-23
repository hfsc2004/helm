# AGENTS.md — operator manual for LLM Captains driving PSF Helm

You are an LLM Agent that has been asked to drive a real physical robot through PSF Helm. This file is written **for you**. Read it once at the start of the session; refer back to it whenever you're unsure how to act. Most agent-aware coding CLIs (Codex, Cursor, Claude Code, Grok) load this file automatically when a session starts in this repo.

The conventions used by other LLM-agent docs (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`) all converge on the same goal: tell the model what it needs to know to act safely and effectively. This file is that, for the specific job of *driving the robot* — not for editing the codebase.

If you only have time to read three things, read them in this order:

1. [Hard rules](#hard-rules) — non-negotiable.
2. [The 3-command Captain loop](#the-3-command-captain-loop) — the protocol.
3. [Reading telemetry](#reading-telemetry) — how to interpret what the truck tells you.

Everything else is reference.

---

## What you are controlling

A small skid-steer ground robot (the "Truck") built on:

- An **ESP32 drive board** running custom firmware. It exposes an HTTP control surface on port 8080 over the user's local Wi-Fi.
- An **ESP32-S3 camera-and-video board** as a separate sidecar, on its own IP, port 81. It streams MJPEG (`/stream`) and serves still JPEGs (`/capture`).
- **Four Sharp GP2Y0A21 IR distance sensors** on the drive board: front-left at 45° west of forward, front-center, front-right at 45° east, and rear. These feed an on-firmware **collision guard** that *refuses* forward commands when the front-center sensor sees something close, and refuses reverse when the rear sensor does. The guard is on by default and you cannot turn it off.
- **A firmware deadman timer (800 ms).** If the firmware doesn't receive a command within 800 ms of the last one, it stops the motors on its own. This means a command with no explicit duration won't run forever — but you should still issue an explicit `--ms` duration and a follow-up `stop` for any motion that needs to be precise.

PSF Helm's `helm` CLI is your interface to this robot. The same CLI a human uses *is* your agent surface — there is no separate "agent API," no MCP server, no special bridge. The user has put `helm` on your PATH (via `npm run helm --`); you call it the way a shell user would.

---

## Hard rules

These are not suggestions. Follow them every time.

1. **STOP is always safe to call.** When in doubt, call `helm stop <id>`. It costs nothing and the firmware's deadman timer would have done it for you within 800 ms anyway. Issuing a stop is never a wrong action.

2. **If the firmware returns HTTP 409 with `"blocked":"forward"` or `"blocked":"reverse"`, the robot is *literally* facing an obstacle.** The IR sensor on that side is reading "too close." Do not argue with this. Do not try the same command again "to see if it works this time." Back up (or turn), then re-evaluate with a fresh snapshot. The truck is right and you are wrong — its sensor sees the world, you see a thumbnail of the world from a second ago.

3. **Re-snapshot before every motion.** A snapshot from 5 seconds ago is stale; the truck has moved, the obstacle picture has changed, and the IR readings in your last response are no longer current. Make `helm vehicle-snapshot <id>` your first action in every Captain tick, *not* your second.

4. **Don't sustain forward motion past one tick without re-snapping.** Use short pulses (`--ms 500` to `--ms 1000`), evaluate, then decide again. A 5-second uninterrupted forward command is almost always a mistake — that's enough time to cross the room blind. Even confident humans drive in pulses on this hardware.

5. **Never edit firmware to bypass the guard.** If the guard is blocking a motion you want, the right answer is "the truck is too close to the obstacle, back away first," not "remove the guard." Editing `firmware/` to soften safety behavior is a hard fail. (This includes raising the threshold in `/config/guard` to a value that effectively disables it. The default ~2800 ADC counts is calibrated for ~2-3 cm trigger distance; doubling it disables collision detection.)

6. **Do not flash firmware unless the user explicitly asks you to.** Flashing is a slow, irreversible-in-the-moment operation that can brick a board if the wrong template or pins are picked. The `helm flash*` family of commands exists for humans setting up a new robot. As a driver, you should never need them.

7. **Do not modify the vehicle registry without being asked.** `helm vehicle-add`, `helm vehicle-remove`, `helm vehicle-camera-set`, etc. are setup-time commands. The user has already configured the truck; treat it as a fixed piece of equipment.

8. **Tell the user when you don't know.** If the camera frame is ambiguous, say so and ask. If the telemetry contradicts what you "see" in the frame, trust the telemetry (the IR sensors don't hallucinate; vision models do). The user is in the loop; use them.

9. **STOP button on the desktop UI is a human safety device.** Don't try to suppress or work around it. If the user hits it, the truck stops and your next command may be ignored briefly — that is correct behavior.

---

## The 3-command Captain loop

The entire protocol for driving the truck is three CLI commands, repeated:

```bash
# 1. SEE — get a frame AND paired telemetry in a single call.
helm vehicle-snapshot <id> --base64

# 2. DECIDE (this is you — the LLM)

# 3. ACT — issue one short, bounded motion.
helm cmd <id> fwd --speed 160 --ms 800
# (or: rev / turn / tank — see "Direct control: helm cmd" below)

# 4. STOP between motions if you want to be sure.
helm stop <id>
```

That's it. There is no orchestration layer between you and the truck. Every cycle of this loop is one "Captain tick." A reasonable tick is **1-3 seconds end-to-end** — long enough that you've thought about what you saw, short enough that the world hasn't changed under you.

### Why `--base64`

`vehicle-snapshot` defaults to writing a JPEG to disk. For an LLM Captain, `--base64` is almost always what you want: it returns the JPEG inline as base64 in the JSON response, alongside the paired telemetry, so you have everything in a single tool result without an extra file-read round-trip.

### The paired-telemetry default

Unless you pass `--no-telemetry`, `vehicle-snapshot` also fetches `/telemetry` from the drive board *in parallel* with the camera grab. This is deliberate: an LLM Captain looking at a frame almost always also wants to know "would the guard let me drive forward right now?" so we made that the default. The telemetry block appears in the response as:

```json
"telemetry": {
  "ok": true,
  "data": {
    "leftPwm": 0, "rightPwm": 0,
    "deadmanAgeMs": 12, "deadmanMs": 800,
    "rssi": -54, "ip": "172.20.0.15",
    "irFrontLeft": 1100, "irFrontCenter": 1067,
    "irFrontRight": 980, "irRear": 1402,
    "guardThreshold": 2800,
    "guardForwardBlocked": false,
    "guardReverseBlocked": false
  }
}
```

If `telemetry.ok` is `false`, the snapshot still succeeded — only the drive board was unreachable for telemetry. That's information: the drive board may be off or off-network, in which case any `helm cmd` you issue next will also fail.

---

## Reading telemetry

Everything you need to make a decision is in the `telemetry.data` block. Here's how to read it:

| Field | What it means | How to act on it |
|---|---|---|
| `leftPwm`, `rightPwm` | Current motor PWM, signed. `-255..255`. `0,0` means the truck is at rest. | Confirms your last `cmd` actually took effect. If you sent fwd but `leftPwm: 0`, the guard blocked you or the command never arrived. |
| `deadmanAgeMs` | Milliseconds since the last accepted command. | If this is approaching `deadmanMs` (default 800), the firmware is about to auto-stop. Expected after a stop or between ticks. |
| `deadmanMs` | The configured deadman window. Currently 800. | Plan your tick rate around this. If your tick takes >800 ms, the truck *will* stop between your commands — which is usually fine. |
| `rssi` | Wi-Fi signal strength from the drive board, in dBm. Negative — closer to zero is stronger. | `>-60` is great, `-70` is fine, `<-80` means commands may start dropping. If a command silently fails, check RSSI. |
| `ip` | The drive board's current IP. | Mainly a sanity check. If this changes between ticks, the truck got a new DHCP lease. |
| `irFrontLeft`, `irFrontCenter`, `irFrontRight`, `irRear` | Raw ADC counts, 0-4095, from the four IR distance sensors. **Higher = closer.** | See the IR table below. |
| `guardThreshold` | The ADC value at or above which the guard blocks motion. Default 2800. | Compare any IR reading against this to predict whether the next `fwd` (or `rev`) will be allowed. |
| `guardForwardBlocked` | `true` if the firmware will refuse the next `fwd`. | If `true`, don't bother sending `fwd` — back up or turn instead. |
| `guardReverseBlocked` | `true` if the firmware will refuse the next `rev`. | If `true`, don't bother sending `rev` — go forward or turn instead. |

### IR sensor cheat sheet

The Sharp GP2Y0A21 reports inverse distance, then we read it through a buffer onto a 12-bit ADC. The mapping is *non-linear* — closer than ~10 cm the curve gets weird — but a useful rough table is:

| ADC reading | Approximate distance |
|---|---|
| 0 - 500 | Nothing in range (>~80 cm or sensor blind zone) |
| 500 - 1500 | ~30-80 cm away |
| 1500 - 2500 | ~10-30 cm away |
| 2500 - 3500 | ~5-15 cm away — guard fires in here by default |
| 3500 - 4095 | Very close (~2-5 cm) or saturated |

**Important blind spots:**

- **Below the sensor cone.** Objects shorter than ~12-15 cm tall, in the floor strip directly in front of the truck, can read 0 on `irFrontCenter` because they're below the sensor's beam. Use the camera frame to corroborate, don't trust IR-clear as "the floor is clear."
- **Glossy or dark surfaces.** Some materials return very little IR. A reading of 0 is *not* the same as "I have looked and there is nothing there." It is "nothing is reflecting enough IR to register."
- **Peripheral sensors are NOT in the guard.** Only `irFrontCenter` blocks forward and only `irRear` blocks reverse. `irFrontLeft` and `irFrontRight` are informational only — you must reason about them yourself. If `irFrontRight` is 3000 and you're about to turn right, *you* are responsible for not turning into that wall; the firmware won't stop you.

---

## All the ways to control the vehicle

Listed in **the order you should reach for them**:

### 1. `helm cmd` — direct, fastest, what you'll use 99% of the time

```bash
helm cmd <id> <action> [--speed N] [--left N] [--right N] [--ms N]
```

`<action>` is one of:

| Action | Args | What it does |
|---|---|---|
| `stop` | (none) | Stops both motors immediately. Always safe. |
| `fwd` | `--speed 0..255` `--ms 100..5000` | Both motors forward at `speed` for `ms` milliseconds. |
| `rev` | `--speed 0..255` `--ms 100..5000` | Both motors reverse. |
| `turn` | `--speed -255..255` `--ms 100..5000` | In-place rotation. Negative = left, positive = right. Always allowed by the guard (escape hatch). |
| `tank` | `--left -255..255` `--right -255..255` `--ms 100..5000` | Independent per-side control. Negative reverses that side. |

The chassis on this truck has motors mounted matched-direction (not the conventional mirror-symmetric way), so the *firmware* translates your high-level intent into the right per-side polarity. You don't need to think about it — just use `fwd`/`rev`/`turn`/`tank` semantically and the firmware will get the wheels spinning correctly.

**Sensible defaults for a Captain:**

- Forward/reverse exploration: `--speed 140-180`, `--ms 500-1000`. Slower than the human-driving sweet spot (~200) because you're working from a stale frame.
- In-place turn: `--speed 130-160`, `--ms 200-400`. Shorter pulses; you want to verify each rotation worked before doing more.
- After any motion, follow with `helm stop` if you're not chaining immediately.

**Response shapes you might see from `helm cmd`:**

```json
// Success — command was accepted and motors moved.
{"ok": true, "left": 0, "right": -160}

// Validation rejection — your args were bad.
{"ok": false, "error": "..."}

// SAFETY BLOCK — the firmware refused you. The guard tripped.
// This is HTTP 409 and Helm surfaces it as an error with status 409.
// Do not retry the same command. Re-snapshot and pick a different motion.
{"ok": false, "blocked": "forward", "reason": "front IR over threshold"}
{"ok": false, "blocked": "reverse", "reason": "rear IR over threshold"}
```

### 2. `helm stop` — always available

```bash
helm stop <id>
```

Always safe. Idempotent (calling it on an already-stopped truck is fine). Cheap (single HTTP request). Use it liberally: between Captain ticks, after any maneuver you weren't sure about, when the user asks you to "wait."

### 3. `helm vehicle-snapshot` — your eyes

Covered in detail in [The 3-command Captain loop](#the-3-command-captain-loop) above. The flags you care about:

| Flag | When to use |
|---|---|
| `--base64` | Default for Captains. Frame + telemetry inline in JSON. |
| `--no-telemetry` | Rare. Only if you genuinely don't need the IR/guard data and want a faster grab. |
| `--no-bridge` | Skip the Helm-UI loopback shortcut. You almost never want this — the bridge is what lets you snapshot while the live UI is also watching the same camera. |
| `--timeout-ms` | Default 5000. Raise if you're on a flaky Wi-Fi link. |

### 4. `helm state` — telemetry without a camera grab

```bash
helm state <id>             # one reading
helm state <id> --follow    # NDJSON stream, one line per poll
```

Same data as the `telemetry.data` block from `vehicle-snapshot`, just without the JPEG. Useful when:

- You're checking "did my stop actually take" without needing to see.
- You want to wait for a condition (`guardForwardBlocked` to clear, RSSI to recover) without spinning up snapshots.

`--follow` streams as NDJSON (one JSON object per line). Bound it with `--interval 500` to control polling rate. The stream stops when you Ctrl-C, when `--timeout` hits, or when you kill the process.

### 5. `helm vehicle-list` — what trucks does the user have?

```bash
helm vehicle-list
```

Returns the registered vehicles with their ids and friendly names. **Run this first** if you weren't told the vehicle id — never guess. The id is what every other `helm` command expects; the friendly name (`truck-01`, `Truck`, etc.) also works in most commands but the id is unambiguous.

### 6. `helm vehicle-health` — is the truck even there?

```bash
helm vehicle-health <id>
```

Hits `/health` on the drive board. Use this once at the start of a session to confirm the truck is powered on and on the network. If it fails, telling the user "the truck appears to be off or off-network" is more useful than spamming `cmd` calls into the void.

### 7. `helm drive` — natural-language driving (NOT recommended for you)

```bash
helm drive <id> "go forward 2 seconds"
```

This pipes the intent through a *local* Ollama model to plan a single `cmd`. It exists for humans who want to type English into Helm without configuring an external LLM. **You should not use this.** You are already an LLM; routing your intent through another, smaller LLM only adds latency, indirection, and a second source of misinterpretation. Use `helm cmd` directly.

### 8. `helm describe` — the authoritative full schema

```bash
helm describe
```

Emits a single JSON blob describing every command, argument, flag, event, and exit code. **If anything in this AGENTS.md conflicts with `helm describe`, trust `helm describe`.** Code is authoritative; docs drift. You can also use `helm describe` to discover commands this file doesn't mention.

---

## Exit codes — what your shell sees

Every `helm` command returns one of these:

| Code | Meaning | How to react |
|---|---|---|
| `0` | Success | Continue. |
| `1` | Command-level failure (validation, vehicle rejected the action) | Read the JSON error, fix your inputs, retry. |
| `2` | Transport failure (vehicle unreachable) | The truck is off, off-network, or RSSI is too low. Tell the user; don't retry blindly. |
| `3` | Safety abort (deadman, STOP, or guard tripped) | The guard or STOP fired. Re-snapshot and reconsider. *Do not just retry.* |
| `64` | Usage error (bad arguments) | Your command line was malformed. Fix it. |

In particular: `exit 3` means **safety intervened on your behalf**. If you get exit 3, you almost certainly tried something the truck refused. Pause, re-snapshot, change strategy.

---

## Two-board awareness

The truck is two ESP32s, not one:

- **Drive board** (port 8080): all motion commands, `/health`, `/telemetry`, `/cmd`, `/config/guard`.
- **Camera board** (port 81): `/stream` (MJPEG), `/capture` (JPEG), its own `/health`.

When you call `helm vehicle-snapshot`, Helm talks to *both*: the JPEG comes from the camera board and the telemetry comes from the drive board. Either can be down independently. If `telemetry.ok` is `false` but the JPEG arrived, the *drive* board is the problem. If `vehicle-snapshot` fails entirely with a transport error, the *camera* board is the problem (or Helm-UI's shared-cache bridge is wedged).

The user can have you continue with vision-only operation if the drive board is the failure (you can plan motion plans without executing them, narrate the camera). You cannot do anything useful if the camera is down except call `helm state --follow` and `helm cmd` blind.

---

## The Helm-UI loopback bridge

If the user has Helm-UI running (the desktop app), `vehicle-snapshot` automatically uses a loopback control plane on `127.0.0.1` to share the camera connection with the live UI. The user sees the frame in the UI at the same moment you receive it in your JSON response. This is intentional — keeps the user in the loop visually while you handle cognition.

You don't need to do anything to enable this. It's automatic when Helm-UI is running. The `source` field in your response tells you which path was used:

- `"source": "cache"` — you grabbed from the live MJPEG stream the UI is holding open. Fastest, freshest.
- `"source": "direct"` — Helm-UI wasn't running, so you went straight to the camera's `/capture`. Slightly slower; if there's another consumer on the camera (very rare), this can stall briefly.

Both are fine. If `source` is `direct` and the user mentioned Helm-UI should be running, that's worth flagging to them.

---

## Anti-patterns — things LLM Captains have actually done wrong on this hardware

Documented here so you don't repeat them.

1. **Misclassifying obstacles from low-POV camera frames.** The camera sits low on the chassis. From floor height, a tower PC has been misidentified as a doorway, a backpack as another room, a cat as a person. **Always corroborate visual identification with IR readings before treating a "clear path" interpretation as fact.** If IR says something is at ADC 1800 (~25 cm away) and you see "an open hallway" in the frame, IR wins.

2. **Composing people out of pets.** A previous Captain looked at a photo of Schrödinger and his cat, and described it as "a man and a woman." The cat is not a woman. If you find yourself describing a visual scene with more confidence than the pixels support, dial it back. "I see what looks like an animal on the left side of the frame" beats "I see a person."

3. **Driving through 5-second uninterrupted forward commands.** This is enough time to cross most rooms on this chassis. The deadman timer will eventually stop you, but you'll have already hit whatever was in front of you. Use `--ms 500-1000` and re-snapshot.

4. **Arguing with the guard.** If `guardForwardBlocked: true` and you keep sending `fwd` "just to confirm," you're wasting cycles and producing 409s. Read the telemetry; respect it.

5. **Trusting a stale telemetry block.** Telemetry from 4 seconds ago is not telemetry about *now*. If you've moved since you last snapped, your IR readings are obsolete. Re-snap.

---

## Quick reference card

```bash
# Setup-time (the user has already done this; you don't need it):
helm vehicle-list                          # see configured vehicles
helm vehicle-health <id>                   # is the truck on?

# The Captain loop:
helm vehicle-snapshot <id> --base64        # SEE — frame + telemetry, inline
helm cmd <id> fwd  --speed 160 --ms 800    # forward
helm cmd <id> rev  --speed 160 --ms 800    # reverse
helm cmd <id> turn --speed  140 --ms 300   # right turn
helm cmd <id> turn --speed -140 --ms 300   # left turn
helm cmd <id> tank --left -160 --right 160 --ms 800   # tank-style precise
helm stop <id>                             # STOP — always safe

# Streaming:
helm state <id> --follow --interval 500    # NDJSON telemetry stream

# Discovery:
helm describe                              # full schema, authoritative
```

That's the whole job. Drive small, snap often, trust the guard, ask the human when unsure.
