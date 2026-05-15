import { readFileSync } from "node:fs";
import { join } from "node:path";

import { emit } from "../output.js";
import { register, all, type RuntimeCommand } from "../registry.js";
import {
  COMMON_EXIT_CODES,
  GLOBAL_FLAGS,
  type CliSchema,
} from "../../core/schema.js";

function readVersion(): string {
  const pkgPath = join(__dirname, "..", "..", "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

const command: RuntimeCommand = {
  def: {
    name: "describe",
    summary:
      "Emit the complete CLI schema (commands, args, flags, events, exit codes) as JSON.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    const schema: CliSchema = {
      name: "helm",
      version: readVersion(),
      description:
        "PSF Helm CLI: the natural-language helm for your robot — or your drone.",
      globalFlags: GLOBAL_FLAGS,
      commands: all().map((c) => c.def),
    };
    emit(schema);
    return 0;
  },
};

register(command);
export default command;
