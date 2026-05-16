# ESP32 Mic Sidecar — STARTER (UNTESTED)

A minimal Arduino sketch that turns an ESP32 + INMP441 I2S microphone into a roving-mic sidecar that PSF Helm's `<AudioFeed>` component can play in the desktop UI.

## Wire format

- 16 kHz, mono, signed 16-bit little-endian PCM
- HTTP chunked transfer over `Content-Type: audio/L16;rate=16000;channels=1`
- `GET /audio` — chunked, indefinite
- `GET /health` — one-shot JSON

## Pin map (INMP441 → ESP32)

| INMP441 | ESP32 |
|---|---|
| VDD | 3.3V |
| GND | GND |
| SD  | GPIO 32 (DATA_IN) |
| SCK | GPIO 33 (BIT_CLOCK) |
| WS  | GPIO 25 (WORD_SELECT) |
| L/R | GND (left channel only) |

## Status

**Not yet bench-tested.** The I2S configuration, pin assignments, and Arduino HTTP chunking pattern are right in principle, but each line should be verified against your specific board + Arduino-ESP32 core version before relying on this in production.

Likely things to check / tweak when you flash this for real:

- The INMP441 returns sample data with quirks depending on the bits-per-sample mode you select — some boards/cores need a `>>16` shift on the 32-bit reads to get a usable 16-bit signal. If the audio plays but is silent or maxed-out white noise, that's the first thing to look at.
- Some Arduino-ESP32 versions deprecate `i2s_driver_install` in favor of the newer `I2S` class. The sketch uses the legacy driver because it's still supported and well-documented.
- Browser `<audio>` may not play `audio/L16` directly on all platforms. If Chromium-in-Electron rejects the stream, we'll need to wrap the PCM in a streaming WAV header instead — small change, easy to verify once we have hardware.

## Templatize when proven

When this works, promote it to `firmware/templates/esp32-mic-sidecar/` with `template.json` declaring `wifi.ssid`, `wifi.password`, and (optional) `i2s.sampleRate` as variables.
