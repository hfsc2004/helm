#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
/**
 * PSF Helm CLI entrypoint.
 *
 * Agent-first surface: structured output, NDJSON streams, distinct exit codes,
 * machine-introspectable schema via `helm describe`.
 */

import { log, fatal } from "./output.js";
import { get, all } from "./registry.js";

// Register all commands by importing them. Side-effect import is intentional;
// each module calls `register(...)` at load time.
import "./commands/version.js";
import "./commands/privacy.js";
import "./commands/describe.js";
import "./commands/voice.js";
import "./commands/hardware.js";
import "./commands/vehicle.js";
import "./commands/vehicle-camera.js";
import "./commands/vehicle-snapshot.js";
import "./commands/vehicle-audio.js";
import "./commands/vehicle-drive.js";
import "./commands/vehicle-wifi.js";
import "./commands/vehicle-flash-config.js";
import "./commands/ollama.js";
import "./commands/hf-token.js";
import "./commands/model.js";
import "./commands/drive.js";
import "./commands/serial.js";
import "./commands/wifi.js";
import "./commands/toolchain.js";
import "./commands/flash.js";

const USAGE = `helm <command> [args] [flags]

Run 'helm describe' for the full machine-readable schema.
Run 'helm version' to print the version.
`;

function parseArgs(argv: string[]): {
  command?: string;
  args: string[];
  flags: Record<string, string | boolean>;
} {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[token.slice(2)] = next;
          i++;
        } else {
          flags[token.slice(2)] = true;
        }
      }
    } else if (command === undefined) {
      command = token;
    } else {
      args.push(token);
    }
  }

  return { command, args, flags };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (!parsed.command || parsed.command === "help" || parsed.flags["help"] === true) {
    log(USAGE);
    log("Available commands:");
    for (const c of all()) {
      log(`  ${c.def.name.padEnd(12)} ${c.def.summary}`);
    }
    process.exit(0);
  }

  const cmd = get(parsed.command);
  if (!cmd) {
    fatal(`Unknown command: ${parsed.command}\n\n${USAGE}`, 64);
  }

  // Map positional args by their declared order in the command definition.
  const args: Record<string, string | number | boolean> = {};
  cmd.def.args.forEach((argDef, i) => {
    const value = parsed.args[i];
    if (value !== undefined) args[argDef.name] = value;
  });

  const exitCode = await cmd.run({ args, flags: parsed.flags });
  process.exit(exitCode);
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  fatal(`helm: ${msg}`, 1);
});
