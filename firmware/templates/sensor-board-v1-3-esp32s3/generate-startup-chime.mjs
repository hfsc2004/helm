// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
// Regenerate the flash-resident boot sound from the original WAV.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2] ?? join(directory, "../../../PSF_Chime.wav"));
const destination = join(directory, "startup_chime.h");
const decoded = spawnSync("ffmpeg", [
  "-nostdin", "-v", "error", "-i", source,
  "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-",
], { maxBuffer: 1024 * 1024 });
if (decoded.status !== 0 || !decoded.stdout.length) {
  throw new Error(`Failed to decode startup chime: ${decoded.stderr?.toString() ?? decoded.error}`);
}
const pcm = decoded.stdout;
if (pcm.length % 2 !== 0) throw new Error("Startup PCM is not 16-bit aligned");
const lines = [];
for (let offset = 0; offset < pcm.length; offset += 12) {
  lines.push("  " + [...pcm.subarray(offset, offset + 12)]
    .map((value) => `0x${value.toString(16).padStart(2, "0")}`).join(", "));
}
writeFileSync(destination, [
  "#pragma once",
  "#include <Arduino.h>",
  "",
  "// PSF_Chime.wav converted to signed 16-bit, 16 kHz, mono PCM.",
  "// Boot playback applies 30% gain. Keep this asset in flash, not working RAM.",
  "static const uint8_t kStartupChimePcm[] PROGMEM = {",
  lines.join(",\n"),
  "};",
  "static constexpr size_t kStartupChimeBytes = sizeof(kStartupChimePcm);",
  "",
].join("\n"));
process.stdout.write(`Wrote ${pcm.length} PCM bytes to ${destination}\n`);
