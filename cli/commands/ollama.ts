// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import * as manager from "../../core/llm/ollama/manager.js";
import { downloadOllama, uninstallOllama } from "../../core/binaries/ollama-download.js";

const status: RuntimeCommand = {
  def: {
    name: "ollama-status",
    summary:
      "Report Helm's private Ollama state. Helm never touches the system Ollama on 11434.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    emit({ ...(await manager.status()) });
    return 0;
  },
};

const install: RuntimeCommand = {
  def: {
    name: "ollama-install",
    summary:
      "Download Helm's private Ollama binary from ollama.com. Opt-in network call; one-time.",
    args: [],
    flags: [
      {
        name: "confirm",
        kind: "boolean",
        default: false,
        description: "Required. Downloads from ollama.com.",
      },
    ],
    streams: true,
    events: [
      { event: "fetch", description: "Tarball download progress." },
      { event: "extract", description: "Tarball extraction." },
      { event: "verify", description: "Binary verification." },
      { event: "complete", description: "Install complete." },
    ],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ flags }) {
    if (flags["confirm"] !== true) {
      emit({
        error:
          "ollama-install is a network operation. Re-run with --confirm to download from ollama.com.",
      });
      return 64;
    }
    try {
      const result = await downloadOllama((event) => {
        emit({ event: event.stage, ...event });
      });
      emit({ event: "complete", result });
      return 0;
    } catch (err) {
      emit({
        event: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return 1;
    }
  },
};

const uninstall: RuntimeCommand = {
  def: {
    name: "ollama-uninstall",
    summary:
      "Remove Helm's private Ollama (binary + libraries + models). Reinstallable.",
    args: [],
    flags: [
      {
        name: "confirm",
        kind: "boolean",
        default: false,
        description: "Required. Removes all Helm-private Ollama files.",
      },
    ],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]!, 64: COMMON_EXIT_CODES[64]! },
  },
  async run({ flags }) {
    if (flags["confirm"] !== true) {
      const s = await manager.status();
      emit({
        error: "ollama-uninstall removes files. Re-run with --confirm.",
        wouldFreeBytes: s.bytesUsed,
      });
      return 64;
    }
    if (manager.isRunning()) {
      await manager.stop();
    }
    const result = await uninstallOllama();
    emit(result);
    return 0;
  },
};

const start: RuntimeCommand = {
  def: {
    name: "ollama-start",
    summary: "Start Helm's private Ollama instance on its private port.",
    args: [],
    flags: [
      {
        name: "force-cpu",
        kind: "boolean",
        default: false,
        description: "Disable GPU acceleration for this Ollama instance.",
      },
    ],
    streams: false,
    events: [],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      3: COMMON_EXIT_CODES[3]!,
    },
  },
  async run({ flags }) {
    try {
      const ref = await manager.start({
        forceCpu: flags["force-cpu"] === true || flags["force-cpu"] === "true",
      });
      emit({
        started: true,
        pid: ref.pid,
        port: ref.port,
        sessionId: ref.sessionId,
      });
      return 0;
    } catch (err) {
      emit({
        started: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return 1;
    }
  },
};

const stop: RuntimeCommand = {
  def: {
    name: "ollama-stop",
    summary: "Stop Helm's private Ollama. Never touches the system Ollama.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    const stopped = await manager.stop();
    emit({ stopped });
    return 0;
  },
};

register(status);
register(install);
register(uninstall);
register(start);
register(stop);
