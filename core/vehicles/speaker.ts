// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

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

export async function resolveSpeakerEndpoint(endpoint: URL): Promise<URL> {
  // Existing boards use diagnostics on 82. Updated boards receive audio on
  // their own core-0 HTTP task, leaving diagnostics and LEDs responsive.
  if (endpoint.port !== "82") return endpoint;
  const health = new URL("/health", endpoint); health.port = "83";
  try {
    const response = await fetch(health, { signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      const info = await response.json() as { ok?: boolean; service?: string };
      if (info.ok && info.service === "psf-speaker") {
        const dedicated = new URL(endpoint); dedicated.port = "83";
        return dedicated;
      }
    }
  } catch { /* Older firmware has no listener on 83; retain legacy playback. */ }
  return endpoint;
}

export async function playSpeakerFile(endpoint: URL, file: string): Promise<{ pcmBytes: number; result: unknown }> {
  const tempDir = mkdtempSync(join(tmpdir(), "helm-speaker-"));
  const pcmFile = join(tempDir, "audio.pcm");
  try {
    await decodeToPcm(file, pcmFile);
    const bytes = statSync(pcmFile).size;
    if (!bytes || bytes % 4 !== 0) throw new Error("Decoded PCM is empty or not stereo-frame aligned.");
    return { pcmBytes: bytes, result: await streamPcm(await resolveSpeakerEndpoint(endpoint), pcmFile, bytes) };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
