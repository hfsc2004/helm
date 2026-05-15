import { spawn } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { arduinoCliPaths, ensureArduinoCliDirs } from "./env.js";

/**
 * Download arduino-cli for the current platform.
 *
 * Linux x64 only for v0.1; macOS/Windows variants land in their own branch.
 *
 * Source: official downloads.arduino.cc CDN. The latest tarball is fetched
 * (Arduino-CLI publishes a "latest" alias). One outbound destination,
 * acknowledged in the privacy canary.
 */

const LINUX_X64_URL =
  "https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Linux_64bit.tar.gz";

export type DownloadStage = "fetch" | "extract" | "verify" | "complete";

export interface DownloadProgress {
  stage: DownloadStage;
  message: string;
  bytesDownloaded?: number;
  totalBytes?: number;
}

export type ProgressCallback = (event: DownloadProgress) => void;

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

async function downloadToFile(
  url: string,
  destPath: string,
  onProgress?: ProgressCallback
): Promise<void> {
  ensureDir(dirname(destPath));
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
  }
  const totalBytes = Number(res.headers.get("content-length")) || undefined;
  if (!res.body) throw new Error("Download failed: no response body.");

  const file = createWriteStream(destPath);
  let bytesDownloaded = 0;
  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    file.write(value);
    bytesDownloaded += value.byteLength;
    onProgress?.({
      stage: "fetch",
      message: "downloading",
      bytesDownloaded,
      totalBytes,
    });
  }
  await new Promise<void>((resolve, reject) => {
    file.end((err: unknown) => (err ? reject(err) : resolve()));
  });
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

export async function installArduinoCli(
  onProgress?: ProgressCallback
): Promise<{ installed: boolean; binaryPath: string; version?: string }> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `arduino-cli install for ${process.platform}-${process.arch} not implemented in this branch. Linux x64 only for v0.1.`
    );
  }

  ensureArduinoCliDirs();
  const root = arduinoCliPaths.root();
  const tarballPath = join(root, "arduino-cli_latest_Linux_64bit.tar.gz");

  onProgress?.({ stage: "fetch", message: `fetching ${LINUX_X64_URL}` });
  await downloadToFile(LINUX_X64_URL, tarballPath, onProgress);

  onProgress?.({ stage: "extract", message: "extracting tarball" });
  // Extract to a staging dir, then move just the arduino-cli binary into place.
  const stagingDir = join(root, ".staging");
  ensureDir(stagingDir);
  await runTar(["-xzf", tarballPath, "-C", stagingDir]);

  const stagedBin = join(stagingDir, "arduino-cli");
  const finalBin = arduinoCliPaths.bin();
  if (!existsSync(stagedBin)) {
    throw new Error(`Expected arduino-cli binary at ${stagedBin} after extract`);
  }
  renameSync(stagedBin, finalBin);
  chmodSync(finalBin, 0o755);

  onProgress?.({ stage: "verify", message: "verifying binary" });

  onProgress?.({ stage: "complete", message: "arduino-cli installed" });
  return { installed: true, binaryPath: finalBin };
}

export async function uninstallArduinoCli(): Promise<{
  removed: boolean;
  freedBytes: number;
}> {
  const fs = await import("node:fs");
  const root = arduinoCliPaths.root();
  if (!fs.existsSync(root)) return { removed: false, freedBytes: 0 };

  const measure = (d: string): number => {
    let t = 0;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) t += measure(p);
        else if (e.isFile()) t += fs.statSync(p).size;
      }
    } catch {
      // ignore
    }
    return t;
  };
  const before = measure(root);
  fs.rmSync(root, { recursive: true, force: true });
  return { removed: true, freedBytes: before };
}
