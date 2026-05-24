// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import { buildPrivacyPosture } from "../../core/privacy.js";
import { paths } from "../../core/paths.js";

function readVersion(): string {
  const pkgPath = join(__dirname, "..", "..", "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

const command: RuntimeCommand = {
  def: {
    name: "privacy",
    summary:
      "Emit the privacy posture (canary, outbound destinations, local data) as JSON.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    emit(
      buildPrivacyPosture({
        version: readVersion(),
        dataPath: paths.data,
      })
    );
    return 0;
  },
};

register(command);
export default command;
