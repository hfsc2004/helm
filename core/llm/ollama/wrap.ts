// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

import { HELM_OLLAMA_PORT } from "./env.js";

/**
 * Register a local .gguf file with Helm's private Ollama instance.
 *
 * The flow (matches Core-CE's launchModelInOllama path):
 *   1. Compute the SHA-256 of the .gguf.
 *   2. POST the file bytes to /api/blobs/sha256:<digest>. Ollama dedupes by
 *      digest, so repeated wraps of the same file are cheap.
 *   3. POST to /api/create with a synthesized Modelfile pointing at the
 *      blob digest. After this, `model` is a name Ollama can serve.
 *
 * The user never sees the blob digests. They just see "qwen2.5-vl-7b" or
 * whatever name we register.
 */

export interface WrapOptions {
  /** Path to the .gguf file on disk. */
  ggufPath: string;
  /** Name to register the model under in Ollama. */
  modelName: string;
  /** Optional path to a multimodal projector .gguf (for vision models). */
  projectorPath?: string;
  /** Force CPU inference for this model. */
  forceCpu?: boolean;
  /** Progress callback. */
  onProgress?: (event: WrapEvent) => void;
}

export interface WrapEvent {
  stage: "digest" | "blob-main" | "blob-projector" | "create" | "complete";
  message: string;
  bytesUploaded?: number;
  totalBytes?: number;
}

export interface WrapResult {
  modelName: string;
  mainDigest: string;
  projectorDigest?: string;
  hasVision: boolean;
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function uploadBlob(
  digest: string,
  filePath: string,
  totalBytes: number,
  onProgress?: WrapOptions["onProgress"],
  stage: WrapEvent["stage"] = "blob-main"
): Promise<void> {
  const url = `http://127.0.0.1:${HELM_OLLAMA_PORT}/api/blobs/sha256:${digest}`;
  let bytesUploaded = 0;

  // Build a stream that reports progress to the caller.
  const fileStream = createReadStream(filePath);
  const reader = new ReadableStream({
    start(controller) {
      fileStream.on("data", (chunk) => {
        bytesUploaded += chunk.length;
        onProgress?.({
          stage,
          message: "uploading blob",
          bytesUploaded,
          totalBytes,
        });
        controller.enqueue(chunk);
      });
      fileStream.on("end", () => controller.close());
      fileStream.on("error", (err) => controller.error(err));
    },
  });

  const res = await fetch(url, {
    method: "POST",
    body: reader as unknown as BodyInit,
    // @ts-expect-error Node's fetch requires this when sending a stream body.
    duplex: "half",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama blob upload failed (${res.status}): ${body || res.statusText}`);
  }
}

async function createModel(opts: {
  name: string;
  mainDigest: string;
  mainFilename: string;
  projectorDigest?: string;
  projectorFilename?: string;
  forceCpu?: boolean;
}): Promise<void> {
  const requestBody: Record<string, unknown> = {
    model: opts.name,
    files: { [opts.mainFilename]: opts.mainDigest },
  };
  if (opts.projectorDigest && opts.projectorFilename) {
    requestBody["adapters"] = { [opts.projectorFilename]: opts.projectorDigest };
  }
  if (opts.forceCpu) {
    requestBody["modelfile"] = `FROM @${opts.mainDigest}\nPARAMETER num_gpu 0`;
  }

  const url = `http://127.0.0.1:${HELM_OLLAMA_PORT}/api/create`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Ollama model creation failed (${res.status}): ${body || res.statusText}`
    );
  }

  // Drain the streaming create response and bail loudly on any error line.
  const text = await res.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { error?: string };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        throw new Error(`Ollama create stream error: ${parsed.error.trim()}`);
      }
    } catch {
      // Ignore non-JSON lines (Ollama mixes JSON and plain text on this endpoint).
    }
  }
}

export async function wrapForOllama(opts: WrapOptions): Promise<WrapResult> {
  const onProgress = opts.onProgress;
  const totalBytes = statSync(opts.ggufPath).size;

  onProgress?.({ stage: "digest", message: "computing SHA-256" });
  const mainDigest = await sha256OfFile(opts.ggufPath);

  onProgress?.({ stage: "blob-main", message: "uploading main blob", totalBytes });
  await uploadBlob(mainDigest, opts.ggufPath, totalBytes, onProgress, "blob-main");

  let projectorDigest: string | undefined;
  let projectorFilename: string | undefined;
  if (opts.projectorPath) {
    const projectorBytes = statSync(opts.projectorPath).size;
    onProgress?.({
      stage: "blob-projector",
      message: "uploading vision projector blob",
      totalBytes: projectorBytes,
    });
    projectorDigest = await sha256OfFile(opts.projectorPath);
    await uploadBlob(
      projectorDigest,
      opts.projectorPath,
      projectorBytes,
      onProgress,
      "blob-projector"
    );
    projectorFilename = opts.projectorPath.split("/").pop() ?? "mmproj.gguf";
  }

  onProgress?.({ stage: "create", message: "registering model with Ollama" });
  const mainFilename = opts.ggufPath.split("/").pop() ?? "model.gguf";
  await createModel({
    name: opts.modelName,
    mainDigest,
    mainFilename,
    projectorDigest,
    projectorFilename,
    forceCpu: opts.forceCpu,
  });

  onProgress?.({ stage: "complete", message: `registered as ${opts.modelName}` });
  return {
    modelName: opts.modelName,
    mainDigest,
    projectorDigest,
    hasVision: !!projectorDigest,
  };
}

/**
 * List models currently registered with Helm's private Ollama.
 */
export async function listModels(): Promise<
  Array<{ name: string; size: number; modified_at?: string }>
> {
  const url = `http://127.0.0.1:${HELM_OLLAMA_PORT}/api/tags`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Ollama list failed: HTTP ${res.status}`);
  }
  const parsed = (await res.json()) as {
    models?: Array<{ name: string; size: number; modified_at?: string }>;
  };
  return parsed.models ?? [];
}

/**
 * Remove a model from Helm's private Ollama.
 */
export async function removeModel(name: string): Promise<void> {
  const url = `http://127.0.0.1:${HELM_OLLAMA_PORT}/api/delete`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name }),
  });
  if (!res.ok) {
    throw new Error(`Ollama remove failed: HTTP ${res.status}`);
  }
}
