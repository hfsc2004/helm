// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as registry from "../../core/vehicles/registry.js";

async function decodeToPcm(source: string, destination: string): Promise<void> {
  const ffmpeg = spawn("ffmpeg", [
    "-nostdin", "-v", "error", "-i", source,
    "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "2", "-",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let spawnError: Error | null = null;
  ffmpeg.on("error", (error) => { spawnError = error; });
  const completed = new Promise<number>((resolve) => {
    ffmpeg.once("close", (code) => resolve(code ?? 1));
  });
  ffmpeg.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString().slice(0, 2048); });
  try {
    await pipeline(ffmpeg.stdout, createWriteStream(destination));
  } catch (error) {
    ffmpeg.kill();
    throw error;
  }
  const exitCode = await completed;
  if (spawnError) throw spawnError;
  if (exitCode !== 0) throw new Error(`ffmpeg could not decode audio: ${stderr.trim() || `exit ${exitCode}`}`);
}

async function streamPcm(url: URL, pcmFile: string, bytes: number): Promise<unknown> {
  const boundary = `helm-speaker-${Date.now().toString(36)}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.pcm"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n"
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return await new Promise((resolve, reject) => {
    const req = request(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": header.length + bytes + footer.length,
      },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => {
        let parsed: unknown = body;
        try { parsed = JSON.parse(body); } catch { /* preserve raw error */ }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`speaker HTTP ${res.statusCode}: ${body}`));
        else resolve(parsed);
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("speaker upload timed out")));
    req.write(header);
    const pcm = createReadStream(pcmFile);
    pcm.on("error", (error) => req.destroy(error));
    pcm.on("end", () => req.end(footer));
    pcm.pipe(req, { end: false });
  });
}

register({
  def: {
    name: "vehicle-speaker-play",
    summary: "Decode an audio file locally and stream 16 kHz stereo PCM to a v1.3 sensor board speaker.",
    args: [
      { name: "id", kind: "string", required: true, description: "Vehicle id or name." },
      { name: "file", kind: "string", required: true, description: "Local MP3 or other ffmpeg-supported audio file." },
    ],
    flags: [
      { name: "base-url", kind: "string", description: "Sensor board diagnostics URL; defaults to camera host on port 82." },
    ],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      2: COMMON_EXIT_CODES[2]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args, flags }) {
    const id = String(args["id"] ?? "").trim();
    const file = String(args["file"] ?? "").trim();
    if (!id || !file) {
      emit({ error: "vehicle-speaker-play requires <id> <file>." });
      return 64;
    }
    const vehicle = registry.get(id) ?? registry.findByName(id);
    if (!vehicle || vehicle.sensorBoardRevision !== "1.3") {
      emit({ error: "A registered v1.3 sensor-board vehicle is required." });
      return 1;
    }
    if (!vehicle.camera && !flags["base-url"]) {
      emit({ error: "No sensor-board address: configure the vehicle camera or pass --base-url." });
      return 1;
    }
    let endpoint: URL;
    try {
      const base = new URL(String(flags["base-url"] ?? vehicle.camera!.baseUrl));
      if (base.protocol !== "http:") throw new Error("HTTP is required");
      if (!flags["base-url"]) base.port = "82";
      endpoint = new URL("/speaker-pcm", base);
      statSync(file);
    } catch (error) {
      emit({ error: error instanceof Error ? error.message : String(error) });
      return 1;
    }
    const tempDir = mkdtempSync(join(tmpdir(), "helm-speaker-"));
    const pcmFile = join(tempDir, "audio.pcm");
    try {
      await decodeToPcm(file, pcmFile);
      const bytes = statSync(pcmFile).size;
      if (!bytes || bytes % 4 !== 0) throw new Error("Decoded PCM is empty or not stereo-frame aligned.");
      const result = await streamPcm(endpoint, pcmFile, bytes);
      emit({ ok: true, file, pcmBytes: bytes, result });
      return 0;
    } catch (error) {
      emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return 2;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
} satisfies RuntimeCommand);
