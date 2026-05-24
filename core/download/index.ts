// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
/**
 * Download subsystem — TypeScript surface over the verbatim Core-CE modules.
 *
 * The .js files in this directory are imported verbatim from PSF Core. They
 * handle HTTP/HTTPS + wget fallback, HF Bearer auth, SHA-256 checksumming,
 * multi-shard GGUF reassembly, and the HF REST API. Do not modify them.
 *
 * Helm uses these to download model files. The HF token (if present) lives
 * in the project's .env (see core/secrets.ts) and is attached as
 * `Authorization: Bearer <token>` only on requests to huggingface.co.
 */

import { getSecret } from "../secrets.js";

const downloadManager = require("./download-manager.js") as {
  downloadModel(opts: DownloadOptions): Promise<DownloadResult>;
  cancelDownload(id: string): boolean;
};

const huggingfaceApi = require("./huggingface-api.js") as {
  fetchModelInfo(modelId: string, opts?: { hfToken?: string }): Promise<unknown>;
  fetchConfig(repoUrl: string, opts?: { hfToken?: string }): Promise<unknown>;
  fetchFileInfo(url: string, opts?: { hfToken?: string }): Promise<unknown>;
};

export interface DownloadOptions {
  /** Direct URL to a .gguf (or a HF resolve URL). */
  url: string;
  /** Filename to save as. If omitted, derived from the URL. */
  filename?: string;
  /** Directory to download into. Helm sets this; callers usually don't. */
  destinationDir: string;
  /** Bearer token for gated downloads. Helm sources from .env automatically. */
  hfToken?: string;
  /** Expected SHA-256, if known. Verified post-download. */
  expectedSha256?: string;
  /** Progress callback. */
  progressCallback?: (progress: DownloadProgress) => void;
}

export interface DownloadProgress {
  stage: "fetch" | "verify" | "wrap" | "complete";
  bytesDownloaded?: number;
  totalBytes?: number;
  speed?: string;
  eta?: string;
  message?: string;
}

export interface DownloadResult {
  success: boolean;
  filePath?: string;
  sha256?: string;
  bytes?: number;
  error?: string;
}

export async function downloadModel(
  opts: DownloadOptions
): Promise<DownloadResult> {
  const token = opts.hfToken ?? getSecret("HF_TOKEN") ?? undefined;
  return downloadManager.downloadModel({ ...opts, hfToken: token });
}

export function cancelDownload(id: string): boolean {
  return downloadManager.cancelDownload(id);
}

export const hf = {
  fetchModelInfo: huggingfaceApi.fetchModelInfo,
  fetchConfig: huggingfaceApi.fetchConfig,
  fetchFileInfo: huggingfaceApi.fetchFileInfo,
};
