import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import { paths } from "../../core/paths.js";
import { downloadModel } from "../../core/download/index.js";
import * as wrap from "../../core/llm/ollama/wrap.js";
import * as ollamaManager from "../../core/llm/ollama/manager.js";

function ensureStagingDir(): string {
  const dir = paths.modelStaging();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function filenameFromUrl(url: string): string {
  const cleaned = url.split("?")[0] ?? url;
  const tail = cleaned.split("/").pop() ?? "model.gguf";
  return tail || "model.gguf";
}

function modelNameFromFilename(filename: string): string {
  return filename
    .replace(/\.gguf$/i, "")
    .replace(/[^a-zA-Z0-9.-]+/g, "-")
    .toLowerCase();
}

const list: RuntimeCommand = {
  def: {
    name: "model-list",
    summary: "List models registered with Helm's private Ollama.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]!, 1: COMMON_EXIT_CODES[1]! },
  },
  async run() {
    try {
      const models = await wrap.listModels();
      emit({ models });
      return 0;
    } catch (err) {
      emit({
        error: err instanceof Error ? err.message : String(err),
        hint: "Is Helm's private Ollama running? Try `helm ollama-start`.",
      });
      return 1;
    }
  },
};

const download: RuntimeCommand = {
  def: {
    name: "model-download",
    summary:
      "Download a .gguf model from huggingface.co (or any direct URL) and register it with Helm's private Ollama.",
    args: [
      {
        name: "url",
        kind: "string",
        required: true,
        description: "Direct URL to the .gguf file.",
      },
    ],
    flags: [
      {
        name: "name",
        kind: "string",
        description: "Name to register the model under in Ollama. Derived from filename if omitted.",
      },
      {
        name: "force-cpu",
        kind: "boolean",
        default: false,
        description: "Pin this model to CPU inference.",
      },
    ],
    streams: true,
    events: [
      { event: "fetch", description: "Download progress." },
      { event: "verify", description: "Checksum verification." },
      { event: "wrap", description: "Ollama registration (blob upload + create)." },
      { event: "complete", description: "Model is ready to use." },
    ],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      2: COMMON_EXIT_CODES[2]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args, flags }) {
    const url = String(args["url"] ?? "").trim();
    if (!url) {
      emit({ error: "model-download requires <url>." });
      return 64;
    }
    if (!ollamaManager.isRunning()) {
      emit({
        error: "Helm's private Ollama is not running.",
        hint: "Run `helm ollama-start` first (and `helm ollama-install --confirm` if you haven't yet).",
      });
      return 1;
    }

    const filename = filenameFromUrl(url);
    const modelName = String(flags["name"] ?? modelNameFromFilename(filename)).trim();
    const destinationDir = ensureStagingDir();
    const filePath = join(destinationDir, filename);

    try {
      const result = await downloadModel({
        url,
        filename,
        destinationDir,
        progressCallback: (p) => {
          emit({ event: "fetch", ...p });
        },
      });
      if (!result.success || !result.filePath) {
        emit({ event: "error", error: result.error ?? "download failed" });
        return 2;
      }
      emit({ event: "verify", ok: true, sha256: result.sha256, bytes: result.bytes });

      const forceCpu = flags["force-cpu"] === true || flags["force-cpu"] === "true";
      const wrapResult = await wrap.wrapForOllama({
        ggufPath: filePath,
        modelName,
        forceCpu,
        onProgress: (e) => emit({ event: "wrap", ...e }),
      });

      const stat = statSync(filePath);
      emit({
        event: "complete",
        model: {
          name: wrapResult.modelName,
          mainDigest: wrapResult.mainDigest,
          hasVision: wrapResult.hasVision,
          stagedFile: filePath,
          bytes: stat.size,
        },
      });
      return 0;
    } catch (err) {
      emit({
        event: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return 1;
    }
  },
};

const remove: RuntimeCommand = {
  def: {
    name: "model-remove",
    summary: "Remove a model from Helm's private Ollama by name.",
    args: [
      {
        name: "name",
        kind: "string",
        required: true,
        description: "Model name as shown by `helm model-list`.",
      },
    ],
    flags: [],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args }) {
    const name = String(args["name"] ?? "").trim();
    if (!name) {
      emit({ error: "model-remove requires <name>." });
      return 64;
    }
    try {
      await wrap.removeModel(name);
      emit({ removed: true, name });
      return 0;
    } catch (err) {
      emit({
        error: err instanceof Error ? err.message : String(err),
      });
      return 1;
    }
  },
};

register(list);
register(download);
register(remove);
