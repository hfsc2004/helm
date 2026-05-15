/**
 * Introspectable command schema.
 *
 * The CLI registers each subcommand into this schema at startup. `helm describe`
 * emits the schema as JSON so agents can discover the entire surface without
 * scraping --help text.
 *
 * Both the CLI and the schema-emission share one source of truth: the
 * CommandDef objects below.
 */

export type ArgKind = "string" | "number" | "boolean";

export interface ArgDef {
  name: string;
  kind: ArgKind;
  required: boolean;
  description: string;
}

export interface FlagDef {
  name: string;
  short?: string;
  kind: ArgKind;
  default?: string | number | boolean;
  description: string;
}

export interface EventDef {
  /** Distinguishing value of the `event` field in the NDJSON stream. */
  event: string;
  description: string;
}

export interface CommandDef {
  name: string;
  summary: string;
  args: ArgDef[];
  flags: FlagDef[];
  streams: boolean;
  events: EventDef[];
  exitCodes: Record<number, string>;
}

export interface CliSchema {
  name: string;
  version: string;
  description: string;
  globalFlags: FlagDef[];
  commands: CommandDef[];
}

export const GLOBAL_FLAGS: FlagDef[] = [
  {
    name: "json",
    kind: "boolean",
    default: true,
    description: "Emit machine-readable JSON output (default).",
  },
  {
    name: "pretty",
    kind: "boolean",
    default: false,
    description: "Emit human-readable output instead of JSON.",
  },
  {
    name: "timeout",
    kind: "number",
    description: "Bound execution time in milliseconds. Streams stop when exceeded.",
  },
  {
    name: "trace-id",
    kind: "string",
    description: "Correlation ID for grouping related commands across invocations.",
  },
  {
    name: "dry-run",
    kind: "boolean",
    default: false,
    description: "Emit the plan but do not execute mutating actions.",
  },
];

export const COMMON_EXIT_CODES: Record<number, string> = {
  0: "success",
  1: "command-level failure (validation, vehicle rejected action)",
  2: "transport failure (vehicle unreachable)",
  3: "safety abort (deadman, STOP, or guard tripped)",
  64: "usage error (bad arguments)",
};
