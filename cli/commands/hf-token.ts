import { createInterface } from "node:readline";

import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import { clearSecret, hasSecret, setSecret } from "../../core/secrets.js";

async function readFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    let buf = "";
    rl.on("line", (line) => {
      if (buf === "") buf = line;
    });
    rl.on("close", () => resolve(buf.trim()));
  });
}

const set: RuntimeCommand = {
  def: {
    name: "hf-token-set",
    summary:
      "Store the Hugging Face access token in .env. Token never appears on the command line or in logs.",
    args: [],
    flags: [
      {
        name: "from-stdin",
        kind: "boolean",
        default: false,
        description: "Read the token from stdin (recommended).",
      },
      {
        name: "from-env",
        kind: "string",
        description: "Copy the value of the named env var (e.g., --from-env HF_TOKEN).",
      },
    ],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]!, 64: COMMON_EXIT_CODES[64]! },
  },
  async run({ flags }) {
    let token: string | null = null;
    if (flags["from-stdin"] === true || flags["from-stdin"] === "true") {
      token = await readFromStdin();
    } else if (typeof flags["from-env"] === "string") {
      token = process.env[flags["from-env"]] ?? null;
    } else {
      emit({
        error:
          "hf-token-set requires --from-stdin or --from-env <NAME>. The token must not appear on the command line.",
      });
      return 64;
    }
    if (!token) {
      emit({ error: "no token provided." });
      return 64;
    }
    setSecret("HF_TOKEN", token);
    emit({ stored: true, length: token.length });
    return 0;
  },
};

const status: RuntimeCommand = {
  def: {
    name: "hf-token-status",
    summary: "Report whether an HF token is configured. Never emits the token itself.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    emit({ present: hasSecret("HF_TOKEN") });
    return 0;
  },
};

const clear: RuntimeCommand = {
  def: {
    name: "hf-token-clear",
    summary: "Remove the stored HF token from .env.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    const cleared = clearSecret("HF_TOKEN");
    emit({ cleared });
    return 0;
  },
};

register(set);
register(status);
register(clear);
