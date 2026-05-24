// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { paths } from "../paths.js";
import { STORAGE_LIMITS } from "../storage/limits.js";

/**
 * Download Helm's private Ollama binary from ollama.com.
 *
 * Linux x64 only for v0.1. macOS and Windows arrive in their own branch.
 *
 * The download is opt-in and one-time per Helm install. The privacy canary
 * acknowledges this destination explicitly.
 */

const LINUX_X64_URL = "https://ollama.com/download/ollama-linux-amd64.tar.zst";

export interface DownloadProgress {
  stage: "fetch" | "extract" | "verify" | "complete";
  message: string;
  bytesDownloaded?: number;
  totalBytes?: number;
}

export type ProgressCallback = (event: DownloadProgress) => void;

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

async function downloadToFile(
  url: string,
  destPath: string,
  onProgress?: ProgressCallback
): Promise<void> {
  ensureDir(dirname(destPath));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
  }
  const totalBytes = Number(res.headers.get("content-length")) || undefined;
  if (totalBytes && totalBytes > STORAGE_LIMITS.voiceAssetsBytes) {
    // Reusing the voice cap as a rough sanity ceiling for any single binary
    // download; if Ollama tarballs ever exceed 2 GB something is off.
    throw new Error(
      `Refusing download: ${totalBytes} bytes exceeds the single-asset ceiling.`
    );
  }
  if (!res.body) {
    throw new Error("Download failed: no response body.");
  }

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

function runCmd(
  cmd: string,
  args: string[],
  onProgress?: ProgressCallback,
  stage: DownloadProgress["stage"] = "extract"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (chunk) => {
      onProgress?.({
        stage,
        message: String(chunk).trim().slice(0, 200),
      });
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

/**
 * Download + extract Ollama for Linux x64. Other platforms throw NotImplemented.
 */
export async function downloadOllama(
  onProgress?: ProgressCallback
): Promise<{ installed: boolean; bytesUsed: number; binaryPath: string }> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `Ollama install for ${process.platform}-${process.arch} not implemented in this branch. Linux x64 only for v0.1.`
    );
  }

  const root = paths.ollamaRoot();
  ensureDir(root);

  const tarballPath = `${root}/ollama-linux-amd64.tar.zst`;

  onProgress?.({ stage: "fetch", message: `fetching ${LINUX_X64_URL}` });
  await downloadToFile(LINUX_X64_URL, tarballPath, onProgress);

  onProgress?.({ stage: "extract", message: "extracting tarball (zstd)" });
  await runCmd("tar", ["--zstd", "-xf", tarballPath, "-C", root], onProgress, "extract");

  onProgress?.({ stage: "verify", message: "verifying binary" });
  const binaryPath = paths.ollamaBin();
  if (!existsSync(binaryPath)) {
    throw new Error(
      `Extraction completed but binary not at expected path: ${binaryPath}`
    );
  }
  const stat = statSync(binaryPath);
  if (stat.size < 1_000_000) {
    throw new Error(`Binary at ${binaryPath} looks too small: ${stat.size} bytes`);
  }

  ensureDir(paths.ollamaModels());

  onProgress?.({ stage: "complete", message: "Ollama installed" });
  return { installed: true, bytesUsed: stat.size, binaryPath };
}

/**
 * Remove the entire Helm-private Ollama tree.
 */
export async function uninstallOllama(): Promise<{ removed: boolean; freedBytes: number }> {
  const { rmSync, existsSync: exists, statSync: stat } = await import("node:fs");
  const root = paths.ollamaRoot();
  if (!exists(root)) return { removed: false, freedBytes: 0 };

  // Measure before removing.
  const before = await import("node:fs").then((fs) => {
    function size(d: string): number {
      let t = 0;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) t += size(p);
        else if (e.isFile()) t += stat(p).size;
      }
      return t;
    }
    return size(root);
  });

  rmSync(root, { recursive: true, force: true });
  return { removed: true, freedBytes: before };
}
