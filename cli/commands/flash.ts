// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import {
  flash,
  listTemplates,
  loadTemplate,
  renderSketch,
} from "../../core/firmware-flash/index.js";

const templates: RuntimeCommand = {
  def: {
    name: "flash-templates",
    summary:
      "List available sketch templates (ground-skidsteer-esp32, etc.). Includes the variable schema each one needs.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    emit({ templates: listTemplates() });
    return 0;
  },
};

const templateShow: RuntimeCommand = {
  def: {
    name: "flash-template-show",
    summary: "Show one template's manifest + the raw sketch source.",
    args: [
      {
        name: "id",
        kind: "string",
        required: true,
        description: "Template id (from flash-templates).",
      },
    ],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]!, 1: COMMON_EXIT_CODES[1]! },
  },
  async run({ args }) {
    const id = String(args["id"] ?? "").trim();
    const tmpl = loadTemplate(id);
    if (!tmpl) {
      emit({ error: `template not found: ${id}` });
      return 1;
    }
    emit({
      manifest: tmpl.manifest,
      sketchBytes: Buffer.byteLength(tmpl.sketchSource, "utf8"),
    });
    return 0;
  },
};

function parseVarFlags(
  flags: Record<string, string | number | boolean>
): Record<string, unknown> {
  // Vars can be passed as repeated --var key=value, but our parser collapses
  // repeated flags. So accept --var as a single string with semicolons OR a
  // comma-separated list, plus support --var.<key>=<value> directly.
  const out: Record<string, unknown> = {};

  // --var.key=value style
  for (const [k, v] of Object.entries(flags)) {
    if (k.startsWith("var.")) {
      out[k.slice(4)] = v;
    }
  }

  // --var "key=value[,key=value]" style
  if (typeof flags["var"] === "string") {
    for (const pair of flags["var"].split(",")) {
      const eq = pair.indexOf("=");
      if (eq > 0) {
        out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
  }
  return out;
}

const flashCmd: RuntimeCommand = {
  def: {
    name: "flash",
    summary:
      "Compile a sketch template with the given vars and upload it to a port. Streams compile and upload progress.",
    args: [
      {
        name: "port",
        kind: "string",
        required: true,
        description: "Serial port (e.g. /dev/ttyUSB0).",
      },
    ],
    flags: [
      {
        name: "template",
        kind: "string",
        description: "Template id (from flash-templates).",
      },
      {
        name: "var",
        kind: "string",
        description:
          "Comma-separated key=value pairs, e.g. --var wifi.ssid=MyNet,wifi.password=secret. Also accepts --var.<key>=<value>.",
      },
      {
        name: "dry-run",
        kind: "boolean",
        default: false,
        description: "Render the sketch but do not compile or upload.",
      },
      {
        name: "board",
        kind: "string",
        description: "Label this flash as targeting the drive or video board (advisory).",
      },
      {
        name: "fqbn",
        kind: "string",
        description: "Override the template's FQBN (rare; per-vehicle variant).",
      },
      {
        name: "build-property",
        kind: "string",
        description:
          "Comma-separated KEY=VALUE arduino-cli --build-property pairs (USB-CDC etc.).",
      },
      {
        name: "erase",
        kind: "boolean",
        default: false,
        description: "Pass --erase to arduino-cli upload before writing.",
      },
      {
        name: "capture-runtime-serial-ms",
        kind: "number",
        description:
          "After a successful upload, capture serial output for N ms. Useful for ESP32-S3 first-boot output.",
      },
      {
        name: "monitor-baud",
        kind: "number",
        default: 115200,
        description: "Baud rate for post-upload serial capture.",
      },
    ],
    streams: true,
    events: [
      { event: "prepare", description: "Loading template." },
      { event: "render", description: "Applying variables." },
      { event: "resolve-toolchain", description: "Finding arduino-cli." },
      { event: "core-install", description: "Installing the board core (one-time, slow)." },
      { event: "compile", description: "arduino-cli compile output." },
      { event: "upload", description: "arduino-cli upload output." },
      { event: "complete", description: "Flash finished." },
      { event: "error", description: "Non-recoverable failure." },
    ],
    exitCodes: {
      0: COMMON_EXIT_CODES[0]!,
      1: COMMON_EXIT_CODES[1]!,
      2: COMMON_EXIT_CODES[2]!,
      64: COMMON_EXIT_CODES[64]!,
    },
  },
  async run({ args, flags }) {
    const port = String(args["port"] ?? "").trim();
    const templateId = String(flags["template"] ?? "").trim();
    if (!port || !templateId) {
      emit({ error: "flash requires <port> and --template <id>." });
      return 64;
    }
    const vars = parseVarFlags(flags);
    const dryRun = flags["dry-run"] === true || flags["dry-run"] === "true";
    const boardRaw = String(flags["board"] ?? "").trim().toLowerCase();
    const board =
      boardRaw === "drive" || boardRaw === "video" ? boardRaw : undefined;
    const fqbnOverride = String(flags["fqbn"] ?? "").trim() || undefined;
    const buildProps = String(flags["build-property"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const eraseBeforeUpload =
      flags["erase"] === true || flags["erase"] === "true";
    const captureMs = Number(flags["capture-runtime-serial-ms"] ?? 0);
    const baud = Number(flags["monitor-baud"] ?? 115200);

    const result = await flash(
      {
        port,
        templateId,
        vars,
        dryRun,
        board,
        fqbnOverride,
        buildProperties: buildProps.length > 0 ? buildProps : undefined,
        eraseBeforeUpload,
        captureRuntimeSerialMs: Number.isFinite(captureMs) && captureMs > 0 ? captureMs : undefined,
        monitorBaudRate: Number.isFinite(baud) ? baud : undefined,
      },
      (event) => emit(event)
    );
    return result.ok ? 0 : 1;
  },
};

const renderOnly: RuntimeCommand = {
  def: {
    name: "flash-render",
    summary: "Render a template with vars and print the resulting sketch source. No flashing.",
    args: [],
    flags: [
      {
        name: "template",
        kind: "string",
        description: "Template id.",
      },
      {
        name: "var",
        kind: "string",
        description: "Comma-separated key=value pairs (see helm flash --var).",
      },
    ],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]!, 1: COMMON_EXIT_CODES[1]!, 64: COMMON_EXIT_CODES[64]! },
  },
  async run({ flags }) {
    const templateId = String(flags["template"] ?? "").trim();
    if (!templateId) {
      emit({ error: "flash-render requires --template <id>." });
      return 64;
    }
    const tmpl = loadTemplate(templateId);
    if (!tmpl) {
      emit({ error: `template not found: ${templateId}` });
      return 1;
    }
    const vars = parseVarFlags(flags);
    const rendered = renderSketch(tmpl, vars);
    if (!rendered.ok) {
      emit({ ok: false, errors: rendered.errors });
      return 1;
    }
    emit({
      ok: true,
      resolved: rendered.resolved,
      sketchBytes: Buffer.byteLength(rendered.sketch, "utf8"),
      sketch: rendered.sketch,
    });
    return 0;
  },
};

register(templates);
register(templateShow);
register(flashCmd);
register(renderOnly);
