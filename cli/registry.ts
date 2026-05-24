// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import type { CommandDef } from "../core/schema.js";

export interface RuntimeCommand {
  def: CommandDef;
  run(parsed: ParsedInvocation): Promise<number>;
}

export interface ParsedInvocation {
  args: Record<string, string | number | boolean>;
  flags: Record<string, string | number | boolean>;
}

const registry = new Map<string, RuntimeCommand>();

export function register(cmd: RuntimeCommand): void {
  if (registry.has(cmd.def.name)) {
    throw new Error(`Duplicate command registered: ${cmd.def.name}`);
  }
  registry.set(cmd.def.name, cmd);
}

export function get(name: string): RuntimeCommand | undefined {
  return registry.get(name);
}

export function all(): RuntimeCommand[] {
  return [...registry.values()];
}
