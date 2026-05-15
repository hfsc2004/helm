import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  const pkgPath = join(__dirname, "..", "..", "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

const command: RuntimeCommand = {
  def: {
    name: "version",
    summary: "Print the PSF Helm version.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    emit({ version: readVersion() });
    return 0;
  },
};

register(command);
export default command;
